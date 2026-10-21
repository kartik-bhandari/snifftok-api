/**
 * src/models/StockMovement.js
 * Ledger of every stock change. Written whenever stock or reserved changes.
 */

import mongoose from 'mongoose'

const stockMovementSchema = new mongoose.Schema(
  {
    sku:       { type: String, required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    delta:     { type: Number, required: true },           // positive = added, negative = removed
    field:     { type: String, enum: ['stock', 'reserved'], required: true },
    reason: {
      type: String,
      enum: [
        'purchase', 'adjustment', 'web_order_reserved', 'wa_order_reserved',
        'order_confirmed', 'reservation_released', 'cancelled', 'returned',
      ],
      required: true,
    },
    note:    { type: String, maxlength: 500 },             // required for 'adjustment'
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    actor:   { type: String, required: true },             // userId or 'system'
  },
  { timestamps: true },
)

stockMovementSchema.index({ sku: 1, createdAt: -1 })
stockMovementSchema.index({ productId: 1 })

export const StockMovement = mongoose.model('StockMovement', stockMovementSchema)
