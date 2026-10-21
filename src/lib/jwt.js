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
  const isProd = config.isProd()
  // In production without a shared root domain, use SameSite=none so the cookie
  // is sent on cross-origin requests from the admin panel (onrender.com subdomains
  // are cross-site per the public suffix list).
  // SameSite=none requires Secure=true — always true on Render (HTTPS).
  const sameSite = isProd && !config.cookieDomain ? 'none' : 'lax'

  const opts = {
    httpOnly:  true,
    secure:    isProd || sameSite === 'none',
    sameSite,
    path:      '/',
    maxAge:    type === 'customer' ? config.customerCookieMs : config.adminCookieMs,
  }
  if (isProd && config.cookieDomain) {
    opts.domain = config.cookieDomain
  }
  res.cookie(config.cookieName, token, opts)
}

/**
 * Clear the session cookie — MUST use the same Domain/Path as setCookie().
 * @param {import('express').Response} res
 */
export function clearCookie(res) {
  const isProd  = config.isProd()
  const sameSite = isProd && !config.cookieDomain ? 'none' : 'lax'
  const opts = {
    httpOnly: true,
    secure:   isProd || sameSite === 'none',
    sameSite,
    path:     '/',
  }
  if (isProd && config.cookieDomain) {
    opts.domain = config.cookieDomain
  }
  res.clearCookie(config.cookieName, opts)
}
