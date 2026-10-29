/**
 * src/controllers/products.controller.js
 * CRUD for products. All money is in INTEGER PAISE.
 *
 * SECURITY:
 * - costPrice and minProfit are STRIPPED from responses for 'staff' role.
 * - Selling price is always computed server-side — never trusted from the client.
 */

import mongoose from 'mongoose'
import { z }    from 'zod'
import { Product }       from '../models/Product.js'
import { StockMovement } from '../models/StockMovement.js'
import { loadSettings }  from '../models/Settings.js'
import { deleteImages }  from '../lib/cloudinary.js'
import { unitPriceExclDelivery } from '../lib/pricing.js'
import { isActiveCategory } from './categories.controller.js'

// ── Zod schemas ───────────────────────────────────────────────────────────────

const imageSchema = z.object({
  url:       z.string().url(),
  publicId:  z.string().min(1),
  width:     z.number().int().positive().optional(),
  height:    z.number().int().positive().optional(),
  order:     z.number().int().min(0).default(0),
})

const variantSchema = z.object({
  _id:          z.string().optional(),
  type:         z.enum(['bottle', 'tester']),
  sizeMl:       z.number().int().positive(),
  sku:          z.string().trim().min(1).max(50).transform(s => s.toUpperCase()),
  costPrice:    z.number().int().positive(),    // paise
  minProfit:    z.number().int().min(0),         // paise
  stock:        z.number().int().min(0),
  reorderLevel: z.number().int().min(0).default(3),
})

