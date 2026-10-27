/**
 * src/controllers/auth.controller.js
 * Handlers for all /api/auth/* endpoints.
 */

import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { z } from 'zod'
import { User } from '../models/User.js'
import { Otp }  from '../models/Otp.js'
import { signToken, verifyToken, setCookie, clearCookie } from '../lib/jwt.js'
import { encrypt, decrypt } from '../lib/crypto.js'
import { sendOtpEmail } from '../lib/mailer.js'
import {
  generateSecret,
  generateQRDataUrl,
  verifyTOTP,
  generateRecoveryCodes,
  hashRecoveryCodes,
  checkRecoveryCode,
} from '../lib/totp.js'
import { config } from '../config/index.js'

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const registerSchema = z.object({
  name:     z.string().min(1).max(100).trim(),
  email:    z.string().email().max(254).toLowerCase(),
  password: z.string().min(8).max(128),
})

const loginSchema = z.object({
  email:    z.string().email().toLowerCase(),
  password: z.string().min(1).max(128),
})

const verify2faSchema = z.object({
  code:         z.string().min(6).max(12),   // TOTP (6) or recovery code (12 + dashes)
  pendingToken: z.string().optional(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8).max(128),
})

// ─── Constant-time dummy hash ─────────────────────────────────────────────────
// Used when the email doesn't exist so we still run bcrypt.compare at the same cost.
const DUMMY_HASH = '$2a$12$LJhXFDCQ5DXQJ5XZjRKHwupMZ0D0JbGZNaVS6OdUJhQbxTTr7gXy'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validate(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) {
    const errors = {}
    for (const e of result.error.errors) {
      errors[e.path.join('.')] = e.message
    }
    return { ok: false, errors }
  }
  return { ok: true, data: result.data }
}

function issueSessionCookie(res, user) {
  const token = signToken({
    sub: user._id.toString(),
    role: user.role,
    v: user.sessionVersion,
  })
  setCookie(res, token, user.role === 'customer' ? 'customer' : 'admin')
  return token
}

// ─── POST /api/auth/register ─────────────────────────────────────────────────

export async function register(req, res) {
  const parsed = validate(registerSchema, req.body)
  if (!parsed.ok) return res.status(400).json({ message: 'Validation failed.', errors: parsed.errors })

  const { name, email, password } = parsed.data

  // Check duplicate — do a constant-time hash before replying to prevent timing leaks
  const existing = await User.findOne({ email })
  if (existing) {
    await bcrypt.compare(password, DUMMY_HASH) // constant time
    return res.status(409).json({ message: 'An account with this email already exists.' })
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await User.create({ name, email, passwordHash, role: 'customer' })

  user.sessionVersion = 1
  user.lastLoginAt    = new Date()
  await user.save()

  issueSessionCookie(res, user)
  return res.status(201).json({ user: user.toSafeObject() })
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

export async function login(req, res) {
  const parsed = validate(loginSchema, req.body)
  if (!parsed.ok) return res.status(400).json({ message: 'Validation failed.', errors: parsed.errors })

  const { email, password } = parsed.data

  const user = await User.findOne({ email }).select('+passwordHash +sessionVersion')

  // Always run bcrypt.compare for constant time — even when user doesn't exist
  const hashToCheck = user?.passwordHash ?? DUMMY_HASH
  const passwordOk  = await bcrypt.compare(password, hashToCheck)

  // TEMPORARILY DISABLED — account lockout check
  // if (user && user.lockedUntil && user.lockedUntil > new Date()) {
  //   const minutesLeft = Math.max(1, Math.ceil((user.lockedUntil - Date.now()) / 60_000))
  //   return res.status(423).json({
  //     message: `Account temporarily locked. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`,
  //   })
  // }

  if (!user || !passwordOk || !user.isActive) {
    if (user && !passwordOk) {
      user.failedLoginCount += 1
      // TEMPORARILY DISABLED — account lockout trigger
      // if (user.failedLoginCount >= config.loginMaxAttempts) {
      //   user.lockedUntil      = new Date(Date.now() + config.lockDurationMs)
      //   user.failedLoginCount = 0
      // }
      await user.save()
    }
    return res.status(401).json({ message: 'Invalid credentials.' })
  }

  // ── Success ───────────────────────────────────────────────────────────────
  user.failedLoginCount = 0
  user.lockedUntil      = null
  user.lastLoginAt      = new Date()

  // Customer — issue session immediately
  if (user.role === 'customer') {
    user.sessionVersion += 1
    await user.save()
    issueSessionCookie(res, user)
    return res.json({ user: user.toSafeObject() })
  }

  // Admin / Staff — check 2FA state
  if (user.twoFactor.enabled) {
    // Step 1 of two-step login: return a short-lived pending token (NOT a session cookie)
    await user.save()
    const pendingToken = signToken(
      { sub: user._id.toString(), role: user.role, pending: true },
      '10m',
    )
    return res.json({ requires2fa: true, pendingToken })
  }

  // Admin / Staff without 2FA — issue a full session directly.
  // 2FA is optional for development; it can be enforced via a separate policy setting.
  user.sessionVersion += 1
  await user.save()
  const adminToken = signToken({ sub: user._id.toString(), role: user.role, v: user.sessionVersion }, '12h')
  issueSessionCookie(res, user)
  // Also return the token in the body so the admin SPA can use Bearer auth
  // (avoids cross-origin cookie issues on Render's separate subdomains)
  return res.json({ user: user.toSafeObject(), token: adminToken })
}
// ─── POST /api/auth/otp/send ─────────────────────────────────────────────────
// Generates and emails a 6-digit code. Rate-limited at the route level.
// Always returns 200 — never reveals whether the email exists.

const sendOtpSchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
})

