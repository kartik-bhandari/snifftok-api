/**
 * src/lib/payments.js
 * Online payment flow for storefront orders (Razorpay).
 *
 *   order placed  → stock reserved, Razorpay order created, paymentStatus 'pending'
 *   paid          → paymentStatus 'paid', status 'confirmed' (stock deducted)
 *   not paid      → auto-cancelled after PAYMENT_WINDOW_MINUTES (stock released)
 *
 * The store is prepaid-only, so an unpaid order is hidden from customers and
 * staff (Order PLACED filter) — it only holds the stock while the shopper pays.
 *
 * markOrderPaid is idempotent — the checkout callback and the webhook can both
 * report the same payment.
 */

import { Order } from '../models/Order.js'
import { createRazorpayOrder, razorpayKeyId } from './razorpay.js'
import { stockForStatusChange } from './stock.js'
import { sendOrderPaidEmail } from './orderEmails.js'

/** How long a checkout holds stock while waiting for payment */
export const PAYMENT_WINDOW_MINUTES = 30

/** What the storefront needs to open Razorpay Checkout */
export function checkoutPayload(order) {
  return {
    keyId:    razorpayKeyId(),
    orderId:  order.payment.razorpayOrderId,
    amount:   order.total,
    currency: 'INR',
  }
}

/** Create the Razorpay order for `order` if it doesn't have one yet */
export async function ensureRazorpayOrder(order) {
  if (order.payment?.razorpayOrderId) return order
  const rzp = await createRazorpayOrder({
    amount:  order.total,
    receipt: order.orderNumber,
    notes:   { orderId: String(order._id), orderNumber: order.orderNumber },
  })
  return Order.findByIdAndUpdate(
    order._id,
    { $set: { 'payment.provider': 'razorpay', 'payment.razorpayOrderId': rzp.id, paymentStatus: 'pending' } },
    { new: true },
  ).lean()
}

/**
 * Record a successful payment. Confirms the order (deducting its reserved
 * stock). If the order had already expired and its stock is gone, it stays
 * cancelled and is flagged for a refund.
 * Emails the customer (once) without holding up the response.
 * Returns the updated order.
 */
export async function markOrderPaid(razorpayOrderId, payment = {}) {
  const order = await applyPayment(razorpayOrderId, payment)
  if (order?.paymentStatus === 'paid') void sendOrderPaidEmail(order)   // never throws
  return order
}

async function applyPayment(razorpayOrderId, { paymentId, method }) {
  // Flip to paid exactly once
  const order = await Order.findOneAndUpdate(
    { 'payment.razorpayOrderId': razorpayOrderId, paymentStatus: { $ne: 'paid' } },
    {
      $set: {
        paymentStatus: 'paid',
        'payment.razorpayPaymentId': paymentId,
        'payment.method': method,
        'payment.paidAt': new Date(),
      },
      $unset: { 'payment.lastError': '' },
    },
    { new: true },
  ).lean()

  if (!order) return Order.findOne({ 'payment.razorpayOrderId': razorpayOrderId }).lean()   // already paid (or unknown)
  if (order.status !== 'pending' && order.status !== 'cancelled') return order             // already moving

  try {
    const stockState = await stockForStatusChange(order, 'confirmed', 'system')
    return Order.findByIdAndUpdate(order._id, { status: 'confirmed', ...(stockState ? { stockState } : {}) }, { new: true }).lean()
  } catch (err) {
    // Paid after the order expired and the stock has since sold — needs a refund
    console.error(`[payments] ${order.orderNumber} paid but can't be confirmed:`, err.message)
    return Order.findByIdAndUpdate(
      order._id,
      { 'payment.note': `Paid after the order was cancelled, and the stock is no longer available (${err.message}). Refund the customer from the Razorpay dashboard.` },
      { new: true },
    ).lean()
  }
}

/** Record a failed attempt — the order stays pending so the customer can retry */
export async function recordPaymentFailure(razorpayOrderId, reason) {
  await Order.updateOne(
    { 'payment.razorpayOrderId': razorpayOrderId, paymentStatus: { $ne: 'paid' } },
    { $set: { 'payment.lastError': String(reason ?? 'Payment failed').slice(0, 300) } },
  )
}

/**
 * Cancel online-payment orders still unpaid after PAYMENT_WINDOW_MINUTES,
 * releasing their reserved stock. Returns how many were cancelled.
 */
export async function expireUnpaidOrders(now = new Date()) {
  const cutoff = new Date(now.getTime() - PAYMENT_WINDOW_MINUTES * 60 * 1000)

  const stale = await Order.find({
    status:                    'pending',
    paymentStatus:             'pending',
    'payment.razorpayOrderId': { $exists: true },
    createdAt:                 { $lt: cutoff },
  }).lean()

  let cancelled = 0
  for (const order of stale) {
    try {
      // Claim it first — skipped if a payment landed or staff changed it meanwhile
      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, status: 'pending', paymentStatus: 'pending' },
        { $set: { status: 'cancelled', 'payment.note': `Cancelled automatically — not paid within ${PAYMENT_WINDOW_MINUTES} minutes.` } },
        { new: true },
      ).lean()
      if (!claimed) continue

      const stockState = await stockForStatusChange(claimed, 'cancelled', 'system')
      if (stockState) await Order.updateOne({ _id: order._id }, { $set: { stockState } })
      cancelled += 1
    } catch (err) {
      console.error(`[payments] couldn't expire ${order.orderNumber}:`, err.message)
    }
  }
  return cancelled
}
