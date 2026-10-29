/**
 * src/models/Category.js
 * Product categories — the 5 scent families defined in src/data/scentFamilies.js
 * (Floral, Amber, Woody, Fresh, Gourmand). Older categories are kept with
 * isActive: false so existing references don't break.
 */

import mongoose from 'mongoose'
import slugify from 'slugify'

const categorySchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true, maxlength: 80 },
    slug:        { type: String, required: true, unique: true, lowercase: true },
    isActive:    { type: Boolean, default: true },
    sortOrder:   { type: Number, default: 0 },

    // Scent-family details shown on the storefront
    aka:         { type: String, trim: true },               // e.g. "Formerly Oriental"
    smellsLike:  { type: String, trim: true },
    notes:       [{ type: String, trim: true }],
    subfamilies: [{ type: String, trim: true }],
    bestFor:     { type: String, trim: true },
  },
  { timestamps: true },
)

// Auto-generate slug from name before save
categorySchema.pre('validate', function () {
  if (this.isModified('name') || !this.slug) {
    this.slug = slugify(this.name, { lower: true, strict: true })
  }
})

categorySchema.index({ isActive: 1, sortOrder: 1 })

export const Category = mongoose.model('Category', categorySchema)
