/**
 * src/routes/inventory.js
 * Admin inventory: stock overview, not-selling report, stock adjustments and
 * the movement ledger. Mounted for admin + staff; cost figures are admin-only.
 *
 *   GET  /api/admin/inventory/stock                 every variant with stock, sales and status
 *   GET  /api/admin/inventory/not-selling?days=     in stock, no sales in 30|60|90 days
 *   POST /api/admin/inventory/adjust                record stock in / return / correction
 *   GET  /api/admin/inventory/movements?sku=&limit= stock ledger, newest first
 *
 * Order lines are matched to variants with lib/variantMatch.js (variantId →
 * SKU → productId + type + size → name + type + size), because older
 * storefront orders were saved without a SKU or productId.
 */

import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { Order, PLACED } from '../models/Order.js'
import { Product } from '../models/Product.js'
import { StockMovement } from '../models/StockMovement.js'
import { User } from '../models/User.js'
import { buildVariantIndex } from '../lib/variantMatch.js'

export const inventoryRouter = Router()

const DAY = 24 * 60 * 60 * 1000
const PERIODS = [30, 60, 90]
const VELOCITY_DAYS = 30   // window for "sold" and days-of-cover on the stock overview

const PRODUCT_FIELDS =
  'name brand images isActive variants._id variants.sku variants.type variants.sizeMl variants.stock variants.reserved variants.reorderLevel variants.costPrice'

const available  = (v) => Math.max(0, (v.stock ?? 0) - (v.reserved ?? 0))

/**
 * Per-variant sales: last sale date (all time) and units sold since `since`.
 * Loads all non-cancelled orders — fine at this store's size.
 */
async function salesByVariant(products, since) {
  const orders = await Order.find({ ...PLACED, status: { $ne: 'cancelled' } })
    .select('createdAt items.variantId items.sku items.productId items.name items.variantType items.sizeMl items.quantity')
    .lean()

  const match    = buildVariantIndex(products)
  const lastSold = new Map()   // variantId → Date
  const sold     = new Map()   // variantId → units since `since`

  for (const o of orders) {
    for (const item of o.items) {
      const id = match(item)?.variant._id.toString()
      if (!id) continue
      if (!lastSold.has(id) || o.createdAt > lastSold.get(id)) lastSold.set(id, o.createdAt)
      if (o.createdAt >= since) sold.set(id, (sold.get(id) ?? 0) + item.quantity)
    }
  }
  return { lastSold, sold }
}

