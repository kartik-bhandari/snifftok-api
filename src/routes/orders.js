/**
 * src/routes/orders.js
 * Storefront: POST /api/storefront/orders  — create an order (public, no auth required)
 * Admin:      GET  /api/admin/orders       — list all orders
 *             GET  /api/admin/orders/:id   — get single order
 *             PATCH /api/admin/orders/:id/status — update order status
 */

import { Router } from 'express'
import { Order } from '../models/Order.js'
import { requireAuth } from '../middleware/auth.js'
import { getUnitCosts } from '../lib/orderCosts.js'

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
 * Body: { customer, address, items, subtotal, shippingAmount, total, notes? }
 * All money values expected in PAISE from the client.
 * userId is read from the session cookie (not trusted from client body).
 */
storefrontOrdersRouter.post('/', async (req, res) => {
  try {
    const { customer, address, items, subtotal, shippingAmount, total, notes } = req.body

    // Resolve userId from session cookie if the user is logged in
    // We import requireAuth as optional: try to decode the cookie but don't block if missing.
    let sessionUserId
    try {
      const { verifyToken } = await import('../lib/jwt.js')
      const { config }      = await import('../config/index.js')
      const token = req.cookies?.[config.cookieName]
      if (token) {
        const decoded = verifyToken(token)
        if (decoded?.sub && !decoded.pending) sessionUserId = decoded.sub
      }
    } catch { /* not logged in — that's fine */ }

    // Basic validation
    if (!customer?.name || !customer?.email || !customer?.phone) {
      return res.status(400).json({ message: 'Customer name, email and phone are required.' })
    }
    if (!address?.line1 || !address?.pincode) {
      return res.status(400).json({ message: 'Address line and pincode are required.' })
    }
    if (!items?.length) {
      return res.status(400).json({ message: 'Order must contain at least one item.' })
    }
    if (typeof subtotal !== 'number' || typeof total !== 'number') {
      return res.status(400).json({ message: 'subtotal and total must be numbers (paise).' })
    }

    // Snapshot cost at time of sale (server-side only — ignore any client value)
    const costs = await getUnitCosts(items.map(i => i.sku))
    const itemsWithCost = items.map(({ unitCost, ...item }) => ({ // eslint-disable-line no-unused-vars
      ...item,
      unitCost: costs.get(item.sku?.toUpperCase()),
    }))

    const order = new Order({
      customer: { ...customer, email: customer.email.toLowerCase().trim() },
      address,
      items: itemsWithCost,
      channel: 'web',
      subtotal,
      shippingAmount: shippingAmount ?? 0,
      total,
      notes,
      userId: sessionUserId ?? undefined,
    })

    await order.save()

    res.status(201).json({
      orderNumber: order.orderNumber,
      orderId:     order._id,
    })
  } catch (err) {
    console.error('[orders] create:', err)
    res.status(500).json({ message: 'Failed to create order.' })
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

    const filter = {}
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
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true },
    ).select(adminFields(req)).lean()
    if (!order) return res.status(404).json({ message: 'Order not found.' })
    res.json(order)
  } catch (err) {
    console.error('[admin/orders] updateStatus:', err)
    res.status(500).json({ message: 'Failed to update order status.' })
  }
})
