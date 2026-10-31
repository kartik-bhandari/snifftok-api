/**
 * src/routes/orders.js
 * Storefront: POST /api/storefront/orders  — create an order (signed-in customers only)
 *             POST /api/storefront/orders/:id/pay            — retry Razorpay payment (own orders)
 *             POST /api/storefront/orders/:id/verify-payment — confirm a Razorpay payment
 * Admin:      GET  /api/admin/orders       — list all orders
 *             GET  /api/admin/orders/:id   — get single order
 *             PATCH /api/admin/orders/:id/status — update order status
 */

import { Router } from 'express'
import { Order, PLACED } from '../models/Order.js'
import { requireAuth } from '../middleware/auth.js'
import mongoose from 'mongoose'
import { resolveOrderItems, reserveForOrder, cancelReservation, stockForStatusChange, StockError } from '../lib/stock.js'
import { priceOrder, MAX_QTY_PER_LINE } from '../lib/checkout.js'
import { razorpayEnabled, verifyPaymentSignature } from '../lib/razorpay.js'
import { checkoutPayload, ensureRazorpayOrder, markOrderPaid } from '../lib/payments.js'

// Cost prices are admin-only — never return them on storefront endpoints
const CUSTOMER_FIELDS = '-items.unitCost'

// ─── Storefront router (public) ───────────────────────────────────────────────
export const storefrontOrdersRouter = Router()

/**
 * GET /api/storefront/orders/mine
 * Returns all orders for the logged-in user.
 * Matches by userId (set on new orders) OR by customer.email (fallback for
 * orders placed before userId was being stored, or if it was missing).
 */
storefrontOrdersRouter.get('/mine', requireAuth, async (req, res) => {
  try {
    const orders = await Order.find({
      ...PLACED,
      $or: [
        { userId: req.user._id },
        { 'customer.email': req.user.email.toLowerCase() },
      ],
    })
      .select(CUSTOMER_FIELDS)
      .sort({ createdAt: -1 })
      .lean()
    res.json({ data: orders })
  } catch (err) {
    console.error('[storefront/orders] mine:', err)
    res.status(500).json({ message: 'Failed to load your orders.' })
  }
})

/**
 * GET /api/storefront/orders/lookup?email=&orderNumber=
 * Guest order tracking — matches only when BOTH email and orderNumber match.
 */
storefrontOrdersRouter.get('/lookup', async (req, res) => {
  try {
    const { email, orderNumber } = req.query
    if (!email || !orderNumber) {
      return res.status(400).json({ message: 'email and orderNumber are required.' })
    }
    const order = await Order.findOne({
      ...PLACED,
      orderNumber,
      'customer.email': email.toLowerCase().trim(),
    }).select(CUSTOMER_FIELDS).lean()
    if (!order) return res.status(404).json({ message: 'Order not found. Check your email and order number.' })
    res.json({ data: order })
  } catch (err) {
    console.error('[storefront/orders] lookup:', err)
    res.status(500).json({ message: 'Failed to look up order.' })
  }
})

/**
 * POST /api/storefront/orders
 * Body: { customer, address, items: [{ sku?, productId?, name, variantType, sizeMl, quantity }], notes? }
 * Prices, shipping and totals are calculated server-side (lib/checkout.js) —
 * any client values are ignored. Stock is reserved before the order is saved.
 * With Razorpay configured, the response includes what the storefront needs to
 * open Razorpay Checkout; the order is confirmed once payment is verified.
 * Checkout needs an account — the order belongs to the signed-in user.
 */
