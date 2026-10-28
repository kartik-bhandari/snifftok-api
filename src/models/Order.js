/**
 * src/models/Order.js
 * Customer order model for snifftok.
 *
 * MONEY: all price/shipping/total stored as INTEGER PAISE (₹1 = 100). Never floats.
 */

import mongoose from 'mongoose'

const orderItemSchema = new mongoose.Schema(
  {
    productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name:        { type: String, required: true },
    brand:       { type: String },
    sku:         { type: String },
    variantType: { type: String, enum: ['bottle', 'tester'], required: true },
    sizeMl:      { type: Number, required: true },
    image:       { type: String },        // URL for display in admin
    unitPrice:   { type: Number, required: true, min: 0 },  // paise
    // Cost at time of sale — set server-side from the variant's costPrice so
    // profit reports don't change when cost prices are edited later. Admin-only.
    unitCost:    { type: Number, min: 0 },                  // paise
    quantity:    { type: Number, required: true, min: 1 },
    lineTotal:   { type: Number, required: true, min: 0 },  // paise
  },
  { _id: false },
)

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type:    String,
      unique:  true,
      // e.g. ORD-20241023-0001 — set in pre-save hook
    },
    customer: {
      name:  { type: String, required: true, trim: true },
      email: { type: String, required: true, trim: true, lowercase: true },
      phone: { type: String, required: true, trim: true },
    },
    address: {
      line1:   { type: String, required: true, trim: true },
      city:    { type: String, trim: true },
      state:   { type: String, trim: true },
      pincode: { type: String, required: true, trim: true },
      country: { type: String, default: 'India' },
    },
    items:          { type: [orderItemSchema], required: true },
    subtotal:       { type: Number, required: true, min: 0 },  // paise
    shippingAmount: { type: Number, required: true, min: 0 },  // paise
    total:          { type: Number, required: true, min: 0 },  // paise
    status: {
      type:    String,
      enum:    ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
      default: 'pending',
    },
    // Where the order came from — storefront checkout, WhatsApp, or entered by staff
    channel: { type: String, enum: ['web', 'whatsapp', 'admin'], default: 'web' },
    notes:  { type: String, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },  // optional
  },
  {
    timestamps: true,
  },
)

// Auto-generate a human-readable order number before saving for the first time
orderSchema.pre('save', async function () {
  if (!this.orderNumber) {
    const date  = new Date()
    const ymd   = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    const count = await mongoose.model('Order').countDocuments()
    this.orderNumber = `ORD-${ymd}-${String(count + 1).padStart(4, '0')}`
  }
})

orderSchema.index({ status: 1, createdAt: -1 })
orderSchema.index({ createdAt: -1 })
orderSchema.index({ 'customer.email': 1 })

export const Order = mongoose.model('Order', orderSchema)
