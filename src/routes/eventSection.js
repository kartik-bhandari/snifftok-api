/**
 * src/routes/eventSection.js
 * Special event / offer section on the storefront home page.
 *
 *   Admin (admin role):  GET /api/admin/settings/event-section
 *                        PUT /api/admin/settings/event-section
 *   Public:              GET /api/storefront/event-section
 */

import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { EventSection, EVENT_SECTION_MAX_PRODUCTS, loadEventSection } from '../models/EventSection.js'
import { Product } from '../models/Product.js'
import { toPublic } from './storefront.js'

const objectId = z.string().refine(id => mongoose.isValidObjectId(id), 'Invalid product id.')

const updateSchema = z.object({
  enabled:    z.boolean(),
  title:      z.string().trim().max(60),
  subtitle:   z.string().trim().max(140).default(''),
  productIds: z.array(objectId).max(EVENT_SECTION_MAX_PRODUCTS, `Choose at most ${EVENT_SECTION_MAX_PRODUCTS} products.`),
}).superRefine((d, ctx) => {
  // Turning it on needs something to show
  if (d.enabled && !d.title) ctx.addIssue({ path: ['title'], code: 'custom', message: 'Add a section name before turning it on.' })
  if (d.enabled && d.productIds.length === 0) ctx.addIssue({ path: ['productIds'], code: 'custom', message: 'Choose at least one product before turning it on.' })
})

/** Products in the saved order; missing (deleted) ones are skipped */
async function productsInOrder(ids, filter = {}) {
  if (!ids.length) return []
  const docs = await Product.find({ _id: { $in: ids }, ...filter }).populate('categoryId', 'name slug').lean()
  const byId = new Map(docs.map(p => [p._id.toString(), p]))
  return ids.map(id => byId.get(id.toString())).filter(Boolean)
}

// ─── Admin ────────────────────────────────────────────────────────────────────
export const adminEventSectionRouter = Router()

adminEventSectionRouter.get('/', async (_req, res) => {
  try {
    const section  = await loadEventSection()
    const products = await productsInOrder(section.productIds)
    res.json({
      enabled:    section.enabled,
      title:      section.title,
      subtitle:   section.subtitle,
      // Lightweight product info for the picker — archived ones flagged
      products:   products.map(p => ({
        _id:      p._id,
        name:     p.name,
        brand:    p.brand,
        image:    p.images?.[0]?.url ?? null,
        isActive: p.isActive,
      })),
      updatedAt:  section.updatedAt,
    })
  } catch (err) {
    console.error('[admin/event-section] get:', err)
    res.status(500).json({ message: 'Failed to load event section.' })
  }
})

adminEventSectionRouter.put('/', async (req, res) => {
  try {
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Validation error.', errors: parsed.error.flatten().fieldErrors })
    }
    const data = parsed.data
    const ids  = [...new Set(data.productIds)]

    const found = await Product.countDocuments({ _id: { $in: ids } })
    if (found !== ids.length) {
      return res.status(400).json({ message: 'Some selected products no longer exist.', errors: { productIds: ['Some selected products no longer exist.'] } })
    }

    await EventSection.updateOne(
      { _id: 'global' },
      { $set: { enabled: data.enabled, title: data.title, subtitle: data.subtitle, productIds: ids } },
      { upsert: true, runValidators: true },
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('[admin/event-section] put:', err)
    res.status(500).json({ message: 'Failed to save event section.' })
  }
})

// ─── Public ───────────────────────────────────────────────────────────────────
export const storefrontEventSectionRouter = Router()

/**
 * GET /api/storefront/event-section
 * { enabled: false } when hidden or when none of the chosen products are active.
 */
storefrontEventSectionRouter.get('/', async (_req, res) => {
  try {
    const section = await EventSection.findById('global').lean()
    if (!section?.enabled) return res.json({ enabled: false })

    const products = await productsInOrder(section.productIds, { isActive: true })
    if (!products.length) return res.json({ enabled: false })

    res.json({
      enabled:  true,
      title:    section.title,
      subtitle: section.subtitle,
      products: products.map(toPublic),
    })
  } catch (err) {
    console.error('[storefront] event-section:', err)
    res.status(500).json({ message: 'Failed to load event section.' })
  }
})
