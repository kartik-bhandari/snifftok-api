/**
 * src/lib/razorpay.js
 * Razorpay client and signature checks — the only file that talks to Razorpay.
 *
 * Env (API .env / Render):
 *   RAZORPAY_KEY_ID          rzp_test_… or rzp_live_…  (also sent to the browser)
 *   RAZORPAY_KEY_SECRET      server only
 *   RAZORPAY_WEBHOOK_SECRET  the secret set on the webhook in the Razorpay dashboard
 *
 * Without the key id + secret, online payment is off: orders are created as
 * before (pending, confirmed manually in the admin).
 */

import crypto from 'crypto'
import Razorpay from 'razorpay'

let client = null

export function razorpayEnabled() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
}

export function razorpayKeyId() {
  return process.env.RAZORPAY_KEY_ID
}

function getClient() {
  if (!client) {
    client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  }
  return client
}

/** Create a Razorpay order for `amount` paise. Returns Razorpay's order object. */
export function createRazorpayOrder({ amount, receipt, notes }) {
  return getClient().orders.create({ amount, currency: 'INR', receipt, notes })
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** Checkout success callback: HMAC-SHA256(order_id|payment_id, key secret) */
export function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET ?? '')
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex')
  return safeEqualHex(expected, signature)
}

/** Webhook: HMAC-SHA256(raw request body, webhook secret) */
export function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  return safeEqualHex(expected, signature)
}
