/**
 * src/tests/dashboard.test.js
 * Integration tests for /api/admin/dashboard/* and unit-cost handling on orders.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { User } from '../models/User.js'
import { Order } from '../models/Order.js'
import { Product } from '../models/Product.js'
import app from '../app.js'
import { signToken } from '../lib/jwt.js'

const DAY = 24 * 60 * 60 * 1000

// ── Helpers ───────────────────────────────────────────────────────────────────

async function tokenFor(role) {
  const user = await User.create({
    email: `${role}@test.com`, name: role, role, sessionVersion: 1, isActive: true,
  })
  return signToken({ sub: user._id.toString(), role, v: 1 })
}

const get = (path, token) =>
  request(app)
    .get(path)
    .set('X-Requested-With', 'snifftok-admin')
    .set('Authorization', `Bearer ${token}`)

/** Product with one bottle (cost ₹1,000) and one tester (cost ₹100, low stock) */
function createProduct() {
  return Product.create({
    name: 'Oud Royale', brand: 'Snifftok',
    variants: [
      { type: 'bottle', sizeMl: 50, sku: 'OUD-50', costPrice: 100000, minProfit: 20000, stock: 20 },
      { type: 'tester', sizeMl: 2,  sku: 'OUD-2T', costPrice: 10000,  minProfit: 5000,  stock: 2, reorderLevel: 3 },
    ],
  })
}

let orderSeq = 0
/** Insert an order directly, with a chosen createdAt */
async function createOrder({ items, status = 'confirmed', channel = 'web', createdAt = new Date() }) {
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0)
  const order = await Order.create({
    orderNumber: `TEST-${++orderSeq}`,
    customer: { name: 'Riya', email: 'riya@test.com', phone: '9876543210' },
    address:  { line1: '1 MG Road', pincode: '560001' },
    items, subtotal, shippingAmount: 0, total: subtotal, status, channel,
  })
  // Bypass timestamps so the order lands in the period we want
  await Order.collection.updateOne({ _id: order._id }, { $set: { createdAt } })
  return order
}

