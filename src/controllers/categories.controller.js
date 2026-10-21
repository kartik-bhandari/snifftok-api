/**
 * src/controllers/categories.controller.js
 */

import { z } from 'zod'
import { Category } from '../models/Category.js'

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
})

export async function listCategories(req, res) {
  try {
    const cats = await Category.find({ isActive: true }).sort({ name: 1 }).lean()
    res.json({ categories: cats })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to load categories.' })
  }
}

export async function createCategory(req, res) {
  try {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ message: 'Validation error.', errors: parsed.error.flatten().fieldErrors })
    }
    const cat = await Category.create({ name: parsed.data.name })
    res.status(201).json({ category: cat })
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'A category with this name already exists.' })
    }
    console.error(err)
    res.status(500).json({ message: 'Failed to create category.' })
  }
}
