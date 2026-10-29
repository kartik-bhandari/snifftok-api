/**
 * src/controllers/categories.controller.js
 * Categories are the 5 fixed scent families (src/data/scentFamilies.js),
 * managed by `npm run seed:categories` — there is no create endpoint.
 */

import { Category } from '../models/Category.js'

export async function listCategories(req, res) {
  try {
    const cats = await Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean()
    res.json({ categories: cats })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to load categories.' })
  }
}

/** True if `id` is an active category — used to validate product writes */
export async function isActiveCategory(id) {
  if (!id) return false
  return !!(await Category.exists({ _id: id, isActive: true }))
}