/** Shared fields for a variant row */
function baseRow(p, v) {
  return {
    productId: p._id.toString(),
    variantId: v._id.toString(),
    name:      p.name,
    brand:     p.brand ?? null,
    image:     p.images?.[0]?.url ?? null,
    sku:       v.sku,
    type:      v.type,
    sizeMl:    v.sizeMl,
  }
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.sizeMl - b.sizeMl

// ─── Stock overview ───────────────────────────────────────────────────────────

/**
 * GET /api/admin/inventory/stock
 * Every variant of active products: stock, reserved, available, reorder level,
 * status (out | low | ok), units sold in the last 30 days, days of cover
 * (available ÷ average daily sales; null when nothing sold) and, for admins,
 * cost and stock value.
 */
inventoryRouter.get('/stock', async (req, res) => {
  try {
    const isAdmin  = req.user.role === 'admin'
    const now      = Date.now()
    const products = await Product.find({ isActive: true }).select(PRODUCT_FIELDS).lean()
    const { lastSold, sold } = await salesByVariant(products, new Date(now - VELOCITY_DAYS * DAY))

    const rows = []
    for (const p of products) {
      for (const v of p.variants) {
        const avail        = available(v)
        const reorderLevel = v.reorderLevel ?? 3
        const sold30       = sold.get(v._id.toString()) ?? 0
        const perDay       = sold30 / VELOCITY_DAYS
        const last         = lastSold.get(v._id.toString()) ?? null
        rows.push({
          ...baseRow(p, v),
          stock:        v.stock ?? 0,
          reserved:     v.reserved ?? 0,
          available:    avail,
          reorderLevel,
          status:       avail === 0 ? 'out' : avail <= reorderLevel ? 'low' : 'ok',
          sold30,
          daysOfCover:  perDay > 0 ? Math.floor(avail / perDay) : null,
          lastSoldAt:   last,
          costPrice:    isAdmin ? v.costPrice ?? 0 : null,
          stockValue:   isAdmin ? (v.costPrice ?? 0) * avail : null,   // paise, available units
        })
      }
    }
    rows.sort(byName)

    const count = (s) => rows.filter(r => r.status === s).length
    res.json({
      totals: {
        variants:   rows.length,
        available:  rows.reduce((s, r) => s + r.available, 0),
        reserved:   rows.reduce((s, r) => s + r.reserved, 0),
        low:        count('low'),
        out:        count('out'),
        stockValue: isAdmin ? rows.reduce((s, r) => s + r.stockValue, 0) : null,
      },
      items: rows,
    })
  } catch (err) {
    console.error('[admin/inventory] stock:', err)
    res.status(500).json({ message: 'Failed to load stock.' })
  }
})

// ─── Not selling ──────────────────────────────────────────────────────────────

/**
 * GET /api/admin/inventory/not-selling?days=30|60|90&limit=
 * Active variants with stock available that sold no units in the period.
 * Sorted by money tied up (admins) or longest without a sale (staff).
 */
inventoryRouter.get('/not-selling', async (req, res) => {
  try {
    const days    = PERIODS.includes(Number(req.query.days)) ? Number(req.query.days) : 30
    const limit   = Math.min(200, Math.max(1, parseInt(req.query.limit ?? '200', 10) || 200))
    const isAdmin = req.user.role === 'admin'
    const now     = Date.now()

    const products = await Product.find({ isActive: true }).select(PRODUCT_FIELDS).lean()
    const { lastSold, sold } = await salesByVariant(products, new Date(now - days * DAY))

    const rows = []
    for (const p of products) {
      for (const v of p.variants) {
        const avail = available(v)
        const id    = v._id.toString()
        if (avail === 0 || sold.get(id)) continue

        const last = lastSold.get(id) ?? null
        rows.push({
          ...baseRow(p, v),
          available:         avail,
          lastSoldAt:        last,
          daysSinceLastSale: last ? Math.floor((now - last.getTime()) / DAY) : null,   // null = never sold
          stockValue:        isAdmin ? (v.costPrice ?? 0) * avail : null,             // paise
        })
      }
    }

    // Never sold first, then longest since last sale; ties by name so the order is stable
    const staleness = (r) => (r.daysSinceLastSale == null ? Number.MAX_SAFE_INTEGER : r.daysSinceLastSale)
    rows.sort(isAdmin
      ? (a, b) => b.stockValue - a.stockValue || staleness(b) - staleness(a) || byName(a, b)
      : (a, b) => staleness(b) - staleness(a) || byName(a, b))

    res.json({
      days,
      totals: {
        variants:   rows.length,
        units:      rows.reduce((s, r) => s + r.available, 0),
        stockValue: isAdmin ? rows.reduce((s, r) => s + r.stockValue, 0) : null,
      },
      items: rows.slice(0, limit),
    })
  } catch (err) {
    console.error('[admin/inventory] not-selling:', err)
    res.status(500).json({ message: 'Failed to load inventory report.' })
  }
})

// ─── Adjust stock ─────────────────────────────────────────────────────────────

const ADJUST_REASONS = ['purchase', 'returned', 'adjustment']

const adjustSchema = z.object({
  sku:    z.string().trim().min(1).transform(s => s.toUpperCase()),
  delta:  z.number().int().refine(n => n !== 0, 'Quantity cannot be 0.'),
  reason: z.enum(ADJUST_REASONS),
  note:   z.string().trim().max(500).optional().default(''),
}).superRefine((d, ctx) => {
  if (d.reason !== 'adjustment' && d.delta < 0) {
    ctx.addIssue({ path: ['delta'], code: 'custom', message: 'Stock received and returns add stock — use a correction to remove it.' })
  }
  if (d.reason === 'adjustment' && !d.note) {
    ctx.addIssue({ path: ['note'], code: 'custom', message: 'Add a note explaining the correction.' })
  }
})

/**
 * POST /api/admin/inventory/adjust  { sku, delta, reason, note }
 * reason: purchase (stock received) | returned (customer return) | adjustment
 * (correction, ± with a note). Stock can't drop below what's reserved for open
 * orders. Updates the variant and writes a StockMovement ledger entry.
 */
inventoryRouter.post('/adjust', async (req, res) => {
  try {
    const parsed = adjustSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Validation error.', errors: parsed.error.flatten().fieldErrors })
    }
    const { sku, delta, reason, note } = parsed.data

    const product = await Product.findOne({ 'variants.sku': sku }).select('variants._id variants.sku variants.stock variants.reserved').lean()
    const variant = product?.variants.find(v => v.sku === sku)
    if (!variant) return res.status(404).json({ message: `No product with SKU ${sku}.` })

    const current  = variant.stock ?? 0
    const reserved = variant.reserved ?? 0
    const next     = current + delta
    if (next < reserved) {
      return res.status(400).json({
        message: reserved > 0
          ? `Stock can't go below ${reserved} — that many are reserved for open orders.`
          : `Only ${current} in stock — can't remove ${-delta}.`,
        errors: { delta: ['Too many removed.'] },
      })
    }

    // Only apply if stock hasn't changed since we read it (no lost updates)
    const result = await Product.updateOne(
      { _id: product._id, variants: { $elemMatch: { _id: variant._id, stock: current } } },
      { $set: { 'variants.$.stock': next } },
    )
    if (result.modifiedCount === 0) {
      return res.status(409).json({ message: 'Stock changed while you were editing — refresh and try again.' })
    }

    const movement = await StockMovement.create({
      sku, productId: product._id, delta, field: 'stock', reason,
      note: note || undefined, actor: req.user._id.toString(),
    })

    res.status(201).json({ sku, stock: next, reserved, available: next - reserved, movementId: movement._id })
  } catch (err) {
    console.error('[admin/inventory] adjust:', err)
    res.status(500).json({ message: 'Failed to adjust stock.' })
  }
})

