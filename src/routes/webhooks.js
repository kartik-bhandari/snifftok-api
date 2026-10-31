/**
 * src/routes/webhooks.js
 * POST /api/webhooks/razorpay — Razorpay server-to-server events.
 *
 * Mounted with express.raw() BEFORE the JSON body parser: the signature is an
 * HMAC of the exact raw body. Backs up the checkout callback (e.g. the shopper
 * closed the tab right after paying).
 *
 * Dashboard setup: Settings → Webhooks → URL https://<api>/api/webhooks/razorpay,
 * secret = RAZORPAY_WEBHOOK_SECRET, events: payment.captured, order.paid, payment.failed.
 */

import { verifyWebhookSignature } from '../lib/razorpay.js'
import { markOrderPaid, recordPaymentFailure } from '../lib/payments.js'

export async function razorpayWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('')
  if (!verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ message: 'Invalid signature.' })
  }

  let event
  try {
    event = JSON.parse(raw.toString('utf8'))
  } catch {
    return res.status(400).json({ message: 'Invalid JSON.' })
  }

  try {
    const payment = event.payload?.payment?.entity
    const razorpayOrderId = payment?.order_id ?? event.payload?.order?.entity?.id

    switch (event.event) {
      case 'payment.captured':
      case 'order.paid':
        if (razorpayOrderId) await markOrderPaid(razorpayOrderId, { paymentId: payment?.id, method: payment?.method })
        break
      case 'payment.failed':
        if (razorpayOrderId) await recordPaymentFailure(razorpayOrderId, payment?.error_description)
        break
      default:
        break   // not subscribed / not needed
    }
    res.json({ ok: true })
  } catch (err) {
    // 500 makes Razorpay retry later
    console.error('[webhooks/razorpay]', event?.event, err)
    res.status(500).json({ message: 'Failed to process event.' })
  }
}
