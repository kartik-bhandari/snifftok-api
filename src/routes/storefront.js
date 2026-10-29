/**
 * src/routes/storefront.js
 * Public read-only routes for the storefront — NO authentication required.
 * Sensitive fields (costPrice, minProfit) are never included.
 */
import { Router } from 'express'
import mongoose from 'mongoose'
import { Product } from '../models/Product.js'
import { Category } from '../models/Category.js'
import { loadSettings } from '../models/Settings.js'

const router = Router()

const PUBLIC_CATEGORY_FIELDS = 'name slug aka smellsLike notes subfamilies bestFor sortOrder'

/**
 * GET /api/storefront/categories
 * The 5 scent families, in display order, with active product counts.
 */
router.get('/categories', async (_req, res) => {
  try {
    const [categories, counts] = await Promise.all([
      Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select(PUBLIC_CATEGORY_FIELDS).lean(),
      Product.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: '$categoryId', count: { $sum: 1 } } },
      ]),
    ])
    const countById = new Map(counts.map(c => [String(c._id), c.count]))
    res.json({ data: categories.map(c => ({ ...c, productCount: countById.get(String(c._id)) ?? 0 })) })
  } catch (err) {
    console.error('[storefront] listCategories:', err)
    res.status(500).json({ message: 'Failed to load categories.' })
  }
})

/** GET /api/storefront/categories/:slug */
router.get('/categories/:slug', async (req, res) => {
  try {
    const category = await Category.findOne({ slug: req.params.slug, isActive: true })
      .select(PUBLIC_CATEGORY_FIELDS)
      .lean()
    if (!category) return res.status(404).json({ message: 'Category not found.' })
    res.json({ data: category })
  } catch (err) {
    console.error('[storefront] getCategory:', err)
    res.status(500).json({ message: 'Failed to load category.' })
  }
})

/** Strip all cost/profit fields from a product before sending to the public */
export function toPublic(p) {
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
 * Query params: search, category (id or slug), tag, type, page, limit,
 *   sort    — 'newest' (default) or 'name' (A–Z)
 *   inStock — 'true': only products with stock left (of `type` when given,
 *             e.g. type=tester&inStock=true → decants available to buy)
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
      // Accept an ObjectId or a category slug (e.g. ?category=floral)
      if (mongoose.isValidObjectId(req.query.category)) {
        filter.categoryId = req.query.category
      } else {
        const cat = await Category.findOne({ slug: String(req.query.category).toLowerCase() }).select('_id').lean()
        if (!cat) return res.json({ data: [], total: 0, page, limit, totalPages: 0 })
        filter.categoryId = cat._id
      }
    }
    if (req.query.tag) {
      filter.tags = req.query.tag
    }
    const type    = req.query.type === 'bottle' || req.query.type === 'tester' ? req.query.type : null
    const inStock = req.query.inStock === 'true'
    if (inStock) {
      // Some variant (of `type`, if given) with available stock = stock − reserved > 0
      const available = { $gt: [{ $subtract: ['$$v.stock', { $ifNull: ['$$v.reserved', 0] }] }, 0] }
      filter.$expr = {
        $anyElementTrue: [{
          $map: {
            input: { $ifNull: ['$variants', []] },
            as:    'v',
            in:    type ? { $and: [{ $eq: ['$$v.type', type] }, available] } : available,
          },
        }],
      }
    } else if (type) {
      filter['variants.type'] = type
    }

    const sort = req.query.sort === 'name' ? { name: 1 } : { createdAt: -1 }

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('categoryId', 'name slug')
        .sort(sort)
        .collation({ locale: 'en', strength: 2 })   // case-insensitive A–Z
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
