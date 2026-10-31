/**
 * src/lib/checkout.js
 * Server-side order pricing — the browser's prices and totals are ignored.
 *
 * Charges exactly what the storefront shows:
 *   line price = the variant's stored catalogue price (pricing.unitPriceExclDelivery,
 *                recomputed from cost + min profit if missing)
 *   shipping   = delivery slabs × deliveryPerSlab (1 slab per bottle, 1 per
 *                `testersPerSlab` decants — see lib/pricing.js)
 *   total      = Σ line totals + shipping
 *
 * MONEY: paise.
 */

import { loadSettings } from '../models/Settings.js'
import { shippingCost, unitPriceExclDelivery } from './pricing.js'

export const MAX_QTY_PER_LINE = 20

/**
 * @param {Array} items  output of resolveOrderItems (each has `_variant`)
 * @returns {{ items, subtotal, shippingAmount, total }}
 */
export async function priceOrder(items) {
  const settings = await loadSettings()

  const priced = items.map(({ _variant: v, ...item }) => {
    const unitPrice = v.pricing?.unitPriceExclDelivery
      ?? unitPriceExclDelivery({ costPrice: v.costPrice, minProfit: v.minProfit }, settings)
    return { ...item, unitPrice, lineTotal: unitPrice * item.quantity }
  })

  const subtotal       = priced.reduce((s, i) => s + i.lineTotal, 0)
  const shippingAmount = shippingCost(priced.map(i => ({ type: i.variantType, qty: i.quantity })), settings)

  return { items: priced, subtotal, shippingAmount, total: subtotal + shippingAmount }
}
