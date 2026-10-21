/**
 * src/middleware/csrf.js
 *
 * Lightweight CSRF protection using Origin + X-Requested-With checks.
 * This is not a token-based CSRF system — it relies on the browser's
 * SameSite=Lax cookie policy combined with the Origin allowlist.
 *
 * Rules:
 *   - Only applies to state-changing methods: POST, PUT, PATCH, DELETE
 *   - Exempt paths: /api/webhooks/* (they have their own signature checks)
 *   - A request is REJECTED when ALL of the following are true:
 *       1. It has an Origin header (cross-origin request)
 *       2. That Origin is NOT in the CLIENT_ORIGIN allowlist
 *       3. It does NOT have the X-Requested-With header
 *
 * Storefront sends: X-Requested-With: snifftok-web
 * Admin sends:      X-Requested-With: snifftok-admin
 */

import { config } from '../config/index.js'

const STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const WEBHOOK_PREFIX = '/api/webhooks'

export function csrfProtection(req, res, next) {
  // Only check state-changing methods
  if (!STATE_METHODS.has(req.method)) return next()

  // Webhooks are exempt — they use their own signature validation
  if (req.path.startsWith(WEBHOOK_PREFIX)) return next()

  const origin = req.headers.origin
  const xrw    = req.headers['x-requested-with']

  // No Origin header means same-origin or non-browser (Postman, cURL, backend-to-backend).
  // We allow these — the SameSite cookie already blocks the main CSRF vector.
  if (!origin) return next()

  const isAllowedOrigin = config.clientOrigins.includes(origin)

  // Allowed origin — no further check needed
  if (isAllowedOrigin) return next()

  // Foreign origin without the sentinel header — reject
  if (!xrw) {
    return res.status(403).json({ message: 'CSRF check failed: invalid origin.' })
  }

  // Foreign origin WITH the sentinel header is still rejected — the header
  // proves intentional cross-origin intent, but we don't allow unknown origins.
  return res.status(403).json({ message: 'CSRF check failed: origin not allowed.' })
}
