/**
 * src/lib/variantMatch.js
 * Match order lines to product variants. Lines are matched by, in order:
 *   1. variantId (orders placed with stock tracking)
 *   2. SKU
 *   3. productId + variant type + size
 *   4. product name + variant type + size   (older storefront carts sent neither)
 */

import mongoose from 'mongoose'
import { Product } from '../models/Product.js'

const variantKey = (type, sizeMl) => `${type}:${Number(sizeMl)}`
const nameKey    = (name) => String(name ?? '').trim().toLowerCase()

/**
 * @param {Array} products  lean products with variants (_id, sku, type, sizeMl, …)
 * @returns {(item) => { product, variant } | undefined}
 */
export function buildVariantIndex(products) {
  const byVariantId = new Map()
  const bySku       = new Map()
  const byId        = new Map()   // productId → Map(variantKey → hit)
  const byName      = new Map()   // lowercased name → Map(variantKey → hit)

  for (const product of products) {
    const variants = new Map()
    for (const variant of product.variants ?? []) {
      const hit = { product, variant }
      byVariantId.set(variant._id.toString(), hit)
      bySku.set(variant.sku, hit)
      variants.set(variantKey(variant.type, variant.sizeMl), hit)
    }
    byId.set(product._id.toString(), variants)
    // Names aren't unique — first match wins, only used as a last resort
    if (!byName.has(nameKey(product.name))) byName.set(nameKey(product.name), variants)
  }

  return (item) => {
    if (item.variantId) {
      const hit = byVariantId.get(String(item.variantId))
      if (hit) return hit
    }
    if (item.sku) {
      const hit = bySku.get(String(item.sku).toUpperCase())
      if (hit) return hit
    }
    const vk = variantKey(item.variantType, item.sizeMl)
    return byId.get(String(item.productId))?.get(vk) ?? byName.get(nameKey(item.name))?.get(vk)
  }
}

/** Load just the products these lines could refer to, and index them */
export async function loadVariantIndex(items, select = 'name variants') {
  const skus = new Set(), ids = new Set(), names = new Set()
  for (const i of items) {
    if (i.sku) skus.add(String(i.sku).toUpperCase())
    if (i.productId && mongoose.isValidObjectId(i.productId)) ids.add(String(i.productId))
    if (i.name) names.add(String(i.name).trim())
  }
  const or = []
  if (skus.size)  or.push({ 'variants.sku': { $in: [...skus] } })
  if (ids.size)   or.push({ _id: { $in: [...ids] } })
  if (names.size) or.push({ name: { $in: [...names].map(n => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) } })

  const products = or.length ? await Product.find({ $or: or }).select(select).lean() : []
  return buildVariantIndex(products)
}

/** "Oud Royale (50ml bottle)" */
export function variantLabel(name, variant) {
  return `${name} (${variant.sizeMl}ml ${variant.type === 'tester' ? 'decant' : 'bottle'})`
}
