/**
 * src/tests/auth.test.js
 * Integration tests for all auth-related acceptance checks.
 * Uses MongoMemoryServer (via setup.js) and supertest.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { User } from '../models/User.js'
import { Otp } from '../models/Otp.js'
import { sendOtpEmail } from '../lib/mailer.js'
import app from '../app.js'
import { signToken } from '../lib/jwt.js'
import { generateSecret, verifyTOTP } from '../lib/totp.js'
import { encrypt } from '../lib/crypto.js'
import { config } from '../config/index.js'

// Never send real email from tests
vi.mock('../lib/mailer.js', () => ({ sendOtpEmail: vi.fn().mockResolvedValue() }))

// ── Helpers ───────────────────────────────────────────────────────────────────

/** POST with X-Requested-With header (simulates storefront) */
const post = (path, body, extraHeaders = {}) =>
  request(app)
    .post(path)
    .set('Content-Type', 'application/json')
    .set('X-Requested-With', 'snifftok-web')
    .set('Origin', 'http://localhost:3000')
    .set(extraHeaders)
    .send(body)

/** GET with a cookie */
const getWithCookie = (path, cookie) =>
  request(app).get(path).set('Cookie', cookie)

/** Create a user in the DB directly */
async function createUser(overrides = {}) {
  const passwordHash = await bcrypt.hash(overrides.password ?? 'Password123!', 12)
  return User.create({
    email:    overrides.email    ?? 'test@example.com',
    name:     overrides.name     ?? 'Test User',
    role:     overrides.role     ?? 'customer',
    passwordHash,
    sessionVersion: 1,
    isActive: overrides.isActive ?? true,
    ...overrides,
  })
}