const productWriteSchema = z.object({
  name:          z.string().trim().min(1).max(200),
  brand:         z.string().trim().max(100).optional(),
  categoryId:    z.string({ required_error: 'Category is required.' }).regex(/^[a-f\d]{24}$/i, 'Category is required.'),
  description:   z.string().max(2000).optional(),
  notes: z.object({
    top:   z.array(z.string().trim()).default([]),
    heart: z.array(z.string().trim()).default([]),
    base:  z.array(z.string().trim()).default([]),
  }).default({}),
  concentration: z.string().trim().max(100).optional(),
  origin:        z.string().trim().max(100).optional(),
  tags:          z.array(z.enum(['trending', 'best-seller', 'new'])).default([]),
  isActive:      z.boolean().default(true),
  images:        z.array(imageSchema).min(1, 'At least one image is required.').max(8),
  variants:      z.array(variantSchema).min(1, 'At least one variant is required.'),
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute and attach selling price to each variant using server-side pricing.
 */
async function computeVariantPrices(variants) {
  const settings = await loadSettings()
  return variants.map(v => ({
    ...v,
    pricing: {
      unitPriceExclDelivery: unitPriceExclDelivery(
        { costPrice: v.costPrice, minProfit: v.minProfit },
        settings,
      ),
      calculatedAt: new Date(),
    },
  }))
}

/**
 * Strip sensitive fields from a product for staff responses.
 */
function stripSensitiveFields(product, role) {
  if (role === 'admin') return product
  // Staff: remove cost and profit from variants
  if (product.variants) {
    product.variants = product.variants.map(v => {
      const { costPrice, minProfit, ...rest } = v  // eslint-disable-line no-unused-vars
      return rest
    })
  }
  return product
}

/**
 * Build a product query from request query params.
 */
function buildQuery(q) {
  const filter = {}

  if (q.search) {
    // Partial, case-insensitive match ("ou" finds "Oud Ember") — $text only
    // matches whole words, which is awkward for search-as-you-type
    const re = new RegExp(String(q.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    filter.$or = [{ name: re }, { brand: re }, { 'variants.sku': re }]
  }
  if (q.category) {
    filter.categoryId = q.category
  }
  if (q.status === 'active')   filter.isActive = true
  if (q.status === 'inactive') filter.isActive = false

  // Stock filter: check any variant
  if (q.stock === 'out') {
    filter['variants'] = { $elemMatch: { stock: 0 } }
  } else if (q.stock === 'low') {
    filter['variants'] = { $elemMatch: { $expr: { $and: [
      { $gt: ['$variants.stock', 0] },
      { $lte: ['$variants.stock', '$variants.reorderLevel'] },
    ]}}}
  }

  // Type filter
  if (q.type === 'bottle' || q.type === 'tester') {
    filter['variants.type'] = q.type
  }

  return filter
}

// ── Controllers ───────────────────────────────────────────────────────────────

/** GET /api/admin/products */
export async function listProducts(req, res) {
  try {
    const page  = Math.max(1, parseInt(req.query.page  ?? '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '20', 10)))
    const skip  = (page - 1) * limit

    const filter = buildQuery(req.query)

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('categoryId', 'name slug')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ])

    const stripped = products.map(p => stripSensitiveFields(p, req.user.role))

    res.json({
      data: stripped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to load products.' })
  }
}

/** GET /api/admin/products/:id */
export async function getProduct(req, res) {
  try {
    const product = await Product.findById(req.params.id)
      .populate('categoryId', 'name slug')
      .lean()
    if (!product) return res.status(404).json({ message: 'Product not found.' })
    res.json({ product: stripSensitiveFields(product, req.user.role) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to load product.' })
  }
}

/** POST /api/admin/products */
export async function createProduct(req, res) {
  try {
    const parsed = productWriteSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Validation error.',
        errors: parsed.error.flatten().fieldErrors,
      })
    }

    const data = parsed.data

    if (!(await isActiveCategory(data.categoryId))) {
      return res.status(400).json({ message: 'Choose one of the 5 categories.', errors: { categoryId: ['Choose one of the 5 categories.'] } })
    }

    // Check SKU uniqueness within the form
    const skus = data.variants.map(v => v.sku)
    if (new Set(skus).size !== skus.length) {
      return res.status(400).json({ message: 'Duplicate SKUs in variants.' })
    }

    // Check SKU uniqueness in the database
    const existing = await Product.findOne({ 'variants.sku': { $in: skus } }).lean()
    if (existing) {
      const dup = existing.variants.find(v => skus.includes(v.sku))
      return res.status(409).json({ message: `SKU "${dup.sku}" is already in use.`, field: 'sku' })
    }

    // Compute selling prices server-side
    const variantsWithPricing = await computeVariantPrices(data.variants)

    // Sort images by order
    const images = [...data.images].sort((a, b) => a.order - b.order)

    const product = await Product.create({
      ...data,
      variants: variantsWithPricing,
      images,
    })

    await product.populate('categoryId', 'name slug')
    res.status(201).json({ product: stripSensitiveFields(product.toObject(), req.user.role) })
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'A product with this name or SKU already exists.' })
    }
    console.error(err)
    res.status(500).json({ message: 'Failed to create product.' })
  }
}

/** PUT /api/admin/products/:id */
export async function updateProduct(req, res) {
  const session = await mongoose.startSession()
  try {
    let updatedProduct
    await session.withTransaction(async () => {
      const existing = await Product.findById(req.params.id).session(session)
      if (!existing) {
        const err = new Error('not_found'); err.status = 404; throw err
      }

      // Optimistic concurrency check
      if (req.body.__v !== undefined && existing.__v !== req.body.__v) {
        const err = new Error('conflict'); err.status = 409; throw err
      }

      const parsed = productWriteSchema.safeParse(req.body)
      if (!parsed.success) {
        const err = new Error('validation')
        err.status = 400
        err.errors = parsed.error.flatten().fieldErrors
        throw err
      }

      const data = parsed.data

      if (!(await isActiveCategory(data.categoryId))) {
        const err = new Error('validation')
        err.status = 400
        err.errors = { categoryId: ['Choose one of the 5 categories.'] }
        throw err
      }

      // SKU uniqueness check (exclude this product's own SKUs)
      const skus = data.variants.map(v => v.sku)
      if (new Set(skus).size !== skus.length) {
        const err = new Error('Duplicate SKUs in variants.'); err.status = 400; throw err
      }
      const dupProduct = await Product.findOne({
        _id: { $ne: existing._id },
        'variants.sku': { $in: skus },
      }).session(session).lean()
      if (dupProduct) {
        const dup = dupProduct.variants.find(v => skus.includes(v.sku))
        const err = new Error(`SKU "${dup.sku}" is already in use.`)
        err.status = 409; err.field = 'sku'; throw err
      }

      // Stock adjustments — write ledger entries for changed stock values
      const oldVariantsMap = new Map(existing.variants.map(v => [v._id.toString(), v]))
      for (const newV of data.variants) {
        if (!newV._id) continue
        const oldV = oldVariantsMap.get(newV._id)
        if (!oldV) continue
        const delta = newV.stock - oldV.stock
        if (delta !== 0) {
          if (!req.body.stockNote) {
            const err = new Error('A note is required when adjusting stock.')
            err.status = 400; throw err
          }
          await StockMovement.create([{
            sku:       newV.sku,
            productId: existing._id,
            delta,
            field:     'stock',
            reason:    'adjustment',
            note:      req.body.stockNote,
            actor:     req.user._id.toString(),
          }], { session })
        }
      }

      // Recompute selling prices
      const variantsWithPricing = await computeVariantPrices(data.variants)
      const images = [...data.images].sort((a, b) => a.order - b.order)

      // Track images removed (for post-save Cloudinary cleanup)
      const oldPublicIds = new Set(existing.images.map(i => i.publicId))
      const newPublicIds = new Set(data.images.map(i => i.publicId))
      const removedPublicIds = [...oldPublicIds].filter(id => !newPublicIds.has(id))

      Object.assign(existing, { ...data, variants: variantsWithPricing, images })
      await existing.save({ session })
      updatedProduct = existing

      // Delete removed images from Cloudinary AFTER successful save
      if (removedPublicIds.length > 0) {
        deleteImages(removedPublicIds).catch(e =>
          console.error('[cloudinary] failed to delete images post-update:', e)
        )
      }
    })

    await updatedProduct.populate('categoryId', 'name slug')
    res.json({ product: stripSensitiveFields(updatedProduct.toObject(), req.user.role) })
  } catch (err) {
    if (err.message === 'not_found')  return res.status(404).json({ message: 'Product not found.' })
    if (err.message === 'conflict')   return res.status(409).json({ message: 'This product was changed by someone else. Please reload and try again.' })
    if (err.message === 'validation') return res.status(400).json({ message: 'Validation error.', errors: err.errors })
    if (err.status)                   return res.status(err.status).json({ message: err.message, field: err.field })
    console.error(err)
    res.status(500).json({ message: 'Failed to update product.' })
  } finally {
    session.endSession()
  }
}

/** DELETE /api/admin/products/:id */
export async function deleteProduct(req, res) {
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Product not found.' })

    // Block if any variant has reserved stock
    const hasReserved = product.variants.some(v => v.reserved > 0)
    if (hasReserved) {
      return res.status(409).json({
        message: 'This product has reserved stock from open orders and cannot be deleted.',
        canArchive: true,
      })
    }

    // TODO: check open orders when Order model is available
    // For now, reserved stock > 0 is the proxy for open orders

    const publicIds = product.images.map(i => i.publicId)
    await product.deleteOne()

    // Delete Cloudinary images after successful DB delete
    if (publicIds.length > 0) {
      deleteImages(publicIds).catch(e =>
        console.error('[cloudinary] failed to delete images post-delete:', e)
      )
    }

    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to delete product.' })
  }
}

/** POST /api/admin/products/:id/archive */
export async function archiveProduct(req, res) {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true },
    ).populate('categoryId', 'name slug').lean()
    if (!product) return res.status(404).json({ message: 'Product not found.' })
    res.json({ product: stripSensitiveFields(product, req.user.role) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to archive product.' })
  }
}

/** GET /api/admin/products — check if a SKU is available */
export async function checkSku(req, res) {
  try {
    const { sku, excludeProductId } = req.query
    if (!sku) return res.status(400).json({ message: 'sku is required.' })
    const query = { 'variants.sku': sku.toUpperCase() }
    if (excludeProductId) query._id = { $ne: excludeProductId }
    const exists = await Product.exists(query)
    res.json({ available: !exists })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to check SKU.' })
  }
}
