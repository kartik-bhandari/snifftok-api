/**
 * src/models/EventSection.js
 * The storefront's special event / offer section — a single document
 * (_id: 'global') managed from the admin panel.
 *
 *   enabled    — show or hide the section on the storefront
 *   title      — section name, e.g. "Diwali Sale"
 *   subtitle   — optional line under the title
 *   productIds — existing products to feature, in display order
 */

import mongoose from 'mongoose'

export const EVENT_SECTION_MAX_PRODUCTS = 12

const eventSectionSchema = new mongoose.Schema(
  {
    _id:        { type: String, default: 'global' },
    enabled:    { type: Boolean, default: false },
    title:      { type: String, trim: true, maxlength: 60, default: '' },
    subtitle:   { type: String, trim: true, maxlength: 140, default: '' },
    productIds: {
      type:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
      default:  [],
      validate: [v => v.length <= EVENT_SECTION_MAX_PRODUCTS, `At most ${EVENT_SECTION_MAX_PRODUCTS} products.`],
    },
  },
  { _id: false, timestamps: true },
)

export const EventSection = mongoose.model('EventSection', eventSectionSchema)

/** The section document, created (disabled) on first use */
export async function loadEventSection() {
  let doc = await EventSection.findById('global').lean()
  if (!doc) doc = (await EventSection.create({ _id: 'global' })).toObject()
  return doc
}
