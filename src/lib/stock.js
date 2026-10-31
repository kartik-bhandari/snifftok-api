/**
 * src/lib/stock.js
 * Keeps product stock in step with orders.
 *
 *   order placed                   reserved += qty   (available drops at once)
 *   pending  → confirmed/onwards   stock −= qty, reserved −= qty
 *   pending  → cancelled           reserved −= qty
 *   confirmed/onwards → cancelled  stock += qty
 *   cancelled → pending            reserved += qty   (only if still available)
 *   cancelled → confirmed/onwards  stock −= qty      (only if still available)
 *
 * Order.stockState records which of these applies. Orders placed before stock
 * tracking have no stockState and are never touched.
 *
 * Each variant is updated with an optimistic check (only if stock/reserved are
 * unchanged since read, retried a few times). Multi-line changes are undone if
 * a later line fails. Every change writes a StockMovement.
 */

import { Product } from '../models/Product.js'
import { StockMovement } from '../models/StockMovement.js'
import { loadVariantIndex, variantLabel } from './variantMatch.js'

export class StockError extends Error {
  constructor(message, status = 409) {
    super(message)
    this.status = status
  }
}

const RETRIES = 5

/**
 * Apply a stock/reserved change to one variant.
 * requireAvailable: refuse if stock − reserved would go negative.
 * Returns the deltas actually applied (reserved never goes below 0).
 */
async function applyChange(line, { stock = 0, reserved = 0 }, { requireAvailable = false } = {}) {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const product = await Product.findOne({ _id: line.productId, 'variants._id': line.variantId })
      .select({ name: 1, 'variants.$': 1 })
      .lean()
    const v = product?.variants?.[0]
    if (!v) throw new StockError(`${line.label} is no longer available.`, 400)

    const curStock    = v.stock ?? 0
    const curReserved = v.reserved ?? 0
    const nextStock    = curStock + stock
    const nextReserved = Math.max(0, curReserved + reserved)

    if (nextStock < 0 || (requireAvailable && nextStock - nextReserved < 0)) {
      const left = Math.max(0, curStock - curReserved)
      throw new StockError(left === 0
        ? `${line.label} is out of stock.`
        : `Only ${left} of ${line.label} left.`)
    }

    const result = await Product.updateOne(
      { _id: line.productId, variants: { $elemMatch: { _id: line.variantId, stock: curStock, reserved: v.reserved ?? null } } },
      { $set: { 'variants.$.stock': nextStock, 'variants.$.reserved': nextReserved } },
    )
    if (result.modifiedCount === 1) {
      return { stockDelta: nextStock - curStock, reservedDelta: nextReserved - curReserved }
    }
  }
  throw new StockError('Stock is changing too fast — please try again.')
}

/**
 * Apply `change(line)` to every line; undo applied lines if one fails.
 * Writes StockMovements for whatever changed.
 */
async function applyAll(lines, change, opts, { reason, orderId, actor }) {
  const done = []
  try {
    for (const line of lines) done.push([line, await applyChange(line, change(line), opts)])
  } catch (err) {
    for (const [line, d] of done.reverse()) {
      await applyChange(line, { stock: -d.stockDelta, reserved: -d.reservedDelta }).catch(e =>
        console.error('[stock] rollback failed for', line.sku, e.message))
    }
    throw err
  }

  const movements = []
  for (const [line, d] of done) {
    const base = { sku: line.sku, productId: line.productId, reason, orderId, actor }
    if (d.stockDelta)    movements.push({ ...base, field: 'stock', delta: d.stockDelta })
    if (d.reservedDelta) movements.push({ ...base, field: 'reserved', delta: d.reservedDelta })
  }
  if (movements.length) await StockMovement.insertMany(movements)
}

/**
 * Match order items to variants (storefront payload). Returns the items with
 * productId/variantId/sku filled in, plus per-variant lines for reserving.
 * Throws StockError(400) if an item doesn't match any product.
 */
