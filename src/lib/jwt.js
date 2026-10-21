/**
 * src/lib/jwt.js
 * JWT helpers — sign and verify session tokens.
 */

import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'

/**
 * Sign a JWT.
 * @param {object} payload
 * @param {string|number} expiresIn  e.g. '12h', '30d', '10m'
 * @returns {string} signed token
 */
export function signToken(payload, expiresIn = '12h') {
  return jwt.sign(payload, config.sessionSecret, { expiresIn })
}

/**
 * Verify a JWT.
 * @param {string} token
 * @returns {object} decoded payload
 * @throws {JsonWebTokenError | TokenExpiredError}
 */
export function verifyToken(token) {
  return jwt.verify(token, config.sessionSecret)
}

/**
 * Set the session cookie on a response.
 * Domain is only set in production (to allow cross-subdomain sharing).
 *
 * @param {import('express').Response} res
 * @param {string} token  signed JWT
 * @param {'customer'|'admin'} type  determines maxAge
 */
export function setCookie(res, token, type) {
  const opts = {
    httpOnly:  true,
    secure:    config.isProd(),
    sameSite:  'lax',
    path:      '/',
    maxAge:    type === 'customer' ? config.customerCookieMs : config.adminCookieMs,
  }
  // Only set Domain in production — in dev, omitting it scopes to localhost
  if (config.isProd() && config.cookieDomain) {
    opts.domain = config.cookieDomain
  }
  res.cookie(config.cookieName, token, opts)
}

/**
 * Clear the session cookie — MUST use the same Domain/Path as setCookie().
 * @param {import('express').Response} res
 */
export function clearCookie(res) {
  const opts = {
    httpOnly: true,
    secure:   config.isProd(),
    sameSite: 'lax',
    path:     '/',
  }
  if (config.isProd() && config.cookieDomain) {
    opts.domain = config.cookieDomain
  }
  res.clearCookie(config.cookieName, opts)
}