// ─── Movement ledger ──────────────────────────────────────────────────────────

/**
 * GET /api/admin/inventory/movements?sku=&limit=&before=
 * Stock ledger, newest first. `before` (ISO date) pages backwards.
 */
inventoryRouter.get('/movements', async (req, res) => {
  try {
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50))
    const filter = {}
    if (req.query.sku) filter.sku = String(req.query.sku).trim().toUpperCase()
    if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) filter.createdAt = { $lt: new Date(req.query.before) }

    const docs = await StockMovement.find(filter).sort({ createdAt: -1 }).limit(limit + 1).lean()
    const page = docs.slice(0, limit)

    // Names for products and actors
    const productIds = [...new Set(page.map(m => m.productId?.toString()).filter(Boolean))]
    const actorIds   = [...new Set(page.map(m => m.actor).filter(a => mongoose.isValidObjectId(a)))]
    const [products, users] = await Promise.all([
      Product.find({ _id: { $in: productIds } }).select('name variants.sku variants.type variants.sizeMl').lean(),
      User.find({ _id: { $in: actorIds } }).select('name email').lean(),
    ])
    const productById = new Map(products.map(p => [p._id.toString(), p]))
    const userById    = new Map(users.map(u => [u._id.toString(), u.name || u.email]))

    res.json({
      items: page.map(m => {
        const p = productById.get(m.productId?.toString())
        const v = p?.variants.find(x => x.sku === m.sku)
        return {
          _id:       m._id,
          sku:       m.sku,
          name:      p?.name ?? null,
          type:      v?.type ?? null,
          sizeMl:    v?.sizeMl ?? null,
          delta:     m.delta,
          field:     m.field,
          reason:    m.reason,
          note:      m.note ?? null,
          actor:     m.actor === 'system' ? 'System' : userById.get(m.actor) ?? 'Unknown',
          createdAt: m.createdAt,
        }
      }),
      nextBefore: docs.length > limit ? page.at(-1).createdAt : null,
    })
  } catch (err) {
    console.error('[admin/inventory] movements:', err)
    res.status(500).json({ message: 'Failed to load stock history.' })
  }
})