storefrontOrdersRouter.post('/', requireAuth, async (req, res) => {
  try {
    const { customer, address, items, notes } = req.body
    const sessionUserId = req.user._id.toString()

    // Basic validation
    if (!customer?.name || !customer?.email || !customer?.phone) {
      return res.status(400).json({ message: 'Customer name, email and phone are required.' })
    }
    if (!address?.line1 || !address?.pincode) {
      return res.status(400).json({ message: 'Address line and pincode are required.' })
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ message: 'Order must contain at least one item.' })
    }
    if (items.some(i => !Number.isInteger(i?.quantity) || i.quantity < 1 || i.quantity > MAX_QTY_PER_LINE)) {
      return res.status(400).json({ message: `Each item needs a quantity between 1 and ${MAX_QTY_PER_LINE}.` })
    }
    // Prepaid only — no online payment, no order
    if (!razorpayEnabled()) {
      return res.status(503).json({ message: 'Online payment is unavailable right now, so we can\'t take orders. Please try again shortly or message us on WhatsApp.' })
    }

    // Match each line to its product variant, then price it server-side
    let priced
    try {
      const resolved = await resolveOrderItems(items.map(({ unitCost, variantId, unitPrice, lineTotal, ...item }) => item)) // eslint-disable-line no-unused-vars
      priced = await priceOrder(resolved)
    } catch (err) {
      if (err instanceof StockError) return res.status(err.status).json({ message: err.message })
      throw err
    }

    // Hold the stock before saving — refuse the order if anything has sold out
    const orderId = new mongoose.Types.ObjectId()
    try {
      await reserveForOrder(priced.items, { orderId, actor: sessionUserId })
    } catch (err) {
      if (err instanceof StockError) {
        return res.status(err.status).json({ message: `Sorry — ${err.message} Please update your bag and try again.`, outOfStock: true })
      }
      throw err
    }

    const order = new Order({
      _id: orderId,
      customer: { ...customer, email: customer.email.toLowerCase().trim() },
      address,
      items: priced.items,
      channel: 'web',
      stockState: 'reserved',
      subtotal: priced.subtotal,
      shippingAmount: priced.shippingAmount,
      total: priced.total,
      notes,
      userId: sessionUserId,
      paymentStatus: 'pending',
      payment: { provider: 'razorpay' },
    })

    try {
      await order.save()
    } catch (err) {
      await cancelReservation(priced.items, { orderId }).catch(e => console.error('[orders] release after failed save:', e.message))
      throw err
    }

    let razorpay
    try {
      razorpay = checkoutPayload(await ensureRazorpayOrder(order.toObject()))
    } catch (err) {
      // Payment service down — don't leave a reservation behind
      console.error('[orders] Razorpay order failed:', err?.error?.description ?? err.message)
      const stockState = await stockForStatusChange(order.toObject(), 'cancelled', 'system').catch(() => undefined)
      await Order.updateOne(
        { _id: order._id },
        { $set: { status: 'cancelled', ...(stockState ? { stockState } : {}), 'payment.note': 'Payment service unavailable when the order was placed.' } },
      )
      return res.status(502).json({ message: 'We could not start the payment just now. Please try again in a minute.' })
    }

    res.status(201).json({
      orderNumber: order.orderNumber,
      orderId:     order._id,
      total:       order.total,
      razorpay,
    })
  } catch (err) {
    console.error('[orders] create:', err)
    res.status(500).json({ message: 'Failed to create order.' })
  }
})

/**
 * POST /api/storefront/orders/:id/pay
 * Retry payment for a pending, unpaid order (e.g. the Razorpay window was closed).
 */
storefrontOrdersRouter.post('/:id/pay', requireAuth, async (req, res) => {
  try {
    if (!razorpayEnabled()) return res.status(400).json({ message: 'Online payment is not available.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found.' })

    const order = await Order.findById(req.params.id).lean()
    if (!order || String(order.userId) !== req.user._id.toString()) return res.status(404).json({ message: 'Order not found.' })
    if (order.paymentStatus === 'paid') return res.status(409).json({ message: 'This order is already paid.', paid: true })
    if (order.status !== 'pending' || order.paymentStatus !== 'pending') {
      return res.status(409).json({ message: 'This order can no longer be paid — it may have expired. Please place it again.' })
    }

    const withRzp = await ensureRazorpayOrder(order)
    res.json({ orderNumber: order.orderNumber, orderId: order._id, total: order.total, razorpay: checkoutPayload(withRzp) })
  } catch (err) {
    console.error('[orders] pay:', err)
    res.status(500).json({ message: 'We could not start the payment just now. Please try again.' })
  }
})

/**
 * POST /api/storefront/orders/:id/verify-payment
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature } from Razorpay Checkout.
 * Verifies the signature, then marks the order paid and confirms it.
 * No sign-in needed: the Razorpay signature proves the payment, and a session
 * that expires mid-payment shouldn't lose the confirmation.
 */
