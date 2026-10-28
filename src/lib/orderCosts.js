/**
 * src/lib/orderCosts.js
 * Look up variant cost prices for order lines — used to snapshot unitCost on
 * new orders and as a fallback for older orders saved without one.
 *
 * Lines are matched to a variant by, in order:
 *   1. SKU
 *   2. productId + variant type + size
 *   3. product name + variant type + size   (older storefront carts sent neither)
 *
 * MONEY: paise.
 */

import mongoose from 'mongoose'
import { Product } from '../models/Product.js'

const variantKey = (type, sizeMl) => `${type}:${Number(sizeMl)}`
const nameKey    = (name) => String(name ?? '').trim().toLowerCase()

/**
 * @param {Array<{ sku?: string, productId?: any, name?: string, variantType?: string, sizeMl?: number }>} items
 * @returns {Promise<(item) => number | undefined>} costOf(item) → costPrice in paise
 */
export async function getCostResolver(items) {
  const skus  = new Set()
  const ids   = new Set()
  const names = new Set()

  for (const i of items) {
    if (i.sku) skus.add(String(i.sku).toUpperCase())
    if (i.productId && mongoose.isValidObjectId(i.productId)) ids.add(String(i.productId))
    if (i.name) names.add(nameKey(i.name))
  }

  const or = []
  if (skus.size)  or.push({ 'variants.sku': { $in: [...skus] } })
  if (ids.size)   or.push({ _id: { $in: [...ids] } })
  if (names.size) or.push({ name: { $in: [...names].map(n => new RegExp(`^${escapeRegex(n)}$`, 'i')) } })

  const bySku  = new Map()
  const byId   = new Map()   // productId → Map(variantKey → cost)
  const byName = new Map()   // lowercased name → Map(variantKey → cost)

  if (or.length) {
    const products = await Product.find({ $or: or })
      .select('name variants.sku variants.type variants.sizeMl variants.costPrice')
      .lean()

    for (const p of products) {
      const variants = new Map()
      for (const v of p.variants) {
        bySku.set(v.sku, v.costPrice)
        variants.set(variantKey(v.type, v.sizeMl), v.costPrice)
      }
      byId.set(p._id.toString(), variants)
      // Names aren't unique — first match wins, only used as a last resort
      if (!byName.has(nameKey(p.name))) byName.set(nameKey(p.name), variants)
    }
  }

  return (item) => {
    if (item.sku) {
      const cost = bySku.get(String(item.sku).toUpperCase())
      if (cost != null) return cost
    }
    const vk = variantKey(item.variantType, item.sizeMl)
    return byId.get(String(item.productId))?.get(vk)
      ?? byName.get(nameKey(item.name))?.get(vk)
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