export async function resolveOrderItems(items) {
  const match = await loadVariantIndex(
    items,
    'name brand isActive variants._id variants.sku variants.type variants.sizeMl variants.costPrice variants.minProfit variants.pricing',
  )
  return items.map(item => {
    const hit = match(item)
    if (!hit || hit.product.isActive === false) {
      throw new StockError(`${item.name ?? 'An item in your bag'} is no longer available.`, 400)
    }
    return {
      ...item,
      // Canonical product details — never trust the client for these
      productId:   hit.product._id,
      variantId:   hit.variant._id,
      sku:         hit.variant.sku,
      name:        hit.product.name,
      brand:       hit.product.brand ?? item.brand,
      variantType: hit.variant.type,
      sizeMl:      hit.variant.sizeMl,
      unitCost:    hit.variant.costPrice,
      // Used by lib/checkout.js to price the line server-side
      _variant:    hit.variant,
    }
  })
}

/** One line per variant, quantities summed */
function linesFromItems(items) {
  const byVariant = new Map()
  for (const i of items) {
    if (!i.variantId) continue
    const key = String(i.variantId)
    const line = byVariant.get(key) ?? {
      productId: i.productId,
      variantId: i.variantId,
      sku:       i.sku,
      label:     variantLabel(i.name, { sizeMl: i.sizeMl, type: i.variantType }),
      qty:       0,
    }
    line.qty += i.quantity
    byVariant.set(key, line)
  }
  return [...byVariant.values()]
}

/**
 * Reserve stock for a new order's (resolved) items. Pass the order's _id
 * (generated before saving) so the movements point at it. Throws StockError
 * if anything isn't available — nothing is reserved in that case.
 */
export async function reserveForOrder(items, { orderId, actor = 'system', channel = 'web' } = {}) {
  const lines = linesFromItems(items)
  await applyAll(lines, l => ({ reserved: l.qty }), { requireAvailable: true }, {
    reason: channel === 'whatsapp' ? 'wa_order_reserved' : 'web_order_reserved', orderId, actor,
  })
}

/** Undo a reservation made by reserveForOrder (the order failed to save) */
export async function cancelReservation(items, { orderId } = {}) {
  const lines = linesFromItems(items)
  await applyAll(lines, l => ({ reserved: -l.qty }), {}, { reason: 'reservation_released', orderId, actor: 'system' })
}

/**
 * Stock side of an order status change. Returns the new stockState (or the
 * old one if nothing changes). Throws StockError if reopening a cancelled
 * order needs stock that's no longer there.
 */
export async function stockForStatusChange(order, newStatus, actor) {
  const state = order.stockState
  if (!state) return undefined   // placed before stock tracking — leave stock alone

  const cancelled = newStatus === 'cancelled'
  const pending   = newStatus === 'pending'
  const lines     = linesFromItems(order.items)
  const ctx       = { orderId: order._id, actor }

  if (state === 'reserved') {
    if (cancelled) {
      await applyAll(lines, l => ({ reserved: -l.qty }), {}, { ...ctx, reason: 'reservation_released' })
      return 'released'
    }
    if (pending) return state
    await applyAll(lines, l => ({ stock: -l.qty, reserved: -l.qty }), {}, { ...ctx, reason: 'order_confirmed' })
    return 'deducted'
  }

  if (state === 'deducted') {
    if (!cancelled) return state
    await applyAll(lines, l => ({ stock: l.qty }), {}, { ...ctx, reason: 'cancelled' })
    return 'restocked'
  }

  // released / restocked — the order is cancelled and holds no stock
  if (cancelled) return state
  if (pending) {
    await applyAll(lines, l => ({ reserved: l.qty }), { requireAvailable: true }, { ...ctx, reason: 'web_order_reserved' })
    return 'reserved'
  }
  await applyAll(lines, l => ({ stock: -l.qty }), { requireAvailable: true }, { ...ctx, reason: 'order_confirmed' })
  return 'deducted'
}
