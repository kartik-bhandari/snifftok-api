/**
 * src/models/Category.js
 * Product categories (Men, Women, Unisex, Oud, Attar, Arabic Fragrances, …)
 */

import mongoose from 'mongoose'
import slugify from 'slugify'

const categorySchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true, maxlength: 80 },
    slug:     { type: String, required: true, unique: true, lowercase: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

// Auto-generate slug from name before save
categorySchema.pre('validate', function () {
  if (this.isModified('name') || !this.slug) {
    this.slug = slugify(this.name, { lower: true, strict: true })
  }
})

categorySchema.index({ isActive: 1 })

export const Category = mongoose.model('Category', categorySchema)
