/**
 * src/models/Product.js
 * Core product model for snifftok.
 *
 * MONEY: all prices stored as INTEGER PAISE (₹1 = 100 paise). Never floats.
 * SECURITY: costPrice and minProfit are NEVER sent to clients without the
 *   admin role — strip them in the controller layer.
 */

import mongoose from 'mongoose'
import slugify from 'slugify'

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const imageSchema = new mongoose.Schema(
  {
    url:       { type: String, required: true },
    publicId:  { type: String, required: true },
    width:     Number,
    height:    Number,
    order:     { type: Number, default: 0 },
  },
  { _id: false },
)

const variantSchema = new mongoose.Schema(
  {
    type:       { type: String, enum: ['bottle', 'tester'], required: true },
    sizeMl:     { type: Number, required: true, min: 1 },
    sku:        { type: String, required: true, trim: true, uppercase: true },
    costPrice:  { type: Number, required: true, min: 0 },   // paise
    minProfit:  { type: Number, required: true, min: 0 },   // paise
    stock:      { type: Number, required: true, min: 0, default: 0 },
    reserved:   { type: Number, default: 0, min: 0 },
    reorderLevel: { type: Number, default: 3, min: 0 },
    pricing: {
      unitPriceExclDelivery: Number,   // paise — computed server-side
      calculatedAt:          Date,
    },
  },
  { _id: true },
)

// ── Product schema ─────────────────────────────────────────────────────────────

const productSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true, maxlength: 200 },
    slug:          { type: String, unique: true, lowercase: true },
    brand:         { type: String, trim: true, maxlength: 100 },
    categoryId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    description:   { type: String, maxlength: 2000 },
    notes: {
      top:   [{ type: String, trim: true }],
      heart: [{ type: String, trim: true }],
      base:  [{ type: String, trim: true }],
    },
    concentration: { type: String, trim: true, maxlength: 100 },
    origin:        { type: String, trim: true, maxlength: 100 },
    tags:          [{ type: String, enum: ['trending', 'best-seller', 'new'] }],
    isActive:      { type: Boolean, default: true },
    images:        [imageSchema],
    variants:      { type: [variantSchema], default: [] },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,   // adds __v, throws VersionError on stale updates
  },
)

// Auto-generate slug from name
productSchema.pre('validate', async function () {
  if (this.isModified('name') || !this.slug) {
    const base = slugify(this.name, { lower: true, strict: true })
    // Ensure slug uniqueness by appending a counter if needed
    let slug = base
    let i = 1
    while (await mongoose.model('Product').exists({ slug, _id: { $ne: this._id } })) {
      slug = `${base}-${i++}`
    }
    this.slug = slug
  }
})

// Text search index for name, brand, description

productSchema.index({ isActive: 1, createdAt: -1 })
productSchema.index({ 'variants.sku': 1 }, { unique: true, sparse: true })
productSchema.index({ categoryId: 1 })
productSchema.index({
  name: 'text', brand: 'text', 'variants.sku': 'text',
}, { name: 'product_text_idx' })

export const Product = mongoose.model('Product', productSchema)
