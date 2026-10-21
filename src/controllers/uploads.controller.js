/**
 * src/controllers/uploads.controller.js
 * Signed Cloudinary upload signatures and orphan image cleanup.
 */

import { z } from 'zod'
import { generateUploadSignature, deleteImages } from '../lib/cloudinary.js'

const signatureSchema = z.object({
  folder: z.string().trim().optional().default('snifftok/products'),
})

const discardSchema = z.object({
  publicIds: z.array(z.string().min(1)).min(1).max(20),
})

/**
 * POST /api/admin/uploads/signature
 * Returns signed upload params — API secret is NEVER included in the response.
 */
export async function getUploadSignature(req, res) {
  try {
    const parsed = signatureSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid request.' })
    }
    // Only allow the products folder for security
    const folder = parsed.data.folder.startsWith('snifftok/')
      ? parsed.data.folder
      : 'snifftok/products'

    const signatureData = generateUploadSignature(folder)
    res.json(signatureData)
  } catch (err) {
    console.error('[uploads] signature error:', err)
    res.status(500).json({ message: 'Failed to generate upload signature.' })
  }
}

/**
 * POST /api/admin/uploads/discard
 * Delete orphan images from Cloudinary when the user cancels a form mid-upload.
 */
export async function discardImages(req, res) {
  try {
    const parsed = discardSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ message: 'Validation error.', errors: parsed.error.flatten().fieldErrors })
    }
    const result = await deleteImages(parsed.data.publicIds)
    res.json({ ok: true, result })
  } catch (err) {
    console.error('[uploads] discard error:', err)
    res.status(500).json({ message: 'Failed to discard images.' })
  }
}