export async function sendOtp(req, res) {
  const parsed = validate(sendOtpSchema, req.body)
  if (!parsed.ok) return res.status(400).json({ message: 'Validation failed.', errors: parsed.errors })

  const { email } = parsed.data

  // Delete any existing (unused) OTPs for this email before issuing a new one
  await Otp.deleteMany({ email })

  // Generate a cryptographically random 6-digit code
  const code     = String(crypto.randomInt(100_000, 999_999))  // 100000–999999
  const codeHash = await bcrypt.hash(code, 10)

  await Otp.create({
    email,
    codeHash,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),  // 10 minutes
  })

  try {
    await sendOtpEmail(email, code)
  } catch (err) {
    console.error('[mailer] Failed to send OTP email:', err.message)
    // Still return 200 — don't expose SMTP errors to the client
  }

  return res.json({ ok: true })
}

// ─── POST /api/auth/otp/verify ────────────────────────────────────────────────
// Verifies the code. On success, finds or creates the customer account and
// issues a session cookie. `name` is only required for brand-new accounts.

const verifyOtpSchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
  code:  z.string().length(6).regex(/^\d{6}$/),
  name:  z.string().min(1).max(100).trim().optional(),
})

export async function verifyOtp(req, res) {
  const parsed = validate(verifyOtpSchema, req.body)
  if (!parsed.ok) return res.status(400).json({ message: 'Validation failed.', errors: parsed.errors })

  const { email, code, name } = parsed.data

  const otpDoc = await Otp.findOne({ email, used: false, expiresAt: { $gt: new Date() } })

  // Generic message — avoids telling attackers whether the email was found
  const FAIL = { status: 401, message: 'Invalid or expired code. Please request a new one.' }

  if (!otpDoc) return res.status(FAIL.status).json({ message: FAIL.message })

  // Brute-force guard — max 5 wrong guesses per OTP
  if (otpDoc.attempts >= 5) {
    await Otp.deleteOne({ _id: otpDoc._id })
    return res.status(429).json({ message: 'Too many attempts. Please request a new code.' })
  }

  const codeOk = await bcrypt.compare(code, otpDoc.codeHash)

  if (!codeOk) {
    otpDoc.attempts += 1
    await otpDoc.save()
    return res.status(FAIL.status).json({ message: FAIL.message })
  }

  // Mark as used (TTL will delete it automatically within 10 min)
  otpDoc.used = true
  await otpDoc.save()

  // Find or create the customer account
  let user = await User.findOne({ email }).select('+sessionVersion')
  const isNew = !user

  if (isNew) {
    // New user — name is required
    if (!name?.trim()) {
      return res.status(422).json({ message: 'Name is required to create your account.', needsName: true })
    }
    user = await User.create({
      email,
      name:         name.trim(),
      role:         'customer',
      // passwordHash intentionally omitted — OTP-only customer account
      sessionVersion: 0,
    })
  }

  if (!user.isActive) {
    return res.status(403).json({ message: 'This account has been deactivated.' })
  }

  user.sessionVersion = (user.sessionVersion ?? 0) + 1
  user.lastLoginAt    = new Date()
  await user.save()

  issueSessionCookie(res, user)
  return res.status(isNew ? 201 : 200).json({ user: user.toSafeObject(), isNew })
}


export async function logout(req, res) {
  // Bump sessionVersion to invalidate all existing tokens for this user
  if (req.user) {
    await User.updateOne({ _id: req.user._id }, { $inc: { sessionVersion: 1 } })
  }
  clearCookie(res)
  return res.json({ ok: true })
}

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────

export async function me(req, res) {
  // req.user set by requireAuth (called by the route)
  const response = { user: req.user.toSafeObject() }
  if (req.setupOnly) response.needs2faSetup = true
  return res.json(response)
}

// ─── POST /api/auth/2fa/setup ─────────────────────────────────────────────────
// Requires: requireAuth only (works with setupOnly session)

