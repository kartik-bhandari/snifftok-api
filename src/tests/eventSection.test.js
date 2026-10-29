/**
 * src/tests/eventSection.test.js
 * Storefront event / offer section — admin editing and public visibility.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { User } from '../models/User.js'
import { Product } from '../models/Product.js'
import app from '../app.js'
import { signToken } from '../lib/jwt.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function tokenFor(role) {
  const user = await User.create({ email: `${role}@test.com`, name: role, role, sessionVersion: 1, isActive: true })
  return signToken({ sub: user._id.toString(), role, v: 1 })
}

let seq = 0
const product = (extra = {}) => Product.create({
  name: `Perfume ${++seq}`, isActive: true,
  variants: [{ type: 'bottle', sizeMl: 50, sku: `EV-${seq}`, costPrice: 100000, minProfit: 20000, stock: 5 }],
  ...extra,
})

const PATH = '/api/admin/settings/event-section'
const put  = (body, token) => request(app).put(PATH)
  .set('Content-Type', 'application/json').set('X-Requested-With', 'snifftok-admin')
  .set('Authorization', `Bearer ${token}`).send(body)
const getAdmin = (token) => request(app).get(PATH)
  .set('X-Requested-With', 'snifftok-admin').set('Authorization', `Bearer ${token}`)
const getPublic = () => request(app).get('/api/storefront/event-section')

let admin
beforeEach(async () => { admin = await tokenFor('admin') })

// ─────────────────────────────────────────────────────────────────────────────
describe('Event section', () => {
  it('starts hidden', async () => {
    expect((await getPublic()).body).toEqual({ enabled: false })
    const res = await getAdmin(admin)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ enabled: false, title: '', products: [] })
  })

  it('shows the chosen products in the chosen order when turned on', async () => {
    const a = await product(), b = await product(), c = await product()
    const saved = await put({ enabled: true, title: 'Diwali Sale', subtitle: 'Up to 20% off', productIds: [c._id, a._id, b._id].map(String) }, admin)
    expect(saved.status).toBe(200)

    const res = await getPublic()
    expect(res.body).toMatchObject({ enabled: true, title: 'Diwali Sale', subtitle: 'Up to 20% off' })
    expect(res.body.products.map(p => p.name)).toEqual([c.name, a.name, b.name])
    // Public data never includes cost
    expect(res.body.products[0].variants[0].costPrice).toBeUndefined()
  })

  it('turning it off hides it but keeps the setup', async () => {
    const a = await product()
    await put({ enabled: true, title: 'Holi Offer', productIds: [String(a._id)] }, admin)
    await put({ enabled: false, title: 'Holi Offer', productIds: [String(a._id)] }, admin)

    expect((await getPublic()).body).toEqual({ enabled: false })
    expect((await getAdmin(admin)).body).toMatchObject({ enabled: false, title: 'Holi Offer', products: [{ name: a.name }] })
  })

  it('skips archived products, and hides the section if none are left', async () => {
    const live = await product(), archived = await product({ isActive: false })
    await put({ enabled: true, title: 'Sale', productIds: [archived, live].map(p => String(p._id)) }, admin)
    expect((await getPublic()).body.products.map(p => p.name)).toEqual([live.name])

    await Product.updateOne({ _id: live._id }, { isActive: false })
    expect((await getPublic()).body).toEqual({ enabled: false })
  })

  it('needs a name and at least one product to turn on; draft saves are fine', async () => {
    const a = await product()
    expect((await put({ enabled: true, title: '', productIds: [String(a._id)] }, admin)).status).toBe(400)
    expect((await put({ enabled: true, title: 'Sale', productIds: [] }, admin)).status).toBe(400)
    expect((await put({ enabled: false, title: '', productIds: [] }, admin)).status).toBe(200)
  })

  it('rejects unknown products and more than 12', async () => {
    const bogus = await put({ enabled: false, title: 'x', productIds: ['6ad4e79c6ea437ee8c00aaaa'] }, admin)
    expect(bogus.status).toBe(400)

    const many = await Promise.all(Array.from({ length: 13 }, () => product()))
    const tooMany = await put({ enabled: false, title: 'x', productIds: many.map(p => String(p._id)) }, admin)
    expect(tooMany.status).toBe(400)
  })

  it('is admin-only to edit', async () => {
    const staff = await tokenFor('staff')
    expect((await getAdmin(staff)).status).toBe(403)
    expect((await put({ enabled: false, title: '', productIds: [] }, staff)).status).toBe(403)
  })
})
