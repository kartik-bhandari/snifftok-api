/**
 * src/middleware/auth.js
 * requireAuth, requireRole, requireAdminOrStaff
 */

import { verifyToken } from '../lib/jwt.js'
import { User } from '../models/User.js'
import { config } from '../config/index.js'

/**
 * requireAuth — verifies the session cookie and attaches req.user.
 * Sets req.setupOnly = true when the admin has not yet completed 2FA setup.
 */
export async function requireAuth(req, res, next) {
  // Accept token from cookie (storefront) OR Authorization: Bearer (admin SPA)
  let token = req.cookies?.[config.cookieName]
  if (!token) {
    const auth = req.headers.authorization ?? ''
    if (auth.startsWith('Bearer ')) token = auth.slice(7)
  }

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' })
  }

  let decoded
  try {
    decoded = verifyToken(token)
  } catch (err) {
    return res.status(401).json({ message: 'Session expired. Please sign in again.' })
  }

  // Pending tokens (2FA step 1) must NOT be used as session cookies
  if (decoded.pending) {
    return res.status(401).json({ message: 'Authentication required.' })
  }

  const user = await User.findById(decoded.sub).select('+passwordHash +sessionVersion')
  if (!user || !user.isActive) {
    return res.status(401).json({ message: 'Authentication required.' })
  }

  // Session invalidation — version must match
  if (user.sessionVersion !== decoded.v) {
    return res.status(401).json({ message: 'Session expired. Please sign in again.' })
  }

  req.user      = user
  req.setupOnly = decoded.setupOnly === true
  next()
}

/**
 * requireRole — must come after requireAuth.
 * Allows only users whose role is in the provided list.
 * Also blocks setupOnly sessions from all routes except 2FA setup.
 *
 * @param {...string} roles  e.g. requireRole('admin', 'staff')
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required.' })
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied.' })
    }

    // setupOnly sessions can only reach 2FA setup endpoints.
    // Those endpoints use requireAuth only (not requireRole), so this
    // middleware will never be reached from a setup-only session on a
    // setup route — which means we can safely block here.
    if (req.setupOnly) {
      return res.status(403).json({
        message:      'Please complete 2FA setup before accessing this resource.',
        needs2faSetup: true,
      })
    }

    next()
  }
}

/** Shorthand for admin + staff routes */
export const requireAdminOrStaff = requireRole('admin', 'staff')

/** Shorthand for admin-only routes (settings, reports, users) */
export const requireAdmin = requireRole('admin')
