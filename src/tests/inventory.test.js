/**
 * src/tests/inventory.test.js
 * GET /api/admin/inventory/not-selling — active stock with no sales in the period.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { User } from '../models/User.js'
import { Order } from '../models/Order.js'
import { Product } from '../models/Product.js'
import app from '../app.js'
import { signToken } from '../lib/jwt.js'

const DAY = 24 * 60 * 60 * 1000

async function tokenFor(role) {
  const user = await User.create({ email: `${role}@test.com`, name: role, role, sessionVersion: 1, isActive: true })
  return signToken({ sub: user._id.toString(), role, v: 1 })
}

const get = (path, token) => request(app).get(path)
  .set('X-Requested-With', 'snifftok-admin').set('Authorization', `Bearer ${token}`)

let seq = 0
async function order(items, daysAgo = 0, status = 'confirmed') {
  const o = await Order.create({
    orderNumber: `INV-${++seq}`,
    customer: { name: 'Riya', email: 'riya@test.com', phone: '9876543210' },
    address:  { line1: '1 MG Road', pincode: '560001' },
    items: items.map(i => ({ variantType: 'bottle', sizeMl: 50, unitPrice: 100000, quantity: 1, lineTotal: 100000, ...i })),
    subtotal: 100000, shippingAmount: 0, total: 100000, status,
  })
  await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: new Date(Date.now() - daysAgo * DAY) } })
}

const v = (sku, extra = {}) => ({ type: 'bottle', sizeMl: 50, sku, costPrice: 100000, minProfit: 20000, stock: 5, ...extra })

let admin
beforeEach(async () => {
  admin = await tokenFor('admin')
  await Product.create({ name: 'Selling Well', variants: [v('SELL')] })                                  // sold 5 days ago
  await Product.create({ name: 'Old Seller',   variants: [v('OLD', { costPrice: 200000, stock: 3 })] })  // last sold 45 days ago
  await Product.create({ name: 'Never Sold',   variants: [v('NEVER', { costPrice: 50000, stock: 4 })] })
  await Product.create({ name: 'Sold Out',     variants: [v('GONE', { stock: 2, reserved: 2 })] })       // nothing available
  await Product.create({ name: 'Archived',     isActive: false, variants: [v('ARCH')] })
  await Product.create({ name: 'Two Sizes',    variants: [v('TWO-50'), v('TWO-T', { type: 'tester', sizeMl: 2, costPrice: 10000, stock: 10 })] })

  await order([{ name: 'Selling Well', sku: 'SELL' }], 5)
  await order([{ name: 'Old Seller', sku: 'OLD' }], 45)
  await order([{ name: 'Two Sizes', sku: '' }], 3)                        // old checkout: no SKU → matched by name + size
  await order([{ name: 'Never Sold', sku: 'NEVER' }], 1, 'cancelled')     // cancelled orders don't count
})

describe('GET /api/admin/inventory/not-selling', () => {
  it('lists active, in-stock variants with no sales in the period, most money tied up first', async () => {
    const res = await get('/api/admin/inventory/not-selling?days=30', admin)
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(30)
    expect(res.body.items.map(i => i.sku)).toEqual(['OLD', 'NEVER', 'TWO-T'])   // 6000, 2000, 1000 (₹)

    const [old, never, tester] = res.body.items
    expect(old).toMatchObject({ name: 'Old Seller', available: 3, stockValue: 600000, daysSinceLastSale: 45 })
    expect(never).toMatchObject({ daysSinceLastSale: null, lastSoldAt: null, stockValue: 200000 })
    expect(tester).toMatchObject({ type: 'tester', sizeMl: 2, available: 10 })
    expect(res.body.totals).toEqual({ variants: 3, units: 17, stockValue: 900000 })
  })

  it('a longer period counts older sales', async () => {
    const res = await get('/api/admin/inventory/not-selling?days=60', admin)
    expect(res.body.items.map(i => i.sku)).toEqual(['NEVER', 'TWO-T'])
  })

  it('limit trims the list but totals cover everything', async () => {
    const res = await get('/api/admin/inventory/not-selling?days=30&limit=1', admin)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.totals.variants).toBe(3)
  })

  it('staff get no cost figures, sorted by longest without a sale', async () => {
    const res = await get('/api/admin/inventory/not-selling?days=30', await tokenFor('staff'))
    expect(res.status).toBe(200)
    expect(res.body.items.map(i => i.sku)).toEqual(['NEVER', 'TWO-T', 'OLD'])   // never sold first (TWO-T never sold as a tester)
    expect(res.body.items.every(i => i.stockValue === null)).toBe(true)
    expect(res.body.totals.stockValue).toBeNull()
  })

  it('requires an admin or staff session', async () => {
    const res = await get('/api/admin/inventory/not-selling', await tokenFor('customer'))
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/inventory/stock', () => {
  it('lists every active variant with status, 30-day sales and days of cover', async () => {
    const res = await get('/api/admin/inventory/stock', admin)
    expect(res.status).toBe(200)
    const bySku = Object.fromEntries(res.body.items.map(i => [i.sku, i]))

    expect(Object.keys(bySku).sort()).toEqual(['GONE', 'NEVER', 'OLD', 'SELL', 'TWO-50', 'TWO-T'])   // archived left out
    expect(bySku.GONE).toMatchObject({ stock: 2, reserved: 2, available: 0, status: 'out' })
    expect(bySku.OLD).toMatchObject({ available: 3, reorderLevel: 3, status: 'low', sold30: 0, daysOfCover: null })
    expect(bySku.SELL).toMatchObject({ status: 'ok', sold30: 1, daysOfCover: 150 })   // 5 left ÷ (1 per 30 days)
    expect(bySku['TWO-50'].sold30).toBe(1)                                            // matched by name + size
    expect(bySku.OLD.stockValue).toBe(600000)

    expect(res.body.totals).toMatchObject({ variants: 6, available: 27, reserved: 2, low: 1, out: 1 })
  })

  it('hides cost figures from staff', async () => {
    const res = await get('/api/admin/inventory/stock', await tokenFor('staff'))
    expect(res.body.items.every(i => i.costPrice === null && i.stockValue === null)).toBe(true)
    expect(res.body.totals.stockValue).toBeNull()
  })
})

const post = (path, body, token) => request(app).post(path)
  .set('Content-Type', 'application/json').set('X-Requested-With', 'snifftok-admin')
  .set('Authorization', `Bearer ${token}`).send(body)

describe('POST /api/admin/inventory/adjust + GET /movements', () => {
  it('records stock received, updates the product and writes the ledger', async () => {
    const res = await post('/api/admin/inventory/adjust', { sku: 'old', delta: 12, reason: 'purchase', note: 'Invoice 42' }, admin)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ sku: 'OLD', stock: 15, available: 15 })

    const product = await Product.findOne({ 'variants.sku': 'OLD' }).lean()
    expect(product.variants[0].stock).toBe(15)

    const ledger = await get('/api/admin/inventory/movements?sku=OLD', admin)
    expect(ledger.body.items[0]).toMatchObject({ sku: 'OLD', name: 'Old Seller', delta: 12, reason: 'purchase', note: 'Invoice 42', actor: 'admin' })
  })

  it('corrections can remove stock but need a note', async () => {
    expect((await post('/api/admin/inventory/adjust', { sku: 'NEVER', delta: -1, reason: 'adjustment' }, admin)).status).toBe(400)
    const ok = await post('/api/admin/inventory/adjust', { sku: 'NEVER', delta: -1, reason: 'adjustment', note: 'Broken in storage' }, admin)
    expect(ok.status).toBe(201)
    expect(ok.body.stock).toBe(3)
  })

  it('stock received and returns cannot be negative', async () => {
    const res = await post('/api/admin/inventory/adjust', { sku: 'NEVER', delta: -2, reason: 'purchase' }, admin)
    expect(res.status).toBe(400)
  })

  it('stock cannot drop below what is reserved for open orders', async () => {
    const res = await post('/api/admin/inventory/adjust', { sku: 'GONE', delta: -1, reason: 'adjustment', note: 'x' }, admin)
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/reserved/)
  })

  it('unknown SKU is a 404; staff can adjust too', async () => {
    const staff = await tokenFor('staff')
    expect((await post('/api/admin/inventory/adjust', { sku: 'NOPE', delta: 1, reason: 'purchase' }, staff)).status).toBe(404)
    expect((await post('/api/admin/inventory/adjust', { sku: 'SELL', delta: 1, reason: 'returned' }, staff)).status).toBe(201)
  })

  it('ledger lists newest first and pages with `before`', async () => {
    for (let i = 1; i <= 3; i++) {
      await post('/api/admin/inventory/adjust', { sku: 'SELL', delta: i, reason: 'purchase' }, admin)
      await new Promise(r => setTimeout(r, 5))
    }
    const first = await get('/api/admin/inventory/movements?limit=2', admin)
    expect(first.body.items.map(m => m.delta)).toEqual([3, 2])
    expect(first.body.nextBefore).toBeTruthy()

    const next = await get(`/api/admin/inventory/movements?limit=2&before=${encodeURIComponent(first.body.nextBefore)}`, admin)
    expect(next.body.items.map(m => m.delta)).toEqual([1])
    expect(next.body.nextBefore).toBeNull()
  })
})
