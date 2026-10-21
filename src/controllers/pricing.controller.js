/**
 * src/controllers/pricing.controller.js
 * POST /api/admin/pricing/preview
 * Admin-only: compute a live price breakdown for the product form.
 */

import { z } from 'zod'
import { previewPricing } from '../lib/pricing.js'
import { loadSettings } from '../models/Settings.js'

const previewSchema = z.object({
  type:       z.enum(['bottle', 'tester']),
  costPrice:  z.number().int().positive(),   // paise
  minProfit:  z.number().int().min(0),        // paise
})

export async function pricingPreview(req, res) {
  try {
    const parsed = previewSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Validation error.',
        errors: parsed.error.flatten().fieldErrors,
      })
    }
    const settings = await loadSettings()
    const preview  = previewPricing(parsed.data, settings)
    res.json(preview)
  } catch (err) {
    console.error('[pricing] preview error:', err)
    res.status(500).json({ message: 'Failed to compute pricing preview.' })
  }
}