const bottle = (qty, extra = {}) => ({
  name: 'Oud Royale', sku: 'OUD-50', variantType: 'bottle', sizeMl: 50,
  unitPrice: 150000, quantity: qty, lineTotal: 150000 * qty, ...extra,
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/dashboard/summary', () => {
  let adminToken

  beforeEach(async () => {
    adminToken = await tokenFor('admin')
    await createProduct()
  })

  it('totals revenue, orders, units and AOV — cancelled orders excluded', async () => {
    await createOrder({ items: [bottle(1, { unitCost: 100000 })] })
    await createOrder({ items: [bottle(2, { unitCost: 100000 })], channel: 'whatsapp' })
    await createOrder({ items: [bottle(5, { unitCost: 100000 })], status: 'cancelled' })

    const res = await get('/api/admin/dashboard/summary?period=7d', adminToken)
    expect(res.status).toBe(200)
    expect(res.body.revenue).toBe(450000)
    expect(res.body.orders).toBe(2)
    expect(res.body.unitsSold).toBe(3)
    expect(res.body.aov).toBe(225000)
    expect(res.body.byChannel).toEqual({ web: 1, whatsapp: 1, admin: 0 })
    expect(res.body.chartData).toHaveLength(7)
  })

  it('uses the saved unitCost, falling back to current cost for older orders', async () => {
    await createOrder({ items: [bottle(1, { unitCost: 120000 })] })  // profit ₹300
    await createOrder({ items: [bottle(1)] })                         // no snapshot → current ₹1,000 → profit ₹500

    const res = await get('/api/admin/dashboard/summary?period=today', adminToken)
    expect(res.body.netProfit).toBe(30000 + 50000)
    expect(res.body.profitMissingCost).toBe(0)
    expect(res.body.bucket).toBe('hour')
  })

  it('finds the cost for storefront orders saved without a SKU (by product + size, then name + size)', async () => {
    const product = await Product.findOne({ name: 'Oud Royale' })
    // Old storefront checkout sent sku: "" and no productId
    await createOrder({ items: [bottle(1, { sku: '', productId: product._id })] })            // profit ₹500
    await createOrder({ items: [bottle(1, { sku: '', name: 'oud royale' })] })                // profit ₹500
    await createOrder({ items: [{
      name: 'Oud Royale', sku: '', variantType: 'tester', sizeMl: 2,
      unitPrice: 20000, quantity: 2, lineTotal: 40000,                                         // profit ₹200
    }] })

    const res = await get('/api/admin/dashboard/summary', adminToken)
    expect(res.body.profitMissingCost).toBe(0)
    expect(res.body.netProfit).toBe(50000 + 50000 + 20000)
  })

  it('flags lines whose cost cannot be found instead of counting them as pure profit', async () => {
    await createOrder({ items: [bottle(1, { sku: 'GONE-1', name: 'Deleted Perfume' })] })
    const res = await get('/api/admin/dashboard/summary', adminToken)
    expect(res.body.netProfit).toBe(0)
    expect(res.body.profitMissingCost).toBe(1)
  })

  it('compares with the previous period', async () => {
    await createOrder({ items: [bottle(1)] })
    await createOrder({ items: [bottle(2)], createdAt: new Date(Date.now() - 8 * DAY) })

    const res = await get('/api/admin/dashboard/summary?period=7d', adminToken)
    expect(res.body.revenue).toBe(150000)
    expect(res.body.previous.revenue).toBe(300000)
    expect(res.body.previous.orders).toBe(1)
  })

  it('ranks top products by revenue', async () => {
    await createOrder({ items: [
      bottle(2),
      { name: 'Oud Royale', sku: 'OUD-2T', variantType: 'tester', sizeMl: 2, unitPrice: 20000, quantity: 1, lineTotal: 20000 },
    ] })
    const res = await get('/api/admin/dashboard/summary', adminToken)
    expect(res.body.topProducts[0]).toMatchObject({ name: 'Oud Royale', unitsSold: 3, revenue: 320000 })
  })

  it('hides profit from staff', async () => {
    const staffToken = await tokenFor('staff')
    await createOrder({ items: [bottle(1, { unitCost: 100000 })] })

    const res = await get('/api/admin/dashboard/summary', staffToken)
    expect(res.status).toBe(200)
    expect(res.body.revenue).toBe(150000)
    expect(res.body.netProfit).toBeNull()
    expect(res.body.previous.netProfit).toBeNull()
    expect(res.body.chartData.every(p => p.netProfit === null)).toBe(true)
  })

  it('requires an admin or staff session', async () => {
    const customerToken = await tokenFor('customer')
    const res = await get('/api/admin/dashboard/summary', customerToken)
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/dashboard/attention', () => {
  it('lists pending orders (oldest first) and low-stock variants', async () => {
    const token = await tokenFor('admin')
    await createProduct()
    await createOrder({ items: [bottle(1)], status: 'pending' })
    const older = await createOrder({ items: [bottle(1)], status: 'pending', createdAt: new Date(Date.now() - DAY) })
    await createOrder({ items: [bottle(1)], status: 'shipped' })

    const res = await get('/api/admin/dashboard/attention', token)
    expect(res.status).toBe(200)

    const pending = res.body.items.filter(i => i.type === 'order_pending')
    expect(pending).toHaveLength(2)
    expect(pending[0].orderNumber).toBe(older.orderNumber)

    const low = res.body.items.filter(i => i.type === 'low_stock')
    expect(low).toEqual([expect.objectContaining({ sku: 'OUD-2T', availableStock: 2, variantLabel: 'Oud Royale 2ml Tester' })])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Order unit cost', () => {
  const orderBody = {
    customer: { name: 'Riya', email: 'riya@test.com', phone: '9876543210' },
    address:  { line1: '1 MG Road', pincode: '560001' },
    items:    [bottle(1, { unitCost: 1 })],   // client-sent cost must be ignored
    subtotal: 150000, shippingAmount: 0, total: 150000,
  }

  it('snapshots cost server-side on new storefront orders and hides it from customers', async () => {
    await createProduct()
    const created = await request(app)
      .post('/api/storefront/orders')
      .set('Content-Type', 'application/json')
      .set('X-Requested-With', 'snifftok-web')
      .send(orderBody)
    expect(created.status).toBe(201)

    const saved = await Order.findById(created.body.orderId).lean()
    expect(saved.items[0].unitCost).toBe(100000)
    expect(saved.channel).toBe('web')

    const lookup = await request(app)
      .get(`/api/storefront/orders/lookup?email=riya@test.com&orderNumber=${created.body.orderNumber}`)
    expect(lookup.status).toBe(200)
    expect(lookup.body.data.items[0].unitCost).toBeUndefined()
  })

  it('snapshots cost from product + size when an older cart sends no SKU', async () => {
    const product = await createProduct()
    const created = await request(app)
      .post('/api/storefront/orders')
      .set('Content-Type', 'application/json')
      .set('X-Requested-With', 'snifftok-web')
      .send({ ...orderBody, items: [bottle(1, { sku: undefined, productId: product._id.toString() })] })
    expect(created.status).toBe(201)

    const saved = await Order.findById(created.body.orderId).lean()
    expect(saved.items[0].unitCost).toBe(100000)
  })

  it('shows cost to admins but not staff on admin order endpoints', async () => {
    const order = await createOrder({ items: [bottle(1, { unitCost: 100000 })] })

    const asAdmin = await get(`/api/admin/orders/${order._id}`, await tokenFor('admin'))
    expect(asAdmin.body.items[0].unitCost).toBe(100000)

    const asStaff = await get('/api/admin/orders', await tokenFor('staff'))
    expect(asStaff.status).toBe(200)
    expect(asStaff.body.data[0].items[0].unitCost).toBeUndefined()
  })
})
