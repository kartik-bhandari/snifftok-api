/**
 * src/lib/crypto.js
 * AES-256-GCM encrypt/decrypt for TOTP secrets stored in the database.
 * Key comes from TOTP_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { config } from '../config/index.js'

function getKey() {
  const hex = config.totpKey
  if (hex.length !== 64) {
    throw new Error('TOTP_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)')
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 * @returns {string} "ivHex:ciphertextHex:authTagHex"
 */
export function encrypt(text) {
  const key = getKey()
  const iv  = randomBytes(12)          // 96-bit IV recommended for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const authTag   = cipher.getAuthTag()
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`
}

/**
 * Decrypt a value produced by encrypt().
 * @param {string} encoded "ivHex:ciphertextHex:authTagHex"
 * @returns {string} original plaintext
 */
export function decrypt(encoded) {
  const key = getKey()
  const parts = encoded.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted value format')
  const [ivHex, encHex, tagHex] = parts
  const iv        = Buffer.from(ivHex, 'hex')
  const encrypted = Buffer.from(encHex, 'hex')
  const authTag   = Buffer.from(tagHex, 'hex')
  const decipher  = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