export async function setup2fa(req, res) {
  const user = req.user

  if (user.twoFactor.enabled) {
    return res.status(409).json({ message: '2FA is already enabled.' })
  }

  const secret       = generateSecret()
  const qrCodeUrl    = await generateQRDataUrl(user.email, secret)
  const recoveryCodes = generateRecoveryCodes()
  const hashes        = await hashRecoveryCodes(recoveryCodes)

  // Store the encrypted secret and hashes — not yet "enabled" until verified
  user.twoFactor.secretEncrypted      = encrypt(secret)
  user.twoFactor.recoveryCodesHashed  = hashes
  user.twoFactor.enabled              = false  // flip to true after verify
  await user.save()

  return res.json({
    qrCodeUrl,
    recoveryCodes,  // show once — user must store these
    secret,         // show once — for manual entry in authenticator apps
  })
}

// ─── POST /api/auth/2fa/verify ────────────────────────────────────────────────
// Two uses:
//   A) pendingToken in body → step 2 of login (no existing session)
//   B) no pendingToken      → completing 2FA setup (setupOnly session)

export async function verify2fa(req, res) {
  const parsed = validate(verify2faSchema, req.body)
  if (!parsed.ok) return res.status(400).json({ message: 'Validation failed.', errors: parsed.errors })

  const { code, pendingToken } = parsed.data

  // ── Path A: Two-step login ────────────────────────────────────────────────
  if (pendingToken) {
    let decoded
    try {
      decoded = verifyToken(pendingToken)
    } catch {
      return res.status(401).json({ message: 'Invalid or expired verification token.' })
    }

    if (!decoded.pending) {
      return res.status(401).json({ message: 'Invalid token.' })
    }

    const user = await User.findById(decoded.sub).select('+sessionVersion')
    if (!user || !user.isActive || !user.twoFactor.enabled) {
      return res.status(401).json({ message: 'Invalid credentials.' })
    }

    const secret = decrypt(user.twoFactor.secretEncrypted)

    // Check TOTP first
    let verified = verifyTOTP(secret, code)

    // Check recovery codes if TOTP failed
    if (!verified) {
      const { matched, remaining } = await checkRecoveryCode(code, user.twoFactor.recoveryCodesHashed)
      if (matched) {
        verified = true
        user.twoFactor.recoveryCodesHashed = remaining
      }
    }

    if (!verified) {
      return res.status(401).json({ message: 'Invalid authentication code.' })
    }

    user.sessionVersion += 1
    user.lastLoginAt     = new Date()
    await user.save()

    issueSessionCookie(res, user)
    return res.json({ user: user.toSafeObject() })
  }

  // ── Path B: Completing 2FA setup ─────────────────────────────────────────
  // requireAuth must have been applied — req.user is populated
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' })
  }

  const user = req.user
  if (!user.twoFactor.secretEncrypted) {
    return res.status(400).json({ message: 'Call /api/auth/2fa/setup first.' })
  }

  const secret   = decrypt(user.twoFactor.secretEncrypted)
  const verified = verifyTOTP(secret, code)

  if (!verified) {
    return res.status(401).json({ message: 'Invalid code. Check your authenticator app.' })
  }

  user.twoFactor.enabled    = true
  user.twoFactor.verifiedAt = new Date()
  user.sessionVersion       += 1
  await user.save()

  // Upgrade to a full session (no longer setupOnly)
  issueSessionCookie(res, user)
  return res.json({ user: user.toSafeObject() })
}

// ─── POST /api/auth/2fa/disable ───────────────────────────────────────────────

export async function disable2fa(req, res) {
  const { code } = req.body
  if (!code) return res.status(400).json({ message: 'Authentication code required.' })

  const user = req.user
  if (!user.twoFactor.enabled) {
    return res.status(400).json({ message: '2FA is not enabled.' })
  }

  const secret   = decrypt(user.twoFactor.secretEncrypted)
  const verified = verifyTOTP(secret, code)
  if (!verified) {
    return res.status(401).json({ message: 'Invalid authentication code.' })
  }

  user.twoFactor.enabled              = false
  user.twoFactor.secretEncrypted      = null
  user.twoFactor.recoveryCodesHashed  = []
  user.twoFactor.verifiedAt           = null
  user.sessionVersion                 += 1
  await user.save()

  // Re-issue session without 2FA requirement
  issueSessionCookie(res, user)
  return res.json({ ok: true })
}

// ─── POST /api/auth/password/change ──────────────────────────────────────────

export async function changePassword(req, res) {
  const parsed = validate(changePasswordSchema, req.body)
  if (!parsed.ok) return res.status(400).json({ message: 'Validation failed.', errors: parsed.errors })

  const { currentPassword, newPassword } = parsed.data
  const user = await User.findById(req.user._id).select('+passwordHash +sessionVersion')

  const ok = await bcrypt.compare(currentPassword, user.passwordHash)
  if (!ok) return res.status(401).json({ message: 'Current password is incorrect.' })

  user.passwordHash   = await bcrypt.hash(newPassword, 12)
  user.sessionVersion += 1
  await user.save()

  // Clear the session — user must log in again with the new password
  clearCookie(res)
  return res.json({ ok: true, message: 'Password changed. Please sign in again.' })
}
