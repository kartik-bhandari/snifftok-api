/**
 * src/lib/orderCosts.js
 * Look up variant cost prices by SKU — used to snapshot unitCost on new orders
 * and as a fallback for older orders that were saved without one.
 *
 * MONEY: paise.
 */

import { Product } from '../models/Product.js'

/**
 * @param {string[]} skus
 * @returns {Promise<Map<string, number>>} SKU (uppercase) → costPrice in paise
 */
export async function getUnitCosts(skus) {
  const wanted = [...new Set(skus.filter(Boolean).map(s => s.toUpperCase()))]
  const costs  = new Map()
  if (!wanted.length) return costs

  const products = await Product.find({ 'variants.sku': { $in: wanted } })
    .select('variants.sku variants.costPrice')
    .lean()

  for (const p of products) {
    for (const v of p.variants) {
      if (wanted.includes(v.sku)) costs.set(v.sku, v.costPrice)
    }
  }
  return costs
}
