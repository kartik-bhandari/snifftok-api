/**
 * src/tests/orderStock.test.js
 * Orders keep stock in step: reserve on placement, deduct on confirm,
 * release / restock on cancel, re-take when reopened.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import { User } from '../models/User.js'
import { Order } from '../models/Order.js'
import { Product } from '../models/Product.js'
import { StockMovement } from '../models/StockMovement.js'
import app from '../app.js'
import { signToken } from '../lib/jwt.js'
import { customerCookie } from './fixtures/customer.js'

// Checkout needs online payment switched on — Razorpay is mocked, no network calls
vi.mock('razorpay', () => ({ default: class { constructor() { this.orders = { create: async ({ amount, receipt }) => ({ id: `order_rzp_${receipt}`, amount }) } } } }))
const RZP_ENV = { RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'test_secret' }
beforeAll(() => Object.assign(process.env, RZP_ENV))
afterAll(() => { for (const k of Object.keys(RZP_ENV)) delete process.env[k] })

let admin, shopper
beforeEach(async () => {
  shopper = await customerCookie()
  const user = await User.create({ email: 'admin@test.com', name: 'Admin', role: 'admin', sessionVersion: 1, isActive: true })
  admin = signToken({ sub: user._id.toString(), role: 'admin', v: 1 })
  await Product.create({
    name: 'Oud Royale',
    variants: [
      { type: 'bottle', sizeMl: 50, sku: 'OUD-50', costPrice: 100000, minProfit: 20000, stock: 5 },
      { type: 'tester', sizeMl: 2,  sku: 'OUD-2T', costPrice: 10000,  minProfit: 5000,  stock: 1 },
    ],
  })
})

const variant = async (sku) => {
  const p = await Product.findOne({ 'variants.sku': sku }).lean()
  const v = p.variants.find(x => x.sku === sku)
  return { stock: v.stock, reserved: v.reserved, available: v.stock - v.reserved }
}

const line = (qty, extra = {}) => ({
  name: 'Oud Royale', sku: 'OUD-50', variantType: 'bottle', sizeMl: 50,
  unitPrice: 150000, quantity: qty, lineTotal: 150000 * qty, ...extra,
})

const placeOrder = (items) => request(app)
  .post('/api/storefront/orders')
  .set('Cookie', shopper)
  .set('Content-Type', 'application/json')
  .set('X-Requested-With', 'snifftok-web')
  .send({
    customer: { name: 'Riya', email: 'riya@test.com', phone: '9876543210' },
    address:  { line1: '1 MG Road', pincode: '560001' },
    items, subtotal: 1, shippingAmount: 0, total: 1,
  })

const setStatus = (id, status) => request(app)
  .patch(`/api/admin/orders/${id}/status`)
  .set('Content-Type', 'application/json').set('X-Requested-With', 'snifftok-admin')
  .set('Authorization', `Bearer ${admin}`)
  .send({ status })

// ─────────────────────────────────────────────────────────────────────────────
describe('Placing an order', () => {
  it('reserves the stock (available drops) and logs it against the order', async () => {
    const res = await placeOrder([line(2)])
    expect(res.status).toBe(201)

    expect(await variant('OUD-50')).toEqual({ stock: 5, reserved: 2, available: 3 })
    const order = await Order.findById(res.body.orderId).lean()
    expect(order.stockState).toBe('reserved')
    expect(String(order.items[0].variantId)).toBeTruthy()

    const mv = await StockMovement.find({ orderId: order._id }).lean()
    expect(mv).toEqual([expect.objectContaining({ sku: 'OUD-50', field: 'reserved', delta: 2, reason: 'web_order_reserved' })])
  })

  it('matches older carts without a SKU (name + size)', async () => {
    const res = await placeOrder([line(1, { sku: undefined })])
    expect(res.status).toBe(201)
    expect((await variant('OUD-50')).reserved).toBe(1)
  })

  it('refuses when there is not enough, and reserves nothing', async () => {
    const res = await placeOrder([line(2), line(2, { sku: 'OUD-2T', variantType: 'tester', sizeMl: 2 })])   // only 1 decant
    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/Only 1 of Oud Royale \(2ml decant\) left/)
    expect(res.body.outOfStock).toBe(true)

    expect(await variant('OUD-50')).toEqual({ stock: 5, reserved: 0, available: 5 })   // first line rolled back
    expect(await Order.countDocuments()).toBe(0)
  })

  it('sums quantities of the same variant across lines', async () => {
    const res = await placeOrder([line(3), line(3)])   // 6 > 5
    expect(res.status).toBe(409)
    expect((await variant('OUD-50')).reserved).toBe(0)
  })

  it('rejects items that match no product', async () => {
    const res = await placeOrder([line(1, { name: 'Ghost', sku: 'NOPE' })])
    expect(res.status).toBe(400)
  })
})

describe('Changing order status', () => {
  let orderId
  beforeEach(async () => {
    orderId = (await placeOrder([line(2)])).body.orderId
    // Paid but still pending — staff move it from here
    await Order.updateOne({ _id: orderId }, { paymentStatus: 'paid' })
  })

  it('confirming deducts the reservation from stock', async () => {
    const res = await setStatus(orderId, 'confirmed')
    expect(res.status).toBe(200)
    expect(res.body.stockState).toBe('deducted')
    expect(await variant('OUD-50')).toEqual({ stock: 3, reserved: 0, available: 3 })

    // Later statuses don't touch stock again
    await setStatus(orderId, 'shipped')
    await setStatus(orderId, 'delivered')
    expect(await variant('OUD-50')).toEqual({ stock: 3, reserved: 0, available: 3 })
  })

  it('cancelling a pending order releases the reservation', async () => {
    const res = await setStatus(orderId, 'cancelled')
    expect(res.body.stockState).toBe('released')
    expect(await variant('OUD-50')).toEqual({ stock: 5, reserved: 0, available: 5 })
  })

  it('cancelling after confirming puts the units back', async () => {
    await setStatus(orderId, 'confirmed')
    const res = await setStatus(orderId, 'cancelled')
    expect(res.body.stockState).toBe('restocked')
    expect(await variant('OUD-50')).toEqual({ stock: 5, reserved: 0, available: 5 })

    const reasons = (await StockMovement.find({ orderId }).sort({ createdAt: 1 }).lean()).map(m => `${m.reason}:${m.field}:${m.delta}`)
    expect(reasons).toEqual([
      'web_order_reserved:reserved:2',
      'order_confirmed:stock:-2', 'order_confirmed:reserved:-2',
      'cancelled:stock:2',
    ])
  })

  it('reopening a cancelled order takes the stock again — if it is still there', async () => {
    await setStatus(orderId, 'cancelled')
    const ok = await setStatus(orderId, 'confirmed')
    expect(ok.body.stockState).toBe('deducted')
    expect(await variant('OUD-50')).toEqual({ stock: 3, reserved: 0, available: 3 })

    // Cancel again, sell the rest elsewhere, then try to reopen
    await setStatus(orderId, 'cancelled')                                   // back to 5
    await placeOrder([line(5)])                                             // reserves all 5
    const blocked = await setStatus(orderId, 'pending')
    expect(blocked.status).toBe(409)
    expect(blocked.body.message).toMatch(/out of stock/)
    expect((await Order.findById(orderId).lean()).status).toBe('cancelled')  // unchanged
  })

  it('orders placed before stock tracking never touch stock', async () => {
    const legacy = await Order.create({
      orderNumber: 'OLD-1',
      customer: { name: 'Riya', email: 'riya@test.com', phone: '9876543210' },
      address:  { line1: '1 MG Road', pincode: '560001' },
      items: [line(4)], subtotal: 1, shippingAmount: 0, total: 1,
    })
    const before = await variant('OUD-50')
    await setStatus(legacy._id, 'confirmed')
    await setStatus(legacy._id, 'cancelled')
    expect(await variant('OUD-50')).toEqual(before)
  })
})
