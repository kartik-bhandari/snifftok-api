/**
 * src/routes/storefront.js
 * Public read-only routes for the storefront — NO authentication required.
 * Sensitive fields (costPrice, minProfit) are never included.
 */
import { Router } from 'express'
import { Product } from '../models/Product.js'
import { loadSettings } from '../models/Settings.js'

const router = Router()

/** Strip all cost/profit fields from a product before sending to the public */
function toPublic(p) {
  return {
    _id:           p._id,
    name:          p.name,
    slug:          p.slug,
    brand:         p.brand,
    description:   p.description,
    concentration: p.concentration,
    origin:        p.origin,
    notes:         p.notes,
    tags:          p.tags,
    images:        p.images,
    categoryId:    p.categoryId,
    variants:      (p.variants ?? []).map(v => ({
      _id:     v._id,
      type:    v.type,
      sizeMl:  v.sizeMl,
      sku:     v.sku,
      stock:   Math.max(0, (v.stock ?? 0) - (v.reserved ?? 0)), // available stock only
      pricing: v.pricing,
    })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

/**
 * GET /api/storefront/products
 * Query params: search, category, tag, type, page, limit
 */
router.get('/products', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  ?? '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10)))
    const skip  = (page - 1) * limit

    const filter = { isActive: true }

    if (req.query.search) {
      filter.$text = { $search: req.query.search }
    }
    if (req.query.category) {
      filter.categoryId = req.query.category
    }
    if (req.query.tag) {
      filter.tags = req.query.tag
    }
    if (req.query.type === 'bottle' || req.query.type === 'tester') {
      filter['variants.type'] = req.query.type
    }

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('categoryId', 'name slug')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ])

    res.json({
      data:       products.map(toPublic),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err) {
    console.error('[storefront] listProducts:', err)
    res.status(500).json({ message: 'Failed to load products.' })
  }
})

/**
 * GET /api/storefront/products/:slug
 */
router.get('/products/:slug', async (req, res) => {
  try {
    const product = await Product.findOne({ slug: req.params.slug, isActive: true })
      .populate('categoryId', 'name slug')
      .lean()

    if (!product) return res.status(404).json({ message: 'Product not found.' })

    // Related: same category, exclude this product, max 4
    const related = await Product.find({
      isActive:   true,
      _id:        { $ne: product._id },
      categoryId: product.categoryId,
    })
      .populate('categoryId', 'name slug')
      .sort({ createdAt: -1 })
      .limit(4)
      .lean()

    res.json({ product: toPublic(product), related: related.map(toPublic) })
  } catch (err) {
    console.error('[storefront] getProduct:', err)
    res.status(500).json({ message: 'Failed to load product.' })
  }
})

export default router
