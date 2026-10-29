/**
 * src/tests/storefrontProducts.test.js
 * Storefront product list — sorting and filters used by the shop pages
 * (all products, new arrivals, best sellers, decants).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { Product } from '../models/Product.js'
import app from '../app.js'

const DAY = 24 * 60 * 60 * 1000

let seq = 0
async function product(name, { variants, tags = [], isActive = true, daysAgo = 0 } = {}) {
  const p = await Product.create({
    name, tags, isActive,
    variants: (variants ?? [{ type: 'bottle', stock: 5 }]).map(v => ({
      sizeMl: v.type === 'tester' ? 2 : 50, sku: `SP-${++seq}`, costPrice: 100000, minProfit: 20000, ...v,
    })),
  })
  await Product.collection.updateOne({ _id: p._id }, { $set: { createdAt: new Date(Date.now() - daysAgo * DAY) } })
  return p
}

const list = async (qs) => (await request(app).get(`/api/storefront/products?${qs}`)).body

beforeEach(async () => {
  await product('beta', { daysAgo: 3, tags: ['best-seller'] })
  await product('Alpha', { daysAgo: 1, variants: [{ type: 'bottle', stock: 5 }, { type: 'tester', stock: 4 }] })
  await product('Gamma', { daysAgo: 2, variants: [{ type: 'tester', stock: 3, reserved: 3 }] })   // decant all reserved
  await product('Delta', { daysAgo: 0, variants: [{ type: 'tester', stock: 0 }], tags: ['best-seller'] })
  await product('Hidden', { daysAgo: 0, isActive: false, variants: [{ type: 'tester', stock: 9 }] })
})

describe('GET /api/storefront/products', () => {
  it('sorts newest first by default', async () => {
    expect((await list('')).data.map(p => p.name)).toEqual(['Delta', 'Alpha', 'Gamma', 'beta'])
  })

  it('sorts A–Z, ignoring case, with sort=name', async () => {
    expect((await list('sort=name')).data.map(p => p.name)).toEqual(['Alpha', 'beta', 'Delta', 'Gamma'])
  })

  it('filters best sellers by tag', async () => {
    expect((await list('tag=best-seller')).data.map(p => p.name)).toEqual(['Delta', 'beta'])
  })

  it('decants available = a tester variant with stock left after reservations', async () => {
    const res = await list('type=tester&inStock=true')
    expect(res.data.map(p => p.name)).toEqual(['Alpha'])
    expect(res.total).toBe(1)
  })

  it('type=tester alone still lists every product with a decant variant', async () => {
    expect((await list('type=tester')).data.map(p => p.name)).toEqual(['Delta', 'Alpha', 'Gamma'])
  })

  it('inStock alone means any variant in stock', async () => {
    expect((await list('inStock=true&sort=name')).data.map(p => p.name)).toEqual(['Alpha', 'beta'])
  })

  it('paginates', async () => {
    const page2 = await list('limit=2&page=2')
    expect(page2).toMatchObject({ total: 4, page: 2, totalPages: 2 })
    expect(page2.data.map(p => p.name)).toEqual(['Gamma', 'beta'])
  })
})
