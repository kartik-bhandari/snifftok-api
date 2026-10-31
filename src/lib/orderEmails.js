/**
 * src/lib/orderEmails.js
 * Customer emails about their order.
 *
 *   paid + confirmed → "Order confirmed" with items, totals and delivery address
 *   paid, but the order had expired and stock sold out → "Payment received —
 *   we'll refund you" (the order carries a refund note for staff)
 *
 * Each order is emailed at most once (Order.confirmationEmailAt is claimed
 * before sending), so the checkout callback and the webhook can't double-send.
 */

import { Order } from '../models/Order.js'
import { config } from '../config/index.js'
import { sendEmail } from './mailer.js'

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const variantLabel = (item) => `${item.sizeMl}ml${item.variantType === 'tester' ? ' decant' : ''}`

const ordersUrl = () => `${config.storefrontUrl}/orders`

/** Subject, text and HTML for an order that's been paid. Exported for tests and previews. */
export function buildOrderEmail(order) {
  const refund   = order.status === 'cancelled'
  const name     = order.customer.name.split(' ')[0]
  const a        = order.address
  const address  = [a.line1, [a.city, a.state].filter(Boolean).join(', '), a.pincode].filter(Boolean)

  const subject = refund
    ? `Payment received for ${order.orderNumber} — refund on its way`
    : `Order confirmed — ${order.orderNumber}`

  const headline = refund ? 'We’ll refund your payment' : 'Your order is confirmed'
  const intro = refund
    ? `Hi ${name}, your payment for order ${order.orderNumber} came in after the order had expired, and an item in it has since sold out. We’re refunding the full ${rupees(order.total)} to your original payment method — it usually shows up in 5–7 working days.`
    : `Hi ${name}, thank you for shopping with snifftok. We’ve received your payment and we’re getting your order ready. We’ll email you the tracking details once it ships.`

  const text = [
    headline,
    '',
    intro,
    '',
    `Order ${order.orderNumber}`,
    ...order.items.map(i => `  ${i.quantity} × ${i.name} (${variantLabel(i)}) — ${rupees(i.lineTotal)}`),
    '',
    `Subtotal: ${rupees(order.subtotal)}`,
    `Delivery: ${order.shippingAmount ? rupees(order.shippingAmount) : 'Free'}`,
    `Total paid: ${rupees(order.total)}`,
    '',
    ...(refund ? [] : ['Delivering to:', `  ${order.customer.name}`, ...address.map(l => `  ${l}`), `  ${order.customer.phone}`, '']),
    `View your orders: ${ordersUrl()}`,
    '',
    '— The snifftok team',
  ].join('\n')

  const itemRows = order.items.map(i => `
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid #F0F0F0;font-size:14px;color:#0A0A0A">
              ${esc(i.name)}
              <div style="font-size:12px;color:#8A8A8A;margin-top:2px">${esc(variantLabel(i))} · Qty ${i.quantity}</div>
            </td>
            <td align="right" style="padding:10px 0;border-bottom:1px solid #F0F0F0;font-size:14px;color:#0A0A0A;white-space:nowrap">${rupees(i.lineTotal)}</td>
          </tr>`).join('')

  const totalRow = (label, value, strong = false) => `
          <tr>
            <td style="padding:4px 0;font-size:${strong ? 15 : 13}px;color:${strong ? '#0A0A0A' : '#666666'};${strong ? 'font-weight:700' : ''}">${label}</td>
            <td align="right" style="padding:4px 0;font-size:${strong ? 15 : 13}px;color:#0A0A0A;${strong ? 'font-weight:700' : ''}">${value}</td>
          </tr>`

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">
          <tr>
            <td align="center" style="padding:32px 32px 0">
              <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:0.12em;color:#0A0A0A">snifftok</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px">
              <p style="margin:0 0 8px;font-size:20px;color:#0A0A0A;font-weight:700">${headline}</p>
              <p style="margin:0;font-size:14px;color:#666666;line-height:1.6">${esc(intro)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 0">
              <div style="background:#F5F5F5;border-radius:12px;padding:12px 16px">
                <p style="margin:0;font-size:11px;color:#8A8A8A;text-transform:uppercase;letter-spacing:0.08em;font-weight:600">Order number</p>
                <p style="margin:2px 0 0;font-size:16px;color:#0A0A0A;font-weight:700">${esc(order.orderNumber)}</p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 0">
              <table width="100%" cellpadding="0" cellspacing="0">${itemRows}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 0">
              <table width="100%" cellpadding="0" cellspacing="0">${totalRow('Subtotal', rupees(order.subtotal))}${totalRow('Delivery', order.shippingAmount ? rupees(order.shippingAmount) : 'Free')}${totalRow('Total paid', rupees(order.total), true)}
              </table>
            </td>
          </tr>${refund ? '' : `
          <tr>
            <td style="padding:20px 32px 0">
              <p style="margin:0 0 6px;font-size:11px;color:#8A8A8A;text-transform:uppercase;letter-spacing:0.08em;font-weight:600">Delivering to</p>
              <p style="margin:0;font-size:13px;color:#0A0A0A;line-height:1.6">
                ${esc(order.customer.name)}<br>${address.map(esc).join('<br>')}<br>${esc(order.customer.phone)}
              </p>
            </td>
          </tr>`}
          <tr>
            <td align="center" style="padding:28px 32px 8px">
              <a href="${esc(ordersUrl())}" style="display:inline-block;background:#0A0A0A;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:12px 28px;border-radius:999px">View your orders</a>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 32px">
              <p style="margin:0;font-size:12px;color:#999999;line-height:1.5;text-align:center">
                Questions about your order? Message us on WhatsApp — just mention your order number.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject, text, html }
}

/**
 * Email the customer about a paid order — once. Never throws: a failed email
 * must not undo a payment. Returns true if this call sent it.
 */
export async function sendOrderPaidEmail(order) {
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, confirmationEmailAt: { $exists: false } },
    { $set: { confirmationEmailAt: new Date() } },
    { new: true },
  ).lean()
  if (!claimed) return false

  try {
    await sendEmail({ to: claimed.customer.email, ...buildOrderEmail(claimed) })
    return true
  } catch (err) {
    console.error(`[orders] confirmation email for ${claimed.orderNumber} failed:`, err.message)
    // Let a later payment report (e.g. the webhook) try again
    await Order.updateOne({ _id: claimed._id }, { $unset: { confirmationEmailAt: '' } }).catch(() => {})
    return false
  }
}
