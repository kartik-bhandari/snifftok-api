/**
 * src/tests/payments.test.js
 * Server-side pricing + Razorpay: create, verify, webhook, retry, expiry.
 * The Razorpay SDK is mocked — no network calls.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'crypto'
import mongoose from 'mongoose'
import request from 'supertest'
import { Order } from '../models/Order.js'
import { Product } from '../models/Product.js'
import app from '../app.js'
import { expireUnpaidOrders } from '../lib/payments.js'
import { customerCookie } from './fixtures/customer.js'
import { buildOrderEmail } from '../lib/orderEmails.js'

const rzpCreate = vi.fn(async ({ amount, receipt }) => ({ id: `order_rzp_${receipt}`, amount, currency: 'INR' }))
const sendEmail = vi.fn(async () => {})
vi.mock('../lib/mailer.js', () => ({ sendEmail: (...a) => sendEmail(...a) }))

vi.mock('razorpay', () => ({ default: class { constructor() { this.orders = { create: (...a) => rzpCreate(...a) } } } }))

const ENV = { RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'test_secret', RAZORPAY_WEBHOOK_SECRET: 'hook_secret' }
const saved = {}
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v } })
afterAll(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

const sign = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('hex')

let shopper
beforeEach(async () => {
  rzpCreate.mockClear()
  sendEmail.mockReset().mockResolvedValue()
  shopper = await customerCookie()
  await Product.create({
    name: 'Oud Royale',
    variants: [
      { type: 'bottle', sizeMl: 50, sku: 'OUD-50', costPrice: 150000, minProfit: 30000, stock: 5,
        pricing: { unitPriceExclDelivery: 249900, calculatedAt: new Date() } },
      { type: 'tester', sizeMl: 2, sku: 'OUD-2T', costPrice: 10000, minProfit: 5000, stock: 10,
        pricing: { unitPriceExclDelivery: 29900, calculatedAt: new Date() } },
    ],
  })
})

const variant = async (sku) => {
  const p = await Product.findOne({ 'variants.sku': sku }).lean()
  const v = p.variants.find(x => x.sku === sku)
  return { stock: v.stock, reserved: v.reserved }
}

const place = (items, cookie = shopper) => request(app)
  .post('/api/storefront/orders')
  .set('Cookie', cookie ?? '')
  .set('Content-Type', 'application/json').set('X-Requested-With', 'snifftok-web')
  .send({
    customer: { name: 'Riya', email: 'riya@test.com', phone: '9876543210' },
    address:  { line1: '1 MG Road', pincode: '560001' },
    items,
    subtotal: 1, shippingAmount: 0, total: 1,   // tampered — must be ignored
  })

const bottle = (qty, extra = {}) => ({ name: 'Oud Royale', sku: 'OUD-50', variantType: 'bottle', sizeMl: 50, quantity: qty, unitPrice: 100, lineTotal: 100, ...extra })
const decant = (qty) => ({ name: 'Oud Royale', sku: 'OUD-2T', variantType: 'tester', sizeMl: 2, quantity: qty, unitPrice: 1 })

const verify = (orderId, rzpOrderId, paymentId = 'pay_123', signature) => request(app)
  .post(`/api/storefront/orders/${orderId}/verify-payment`)
  .set('Content-Type', 'application/json').set('X-Requested-With', 'snifftok-web')
  .send({
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature ?? sign(`${rzpOrderId}|${paymentId}`, ENV.RAZORPAY_KEY_SECRET),
  })

const webhook = (event, { secret = ENV.RAZORPAY_WEBHOOK_SECRET } = {}) => {
  const raw = JSON.stringify(event)
  return request(app).post('/api/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', sign(raw, secret))
    .send(raw)
}

// ─────────────────────────────────────────────────────────────────────────────
describe('Server-side pricing', () => {
  it('ignores client prices: catalogue price × qty + ₹80 per bottle + ₹80 per 5 decants', async () => {
    const res = await place([bottle(2), decant(6)])
    expect(res.status).toBe(201)
    const order = await Order.findById(res.body.orderId).lean()
    expect(order.items.map(i => [i.unitPrice, i.lineTotal])).toEqual([[249900, 499800], [29900, 179400]])
    expect(order.subtotal).toBe(499800 + 179400)
    expect(order.shippingAmount).toBe(2 * 8000 + 2 * 8000)   // 2 bottles + ceil(6/5) decant slabs
    expect(order.total).toBe(order.subtotal + order.shippingAmount)
    expect(res.body.total).toBe(order.total)
  })

  it('rejects bad quantities and archived products', async () => {
    expect((await place([bottle(0)])).status).toBe(400)
    expect((await place([bottle(1.5)])).status).toBe(400)
    await Product.updateOne({ name: 'Oud Royale' }, { isActive: false })
    expect((await place([bottle(1)])).status).toBe(400)
  })
})

describe('Razorpay checkout', () => {
  it('creates a Razorpay order for the server total and returns checkout details', async () => {
    const res = await place([bottle(1)])
    expect(res.status).toBe(201)
    expect(res.body.razorpay).toEqual({ keyId: 'rzp_test_key', orderId: expect.stringMatching(/^order_rzp_/), amount: 249900 + 8000, currency: 'INR' })
    expect(rzpCreate).toHaveBeenCalledWith(expect.objectContaining({ amount: 257900, currency: 'INR' }))

    const order = await Order.findById(res.body.orderId).lean()
    expect(order).toMatchObject({ status: 'pending', paymentStatus: 'pending', stockState: 'reserved' })
    expect(order.payment.razorpayOrderId).toBe(res.body.razorpay.orderId)
  })

  it('a verified payment marks the order paid, confirms it and deducts the stock', async () => {
    const { body } = await place([bottle(2)])
    const res = await verify(body.orderId, body.razorpay.orderId)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' })
    expect(await variant('OUD-50')).toEqual({ stock: 3, reserved: 0 })

    const order = await Order.findById(body.orderId).lean()
    expect(order.payment).toMatchObject({ razorpayPaymentId: 'pay_123', paidAt: expect.any(Date) })
  })

  it('rejects a bad signature or someone else’s Razorpay order', async () => {
    const { body } = await place([bottle(1)])
    expect((await verify(body.orderId, body.razorpay.orderId, 'pay_1', 'deadbeef')).status).toBe(400)
    expect((await verify(body.orderId, 'order_rzp_OTHER')).status).toBe(400)
    expect((await Order.findById(body.orderId).lean()).paymentStatus).toBe('pending')
  })

  it('verify + webhook for the same payment only deduct stock once', async () => {
    const { body } = await place([bottle(2)])
    await verify(body.orderId, body.razorpay.orderId)
    const hook = await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_123', order_id: body.razorpay.orderId, method: 'upi' } } } })
    expect(hook.status).toBe(200)
    await verify(body.orderId, body.razorpay.orderId)
    expect(await variant('OUD-50')).toEqual({ stock: 3, reserved: 0 })
  })

  it('the webhook alone confirms the order (shopper closed the tab)', async () => {
    const { body } = await place([bottle(1)])
    const res = await webhook({ event: 'order.paid', payload: { order: { entity: { id: body.razorpay.orderId } }, payment: { entity: { id: 'pay_9', order_id: body.razorpay.orderId, method: 'card' } } } })
    expect(res.status).toBe(200)
    const order = await Order.findById(body.orderId).lean()
    expect(order).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' })
    expect(order.payment.method).toBe('card')
  })

  it('webhooks with a wrong signature are refused', async () => {
    const { body } = await place([bottle(1)])
    const res = await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'x', order_id: body.razorpay.orderId } } } }, { secret: 'wrong' })
    expect(res.status).toBe(400)
    expect((await Order.findById(body.orderId).lean()).paymentStatus).toBe('pending')
  })

  it('a failed payment is recorded and the shopper can retry with the same Razorpay order', async () => {
    const { body } = await place([bottle(1)])
    await webhook({ event: 'payment.failed', payload: { payment: { entity: { order_id: body.razorpay.orderId, error_description: 'Card declined' } } } })
    const order = await Order.findById(body.orderId).lean()
    expect(order).toMatchObject({ status: 'pending', paymentStatus: 'pending' })
    expect(order.payment.lastError).toBe('Card declined')

    const retry = await request(app).post(`/api/storefront/orders/${body.orderId}/pay`).set('Cookie', shopper).set('X-Requested-With', 'snifftok-web')
    expect(retry.status).toBe(200)
    expect(retry.body.razorpay.orderId).toBe(body.razorpay.orderId)
    expect(rzpCreate).toHaveBeenCalledTimes(1)
  })

  it('if Razorpay is down the order is cancelled and its stock released', async () => {
    rzpCreate.mockRejectedValueOnce(new Error('timeout'))
    const res = await place([bottle(2)])
    expect(res.status).toBe(502)
    expect(await variant('OUD-50')).toEqual({ stock: 5, reserved: 0 })
    expect((await Order.findOne().lean()).status).toBe('cancelled')
  })
})

describe('Signed-in checkout', () => {
  it('refuses guests, holding no stock', async () => {
    const res = await place([bottle(1)], null)
    expect(res.status).toBe(401)
    expect(await Order.countDocuments()).toBe(0)
    expect(await variant('OUD-50')).toEqual({ stock: 5, reserved: 0 })
  })

  it('links the order to the account, and only its owner can retry the payment', async () => {
    const { body } = await place([bottle(1)])
    const order = await Order.findById(body.orderId).lean()
    expect(order.userId).toBeTruthy()

    const pay = (cookie) => request(app).post(`/api/storefront/orders/${body.orderId}/pay`)
      .set('Cookie', cookie).set('X-Requested-With', 'snifftok-web')
    expect((await pay(await customerCookie('someone@test.com'))).status).toBe(404)
    expect((await pay(shopper)).status).toBe(200)
  })
})

describe('Prepaid only', () => {
  const admin = async () => {
    const { User } = await import('../models/User.js')
    const { signToken } = await import('../lib/jwt.js')
    const u = await User.create({ email: 'admin@test.com', name: 'Admin', role: 'admin', sessionVersion: 1, isActive: true })
    return signToken({ sub: u._id.toString(), role: 'admin', v: 1 })
  }

  it('refuses checkout when online payment is off, holding no stock', async () => {
    delete process.env.RAZORPAY_KEY_ID
    try {
      const res = await place([bottle(1)])
      expect(res.status).toBe(503)
    } finally {
      process.env.RAZORPAY_KEY_ID = ENV.RAZORPAY_KEY_ID
    }
    expect(await Order.countDocuments()).toBe(0)
    expect(await variant('OUD-50')).toEqual({ stock: 5, reserved: 0 })
  })

  it('hides unpaid orders from staff, the dashboard and customer lookup until paid', async () => {
    const token = await admin()
    const adminGet = (path) => request(app).get(path).set('X-Requested-With', 'snifftok-admin').set('Authorization', `Bearer ${token}`)
    const unpaid = (await place([bottle(1)])).body
    const paid   = (await place([bottle(1)])).body
    await verify(paid.orderId, paid.razorpay.orderId)

    const list = await adminGet('/api/admin/orders')
    expect(list.body.data.map(o => o.orderNumber)).toEqual([paid.orderNumber])

    const summary = await adminGet('/api/admin/dashboard/summary?period=7d')
    expect(summary.body.orders).toBe(1)

    const lookup = (n) => request(app).get(`/api/storefront/orders/lookup?email=riya@test.com&orderNumber=${n}`)
    expect((await lookup(unpaid.orderNumber)).status).toBe(404)
    expect((await lookup(paid.orderNumber)).status).toBe(200)

    const change = await request(app).patch(`/api/admin/orders/${unpaid.orderId}/status`)
      .set('Content-Type', 'application/json').set('X-Requested-With', 'snifftok-admin').set('Authorization', `Bearer ${token}`)
      .send({ status: 'confirmed' })
    expect(change.status).toBe(409)
  })
})

describe('Unpaid orders', () => {
  // Raw driver: cast the id ourselves (it doesn't convert strings)
  const age = (id, hours) => Order.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(id)) },
    { $set: { createdAt: new Date(Date.now() - hours * 3600_000) } },
  )

  it('are cancelled after 30 minutes and their stock released; paid and recent ones are left alone', async () => {
    const stale  = (await place([bottle(2)])).body
    const fresh  = (await place([bottle(1)])).body
    const paid   = (await place([bottle(1)])).body
    await verify(paid.orderId, paid.razorpay.orderId)
    await age(stale.orderId, 0.6); await age(paid.orderId, 0.6); await age(fresh.orderId, 0.4)

    expect(await expireUnpaidOrders()).toBe(1)
    expect(await Order.findById(stale.orderId).lean()).toMatchObject({ status: 'cancelled', stockState: 'released' })
    expect((await Order.findById(fresh.orderId).lean()).status).toBe('pending')
    expect((await Order.findById(paid.orderId).lean()).status).toBe('confirmed')
    expect(await variant('OUD-50')).toEqual({ stock: 4, reserved: 1 })   // paid deducted 1, fresh still holds 1

    const retry = await request(app).post(`/api/storefront/orders/${stale.orderId}/pay`).set('Cookie', shopper).set('X-Requested-With', 'snifftok-web')
    expect(retry.status).toBe(409)
  })

  it('a payment after expiry re-confirms if stock is still there, otherwise flags a refund', async () => {
    const a = (await place([bottle(1)])).body
    await age(a.orderId, 25)
    await expireUnpaidOrders()
    await verify(a.orderId, a.razorpay.orderId, 'pay_late')
    expect(await Order.findById(a.orderId).lean()).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' })

    const b = (await place([bottle(1)])).body
    await age(b.orderId, 25)
    await expireUnpaidOrders()
    await place([bottle(4)])                                    // the rest sells meanwhile
    const late = await verify(b.orderId, b.razorpay.orderId, 'pay_late2')
    expect(late.body).toMatchObject({ paymentStatus: 'paid', status: 'cancelled', needsAttention: true })
    expect((await Order.findById(b.orderId).lean()).payment.note).toMatch(/Refund/)
  })
})

describe('Order confirmation email', () => {
  const sent = () => sendEmail.mock.calls.map(([m]) => m)
  const captured = (rzpOrderId, id = 'pay_123') =>
    webhook({ event: 'payment.captured', payload: { payment: { entity: { id, order_id: rzpOrderId, method: 'upi' } } } })

  it('is sent once the payment is verified — and only once with the webhook too', async () => {
    const { body } = await place([bottle(2), decant(1)])
    await verify(body.orderId, body.razorpay.orderId)
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    await captured(body.razorpay.orderId)
    await verify(body.orderId, body.razorpay.orderId)
    await new Promise(r => setTimeout(r, 50))

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const [mail] = sent()
    expect(mail.to).toBe('riya@test.com')
    expect(mail.subject).toBe(`Order confirmed — ${body.orderNumber}`)
    expect(mail.text).toContain('2 × Oud Royale (50ml) — ₹4,998')
    expect(mail.text).toContain('1 × Oud Royale (2ml decant) — ₹299')
    expect(mail.text).toContain('Total paid: ₹5,537')
    expect(mail.html).toContain('1 MG Road')
    expect((await Order.findById(body.orderId).lean()).confirmationEmailAt).toBeInstanceOf(Date)
  })

  it('is not sent for unpaid orders', async () => {
    await place([bottle(1)])
    await new Promise(r => setTimeout(r, 50))
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('a failed send is retried by the next payment report, and never blocks the payment', async () => {
    sendEmail.mockRejectedValueOnce(new Error('Resend down'))
    const { body } = await place([bottle(1)])
    const res = await verify(body.orderId, body.razorpay.orderId)
    expect(res.body.status).toBe('confirmed')
    await vi.waitFor(async () => expect((await Order.findById(body.orderId).lean()).confirmationEmailAt).toBeUndefined())

    await captured(body.razorpay.orderId)
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => expect((await Order.findById(body.orderId).lean()).confirmationEmailAt).toBeInstanceOf(Date))
  })

  it('tells the customer about the refund when a late payment can’t be fulfilled', () => {
    const mail = buildOrderEmail({
      orderNumber: 'ORD-1', status: 'cancelled', total: 258000, subtotal: 250000, shippingAmount: 8000,
      customer: { name: 'Riya Sharma', email: 'riya@test.com', phone: '9876543210' },
      address: { line1: '1 MG Road', pincode: '560001' },
      items: [{ name: 'Oud Royale', sizeMl: 50, variantType: 'bottle', quantity: 1, lineTotal: 250000 }],
    })
    expect(mail.subject).toBe('Payment received for ORD-1 — refund on its way')
    expect(mail.text).toMatch(/refunding the full ₹2,580/)
    expect(mail.text).not.toContain('Delivering to')
  })

  it('escapes customer-supplied text in the HTML', () => {
    const mail = buildOrderEmail({
      orderNumber: 'ORD-2', status: 'confirmed', total: 100, subtotal: 100, shippingAmount: 0,
      customer: { name: '<script>x</script>', email: 'a@b.c', phone: '1' },
      address: { line1: '<img src=x onerror=alert(1)>', pincode: '1' },
      items: [{ name: 'A & B', sizeMl: 2, variantType: 'tester', quantity: 1, lineTotal: 100 }],
    })
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).not.toContain('<img')
    expect(mail.html).toContain('A &amp; B')
  })
})
