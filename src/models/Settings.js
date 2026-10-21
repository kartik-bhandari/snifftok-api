/**
 * src/models/Settings.js
 * Global store settings — single document with _id: 'global'.
 * Used by the pricing engine.
 */

import mongoose from 'mongoose'

const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    gstRate:              { type: Number, default: 0.18 },
    gatewayFeeRate:       { type: Number, default: 0.02 },
    gatewayFeeGstRate:    { type: Number, default: 0.18 },
    deliveryPerSlab:      { type: Number, default: 8000 },   // paise = ₹80
    testersPerSlab:       { type: Number, default: 5 },
    defaultMinProfit:     {
      bottle: { type: Number, default: 30000 },              // paise = ₹300
      tester: { type: Number, default: 30000 },
    },
    roundingStep:         { type: Number, default: 100 },    // paise = ₹1
    mixedCartSlabSharing: { type: Boolean, default: false },
    reservationHoldHours: { type: Number, default: 24 },
    vendor: {
      name:            { type: String, default: 'snifftok' },
      whatsappNumber:  { type: String, default: '' },
    },
  },
  { _id: false, timestamps: true },
)

export const Settings = mongoose.model('Settings', settingsSchema)

/**
 * Load settings (with defaults fallback).
 * Always returns a valid settings object — creates the document if absent.
 */
export async function loadSettings() {
  let doc = await Settings.findById('global').lean()
  if (!doc) {
    doc = await Settings.create({ _id: 'global' })
    doc = doc.toObject()
  }
  return doc
}
