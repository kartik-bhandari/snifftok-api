/**
 * src/lib/totp.js
 * TOTP (Time-based One-Time Password) helpers using the `otpauth` library.
 * Compatible with Google Authenticator, Authy, and any standard TOTP app.
 */

import * as OTPAuth from 'otpauth'
import QRCode from 'qrcode'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'

const ISSUER = 'snifftok'
const DIGITS  = 6
const PERIOD  = 30
const WINDOW  = 1    // Accept ±1 period (30s tolerance for clock drift)

const RECOVERY_CODE_COUNT  = 8
const RECOVERY_CODE_LENGTH = 12
const RECOVERY_CODE_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // unambiguous chars

/**
 * Generate a new TOTP secret (base32 string).
 * @returns {string} base32 secret
 */
export function generateSecret() {
  const secret = new OTPAuth.Secret({ size: 20 })  // 160-bit secret
  return secret.base32
}

/**
 * Build the otpauth:// URI for a QR code.
 * @param {string} email
 * @param {string} base32Secret
 * @returns {string} URI
 */
export function generateOtpauthUri(email, base32Secret) {
  const totp = new OTPAuth.TOTP({
    issuer:    ISSUER,
    label:     email,
    algorithm: 'SHA1',
    digits:    DIGITS,
    period:    PERIOD,
    secret:    OTPAuth.Secret.fromBase32(base32Secret),
  })
  return totp.toString()
}

/**
 * Generate a QR code data URL from a base32 secret.
 * @param {string} email
 * @param {string} base32Secret
 * @returns {Promise<string>} data:image/png;base64,...
 */
export async function generateQRDataUrl(email, base32Secret) {
  const uri = generateOtpauthUri(email, base32Secret)
  return QRCode.toDataURL(uri, { width: 200, margin: 1 })
}

/**
 * Verify a 6-digit TOTP code against a base32 secret.
 * @param {string} base32Secret
 * @param {string} code  6-digit string (leading zeros preserved)
 * @returns {boolean}
 */
export function verifyTOTP(base32Secret, code) {
  try {
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits:    DIGITS,
      period:    PERIOD,
      secret:    OTPAuth.Secret.fromBase32(base32Secret),
    })
    const delta = totp.validate({ token: String(code), window: WINDOW })
    return delta !== null
  } catch {
    return false
  }
}

/**
 * Generate RECOVERY_CODE_COUNT plaintext recovery codes.
 * @returns {string[]} plaintext codes (shown to user once)
 */
export function generateRecoveryCodes() {
  const codes = []
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    let code = ''
    const bytes = randomBytes(RECOVERY_CODE_LENGTH)
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
      code += RECOVERY_CODE_CHARS[bytes[j] % RECOVERY_CODE_CHARS.length]
    }
    // Format as XXXX-XXXX-XXXX for readability
    codes.push(`${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`)
  }
  return codes
}

/**
 * Hash recovery codes for storage.
 * @param {string[]} codes
 * @returns {Promise<string[]>}
 */
export async function hashRecoveryCodes(codes) {
  return Promise.all(codes.map(c => bcrypt.hash(c.replace(/-/g, ''), 10)))
}

/**
 * Check if a submitted code matches any stored recovery code hash.
 * Removes the matched code (one-time use).
 * @param {string} submitted  user-entered code (with or without dashes)
 * @param {string[]} hashes   stored bcrypt hashes
 * @returns {Promise<{ matched: boolean, remaining: string[] }>}
 */
export async function checkRecoveryCode(submitted, hashes) {
  const normalized = submitted.replace(/-/g, '').toUpperCase()
  const remaining  = [...hashes]

  for (let i = 0; i < remaining.length; i++) {
    if (await bcrypt.compare(normalized, remaining[i])) {
      remaining.splice(i, 1)
      return { matched: true, remaining }
    }
  }
  return { matched: false, remaining }
}
