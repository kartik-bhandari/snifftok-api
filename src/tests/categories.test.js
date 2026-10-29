/**
 * src/tests/categories.test.js
 * The 5 scent-family categories — storefront endpoints, slug filtering,
 * and product writes restricted to active categories.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { User } from '../models/User.js'
import { Category } from '../models/Category.js'
import { Product } from '../models/Product.js'
import app from '../app.js'
import { signToken } from '../lib/jwt.js'
import { SCENT_FAMILIES } from '../data/scentFamilies.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

let cats   // slug → Category doc

async function seedFamilies() {
  cats = {}
  for (const f of SCENT_FAMILIES) cats[f.slug] = await Category.create({ ...f, isActive: true })
  cats.men = await Category.create({ name: 'Men', slug: 'men', isActive: false })   // legacy
}

let skuSeq = 0
const productIn = (category, extra = {}) => Product.create({
  name: `Perfume ${++skuSeq}`, categoryId: category._id, isActive: true,
  variants: [{ type: 'bottle', sizeMl: 50, sku: `P-${skuSeq}`, costPrice: 100000, minProfit: 20000, stock: 5 }],
  ...extra,
})

async function adminToken() {
  const user = await User.create({ email: 'admin@test.com', name: 'Admin', role: 'admin', sessionVersion: 1, isActive: true })
  return signToken({ sub: user._id.toString(), role: 'admin', v: 1 })
}

const productBody = (categoryId) => ({
  name: 'New Perfume',
  categoryId,
  images:   [{ url: 'https://res.cloudinary.com/x/image/upload/a.jpg', publicId: 'a', order: 0 }],
  variants: [{ type: 'bottle', sizeMl: 50, sku: 'NEW-50', costPrice: 100000, minProfit: 20000, stock: 3 }],
})

const adminPost = (path, body, token) =>
  request(app).post(path)
    .set('Content-Type', 'application/json')
    .set('X-Requested-With', 'snifftok-admin')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

beforeEach(seedFamilies)

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/storefront/categories', () => {
  it('returns only the 5 families, in order, with product counts and details', async () => {
    await productIn(cats.floral)
    await productIn(cats.floral)
    await productIn(cats.amber, { isActive: false })   // archived — not counted

    const res = await request(app).get('/api/storefront/categories')
    expect(res.status).toBe(200)
    expect(res.body.data.map(c => c.slug)).toEqual(['floral', 'amber', 'woody', 'fresh', 'gourmand'])
    expect(res.body.data[0]).toMatchObject({ name: 'Floral', productCount: 2, notes: expect.arrayContaining(['Rose']) })
    expect(res.body.data[1]).toMatchObject({ aka: 'Formerly Oriental', productCount: 0 })
  })

  it('returns one family by slug, 404 for unknown or inactive ones', async () => {
    expect((await request(app).get('/api/storefront/categories/gourmand')).body.data.name).toBe('Gourmand')
    expect((await request(app).get('/api/storefront/categories/men')).status).toBe(404)
    expect((await request(app).get('/api/storefront/categories/nope')).status).toBe(404)
  })
})

describe('GET /api/storefront/products?category=', () => {
  it('filters by slug as well as by id', async () => {
    const floral = await productIn(cats.floral)
    await productIn(cats.woody)

    const bySlug = await request(app).get('/api/storefront/products?category=floral')
    expect(bySlug.body.data.map(p => p.name)).toEqual([floral.name])

    const byId = await request(app).get(`/api/storefront/products?category=${cats.floral._id}`)
    expect(byId.body.total).toBe(1)

    const unknown = await request(app).get('/api/storefront/products?category=unknown')
    expect(unknown.body).toMatchObject({ data: [], total: 0 })
  })
})

describe('Admin categories', () => {
  it('lists only active categories in family order; creating new ones is not allowed', async () => {
    const token = await adminToken()
    const list = await request(app).get('/api/admin/categories')
      .set('X-Requested-With', 'snifftok-admin').set('Authorization', `Bearer ${token}`)
    expect(list.body.categories.map(c => c.name)).toEqual(['Floral', 'Amber', 'Woody', 'Fresh', 'Gourmand'])

    const create = await adminPost('/api/admin/categories', { name: 'Oud' }, token)
    expect(create.status).toBe(404)
  })

  it('product create requires one of the active categories', async () => {
    const token = await adminToken()

    const missing = await adminPost('/api/admin/products', { ...productBody(undefined) }, token)
    expect(missing.status).toBe(400)

    const legacy = await adminPost('/api/admin/products', productBody(cats.men._id.toString()), token)
    expect(legacy.status).toBe(400)
    expect(legacy.body.errors.categoryId).toBeTruthy()

    const ok = await adminPost('/api/admin/products', productBody(cats.fresh._id.toString()), token)
    expect(ok.status).toBe(201)
    expect(ok.body.product.categoryId.slug).toBe('fresh')
  })
})