storefrontOrdersRouter.post('/:id/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id: razorpayOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body ?? {}
    if (!razorpayOrderId || !paymentId || !signature) {
      return res.status(400).json({ message: 'Missing payment details.' })
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found.' })

    const order = await Order.findById(req.params.id).select('payment orderNumber').lean()
    if (!order) return res.status(404).json({ message: 'Order not found.' })
    const genuine = order.payment?.razorpayOrderId === razorpayOrderId &&
      verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId: paymentId, signature })
    if (!genuine) {
      return res.status(400).json({ message: 'We could not verify this payment. If money was deducted, it will be confirmed shortly or refunded.' })
    }

    const updated = await markOrderPaid(razorpayOrderId, { paymentId })
    res.json({
      orderNumber:    updated.orderNumber,
      status:         updated.status,
      paymentStatus:  updated.paymentStatus,
      needsAttention: Boolean(updated.payment?.note && updated.status === 'cancelled'),
    })
  } catch (err) {
    console.error('[orders] verify-payment:', err)
    res.status(500).json({ message: 'Payment received — we are confirming your order. Please check My Orders in a minute.' })
  }
})

// ─── Admin router (protected) ─────────────────────────────────────────────────
export const adminOrdersRouter = Router()

/** Staff can manage orders but not see cost prices */
const adminFields = (req) => (req.user.role === 'admin' ? '' : CUSTOMER_FIELDS)

/**
 * GET /api/admin/orders
 * Query: page, limit, status, search (customer name/email/orderNumber)
 */
adminOrdersRouter.get('/', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  ?? '1',  10))
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10)))
    const skip  = (page - 1) * limit

    const filter = { ...PLACED }
    if (req.query.status) filter.status = req.query.status
    if (req.query.search) {
      const re = new RegExp(req.query.search, 'i')
      filter.$or = [
        { orderNumber:        re },
        { 'customer.name':    re },
        { 'customer.email':   re },
        { 'customer.phone':   re },
      ]
    }

    const [orders, total] = await Promise.all([
      Order.find(filter).select(adminFields(req)).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter),
    ])

    res.json({ data: orders, total, page, limit, totalPages: Math.ceil(total / limit) })
  } catch (err) {
    console.error('[admin/orders] list:', err)
    res.status(500).json({ message: 'Failed to load orders.' })
  }
})

/** GET /api/admin/orders/:id */
adminOrdersRouter.get('/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).select(adminFields(req)).lean()
    if (!order) return res.status(404).json({ message: 'Order not found.' })
    res.json(order)
  } catch (err) {
    console.error('[admin/orders] get:', err)
    res.status(500).json({ message: 'Failed to load order.' })
  }
})

/** PATCH /api/admin/orders/:id/status */
adminOrdersRouter.patch('/:id/status', async (req, res) => {
  try {
    const VALID = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']
    const { status } = req.body
    if (!VALID.includes(status)) {
      return res.status(400).json({ message: `Invalid status. Must be one of: ${VALID.join(', ')}` })
    }
    const existing = await Order.findById(req.params.id).lean()
    if (!existing) return res.status(404).json({ message: 'Order not found.' })
    if (existing.status === status) {
      return res.json(await Order.findById(existing._id).select(adminFields(req)).lean())
    }
    if (['pending', 'failed'].includes(existing.paymentStatus)) {
      return res.status(409).json({ message: "This order hasn't been paid, so it can't be changed." })
    }

    // Deduct, release or restock to match the new status
    let stockState
    try {
      stockState = await stockForStatusChange(existing, status, req.user._id.toString())
    } catch (err) {
      if (err instanceof StockError) return res.status(err.status).json({ message: `Can't change status: ${err.message}` })
      throw err
    }

    const order = await Order.findByIdAndUpdate(
      existing._id,
      { status, ...(stockState ? { stockState } : {}) },
      { new: true, runValidators: true },
    ).select(adminFields(req)).lean()
    res.json(order)
  } catch (err) {
    console.error('[admin/orders] updateStatus:', err)
    res.status(500).json({ message: 'Failed to update order status.' })
  }
})