/** Extract cookie value from response */
function getCookie(res) {
  const raw = res.headers['set-cookie']
  if (!raw) return null
  return Array.isArray(raw) ? raw[0] : raw
}

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/register', () => {
  it('creates a customer user and returns a session cookie', async () => {
    const res = await post('/api/auth/register', {
      name: 'Arjun Sharma', email: 'arjun@test.com', password: 'SecurePass1!'
    })

    expect(res.status).toBe(201)
    expect(res.body.user.role).toBe('customer')
    expect(res.body.user.email).toBe('arjun@test.com')
    expect(getCookie(res)).toBeTruthy()
  })

  it('ignores role field in the request body — always creates customer', async () => {
    const res = await post('/api/auth/register', {
      name: 'Evil Admin', email: 'evil@test.com', password: 'SecurePass1!', role: 'admin'
    })
    expect(res.status).toBe(201)
    expect(res.body.user.role).toBe('customer')
  })

  it('returns 409 if email already exists', async () => {
    await createUser({ email: 'dup@test.com' })
    const res = await post('/api/auth/register', {
      name: 'Dup', email: 'dup@test.com', password: 'Password123!'
    })
    expect(res.status).toBe(409)
  })

  it('returns 400 for invalid email', async () => {
    const res = await post('/api/auth/register', {
      name: 'Bad', email: 'not-an-email', password: 'Password123!'
    })
    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await createUser({ email: 'customer@test.com', password: 'Password123!', role: 'customer' })
  })

  it('returns user and session cookie for a valid customer login', async () => {
    const res = await post('/api/auth/login', { email: 'customer@test.com', password: 'Password123!' })
    expect(res.status).toBe(200)
    expect(res.body.user.role).toBe('customer')
    expect(getCookie(res)).toBeTruthy()
  })

  it('returns 401 for wrong password — generic message', async () => {
    const res = await post('/api/auth/login', { email: 'customer@test.com', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Invalid credentials.')
  })

  it('returns 401 for unknown email — same generic message, no user-existence leak', async () => {
    const res = await post('/api/auth/login', { email: 'nobody@test.com', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Invalid credentials.')
  })

  it('increments failedLoginCount on bad password', async () => {
    await post('/api/auth/login', { email: 'customer@test.com', password: 'wrong' })
    const user = await User.findOne({ email: 'customer@test.com' })
    expect(user.failedLoginCount).toBe(1)
  })

  it('locks account after 5 consecutive bad passwords', async () => {
    for (let i = 0; i < 5; i++) {
      await post('/api/auth/login', { email: 'customer@test.com', password: 'wrong' })
    }
    const res = await post('/api/auth/login', { email: 'customer@test.com', password: 'Password123!' })
    expect(res.status).toBe(423)
    expect(res.body.message).toMatch(/locked/i)
  })

  it('resets failedLoginCount on successful login', async () => {
    await post('/api/auth/login', { email: 'customer@test.com', password: 'wrong' })
    await post('/api/auth/login', { email: 'customer@test.com', password: 'Password123!' })
    const user = await User.findOne({ email: 'customer@test.com' })
    expect(user.failedLoginCount).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Admin login — two-step 2FA', () => {
  let admin

  beforeEach(async () => {
    const secret    = generateSecret()
    const encrypted = encrypt(secret)
    admin = await User.create({
      email: 'admin@test.com', name: 'Admin', role: 'admin',
      passwordHash: await bcrypt.hash('AdminPass1!', 12),
      sessionVersion: 0,
      twoFactor: {
        enabled:            true,
        secretEncrypted:    encrypted,
        recoveryCodesHashed: [],
        verifiedAt:         new Date(),
      },
      isActive: true,
    })
    admin._secret = secret // store for test use
  })

  it('step 1: returns { requires2fa, pendingToken } — no session cookie', async () => {
    const res = await post('/api/auth/login', { email: 'admin@test.com', password: 'AdminPass1!' })
    expect(res.status).toBe(200)
    expect(res.body.requires2fa).toBe(true)
    expect(res.body.pendingToken).toBeTruthy()
    expect(getCookie(res)).toBeFalsy()   // NO session cookie at this stage
  })

  it('step 2: valid TOTP code issues a full session cookie', async () => {
    const step1 = await post('/api/auth/login', { email: 'admin@test.com', password: 'AdminPass1!' })
    const pendingToken = step1.body.pendingToken

    // Generate a valid TOTP code for the admin's secret
    const totp = new (await import('otpauth')).TOTP({ secret: (await import('otpauth')).Secret.fromBase32(admin._secret), period: 30 })
    const code = totp.generate()

    const step2 = await post('/api/auth/2fa/verify', { code, pendingToken })
    expect(step2.status).toBe(200)
    expect(step2.body.user.role).toBe('admin')
    expect(getCookie(step2)).toBeTruthy()
  })

  it('step 2: wrong TOTP code returns 401', async () => {
    const step1 = await post('/api/auth/login', { email: 'admin@test.com', password: 'AdminPass1!' })
    const res = await post('/api/auth/2fa/verify', { code: '000000', pendingToken: step1.body.pendingToken })
    expect(res.status).toBe(401)
  })

  it('admin without 2FA gets a full session and a Bearer token (2FA optional)', async () => {
    await User.create({
      email: 'notfa@test.com', name: 'No 2FA', role: 'admin',
      passwordHash: await bcrypt.hash('AdminPass1!', 12),
      sessionVersion: 0, isActive: true,
    })
    const res = await post('/api/auth/login', { email: 'notfa@test.com', password: 'AdminPass1!' })
    expect(res.status).toBe(200)
    expect(res.body.requires2fa).toBeUndefined()
    expect(res.body.user.role).toBe('admin')
    expect(res.body.token).toBeTruthy()  // admin SPA uses Bearer auth
    expect(getCookie(res)).toBeTruthy()

    // The token is a real session, not a setupOnly one
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`)
    expect(me.status).toBe(200)
    expect(me.body.needs2faSetup).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/auth/me', () => {
  it('returns user when cookie is valid', async () => {
    const user = await createUser({ email: 'me@test.com' })
    const token = signToken({ sub: user._id.toString(), role: 'customer', v: 1 })
    const cookie = `${config.cookieName}=${token}`
    const res = await getWithCookie('/api/auth/me', cookie)
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe('me@test.com')
  })

  it('returns 401 without a cookie', async () => {
    const res = await request(app).get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  it('returns 401 when sessionVersion does not match (after logout)', async () => {
    const user = await createUser({ email: 'stale@test.com', role: 'customer' })
    // Token with old version
    const token = signToken({ sub: user._id.toString(), role: 'customer', v: 999 })
    const res = await getWithCookie('/api/auth/me', `${config.cookieName}=${token}`)
    expect(res.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/logout', () => {
  it('clears the cookie and invalidates the session', async () => {
    const user = await createUser({ email: 'logout@test.com' })
    const token = signToken({ sub: user._id.toString(), role: 'customer', v: 1 })
    const cookie = `${config.cookieName}=${token}`

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'snifftok-web')

    expect(logoutRes.status).toBe(200)

    // Subsequent /me with the OLD token should fail because sessionVersion was bumped
    const meRes = await getWithCookie('/api/auth/me', cookie)
    expect(meRes.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Role-based access control', () => {
  it('customer cannot access /api/admin/* — returns 403', async () => {
    const user  = await createUser({ email: 'cust@test.com', role: 'customer' })
    const token = signToken({ sub: user._id.toString(), role: 'customer', v: 1 })
    const res   = await getWithCookie('/api/admin/ping', `${config.cookieName}=${token}`)
    expect(res.status).toBe(403)
  })

  it('staff can access /api/admin/ping', async () => {
    const user  = await createUser({ email: 'staff@test.com', role: 'staff' })
    const token = signToken({ sub: user._id.toString(), role: 'staff', v: 1 })
    const res   = await getWithCookie('/api/admin/ping', `${config.cookieName}=${token}`)
    expect(res.status).toBe(200)
  })

  it('staff cannot access admin-only routes (settings)', async () => {
    const user  = await createUser({ email: 'staff2@test.com', role: 'staff' })
    const token = signToken({ sub: user._id.toString(), role: 'staff', v: 1 })
    const res   = await getWithCookie('/api/admin/settings/ping', `${config.cookieName}=${token}`)
    expect(res.status).toBe(403)
  })

  it('admin can access admin-only routes (settings)', async () => {
    const user  = await createUser({ email: 'adm@test.com', role: 'admin' })
    const token = signToken({ sub: user._id.toString(), role: 'admin', v: 1 })
    const res   = await getWithCookie('/api/admin/settings/ping', `${config.cookieName}=${token}`)
    expect(res.status).toBe(200)
  })

  it('setupOnly session cannot access /api/admin/ping — returns 403 with needs2faSetup', async () => {
    const user  = await createUser({ email: 'setup@test.com', role: 'admin' })
    const token = signToken({ sub: user._id.toString(), role: 'admin', v: 1, setupOnly: true })
    const res   = await getWithCookie('/api/admin/ping', `${config.cookieName}=${token}`)
    expect(res.status).toBe(403)
    expect(res.body.needs2faSetup).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('CSRF protection', () => {
  it('rejects POST from a foreign Origin without X-Requested-With', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('Origin', 'https://evil.com')
      // No X-Requested-With
      .send({ email: 'x@x.com', password: 'y' })

    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/CSRF/i)
  })

  it('allows POST from an allowed origin without X-Requested-With', async () => {
    // http://localhost:3000 is in CLIENT_ORIGIN
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'x@x.com', password: 'y' })

    // 401 (bad credentials) — not 403 CSRF
    expect(res.status).toBe(401)
  })

  it('allows POST with no Origin header (backend-to-backend, Postman, etc.)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send({ email: 'x@x.com', password: 'y' })

    expect(res.status).not.toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Cookie attributes', () => {
  it('sets HttpOnly on the session cookie', async () => {
    await createUser({ email: 'cookie@test.com', password: 'Password123!' })
    const res = await post('/api/auth/login', { email: 'cookie@test.com', password: 'Password123!' })
    const rawCookie = getCookie(res) ?? ''
    expect(rawCookie.toLowerCase()).toContain('httponly')
  })

  it('sets SameSite=Lax on the session cookie', async () => {
    await createUser({ email: 'samesite@test.com', password: 'Password123!' })
    const res = await post('/api/auth/login', { email: 'samesite@test.com', password: 'Password123!' })
    const rawCookie = getCookie(res) ?? ''
    expect(rawCookie.toLowerCase()).toContain('samesite=lax')
  })

  it('customer cookie has 30-day maxAge', async () => {
    await createUser({ email: 'maxage@test.com', password: 'Password123!', role: 'customer' })
    const res = await post('/api/auth/login', { email: 'maxage@test.com', password: 'Password123!' })
    const rawCookie = getCookie(res) ?? ''
    // Max-Age in seconds: 30 * 24 * 3600 = 2592000
    expect(rawCookie).toContain('Max-Age=2592000')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/otp/verify', () => {
  /** Store a known OTP directly so no email is sent */
  async function issueOtp(email, code = '123456') {
    await Otp.create({
      email,
      codeHash: await bcrypt.hash(code, 10),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    })
    return code
  }

  it('signs in an existing customer with a valid code', async () => {
    await createUser({ email: 'customer@test.com', role: 'customer' })
    const code = await issueOtp('customer@test.com')
    const res = await post('/api/auth/otp/verify', { email: 'customer@test.com', code })
    expect(res.status).toBe(200)
    expect(res.body.user.role).toBe('customer')
    expect(getCookie(res)).toBeTruthy()
  })

  it('new email: asks for a name without consuming the code, then signs up with the same code', async () => {
    const code = await issueOtp('new@test.com')

    const first = await post('/api/auth/otp/verify', { email: 'new@test.com', code })
    expect(first.status).toBe(422)
    expect(first.body.needsName).toBe(true)
    expect(getCookie(first)).toBeNull()
    expect(await User.exists({ email: 'new@test.com' })).toBeNull()

    const second = await post('/api/auth/otp/verify', { email: 'new@test.com', code, name: 'Riya' })
    expect(second.status).toBe(201)
    expect(second.body.isNew).toBe(true)
    expect(second.body.user.name).toBe('Riya')
    expect(getCookie(second)).toBeTruthy()

    // Code is single-use once sign-in succeeds
    const replay = await post('/api/auth/otp/verify', { email: 'new@test.com', code, name: 'Riya' })
    expect(replay.status).toBe(401)
  })

  it('new email: a wrong code never reaches the name step', async () => {
    await issueOtp('new@test.com', '123456')
    const res = await post('/api/auth/otp/verify', { email: 'new@test.com', code: '654321' })
    expect(res.status).toBe(401)
    expect(res.body.needsName).toBeUndefined()
  })

  it.each(['admin', 'staff'])('rejects %s accounts — no session issued, 2FA cannot be bypassed', async (role) => {
    await createUser({ email: `${role}@test.com`, role })
    const code = await issueOtp(`${role}@test.com`)
    const res = await post('/api/auth/otp/verify', { email: `${role}@test.com`, code })
    expect(res.status).toBe(403)
    expect(res.body.useAdminPanel).toBe(true)
    expect(getCookie(res)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/otp/send', () => {
  beforeEach(() => vi.mocked(sendOtpEmail).mockClear())

  it('emails a code to a customer', async () => {
    await createUser({ email: 'customer@test.com', role: 'customer' })
    const res = await post('/api/auth/otp/send', { email: 'customer@test.com' })
    expect(res.status).toBe(200)
    expect(sendOtpEmail).toHaveBeenCalledWith('customer@test.com', expect.stringMatching(/^\d{6}$/))
    expect(await Otp.countDocuments({ email: 'customer@test.com' })).toBe(1)
  })

  it('emails a code to a brand-new email (sign-up)', async () => {
    const res = await post('/api/auth/otp/send', { email: 'new@test.com' })
    expect(res.status).toBe(200)
    expect(sendOtpEmail).toHaveBeenCalledOnce()
  })

  it('does not flag customers or new emails for the admin panel', async () => {
    const res = await post('/api/auth/otp/send', { email: 'new@test.com' })
    expect(res.body).toEqual({ ok: true })
  })

  it.each(['admin', 'staff'])('sends no code to %s accounts — points them to the admin panel', async (role) => {
    await createUser({ email: `${role}@test.com`, role })
    const res = await post('/api/auth/otp/send', { email: `${role}@test.com` })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, useAdminPanel: true })
    expect(sendOtpEmail).not.toHaveBeenCalled()
    expect(await Otp.countDocuments({ email: `${role}@test.com` })).toBe(0)
  })
})
