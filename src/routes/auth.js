/**
 * src/routes/auth.js
 * Mounts all /api/auth/* endpoints.
 */

import { Router } from 'express'
import { authRateLimit } from '../middleware/rateLimit.js'
import { requireAuth } from '../middleware/auth.js'
import * as auth from '../controllers/auth.controller.js'

const router = Router()

// Public — rate limited
router.post('/register',  authRateLimit, auth.register)
router.post('/login',     authRateLimit, auth.login)

// Public — uses pendingToken in body (Path A) OR setupOnly session (Path B)
router.post('/2fa/verify', auth.verify2fa)

// Requires any valid session (including setupOnly)
router.get('/me',          requireAuth, auth.me)
router.post('/2fa/setup',  requireAuth, auth.setup2fa)
router.post('/logout',     requireAuth, auth.logout)

// Requires full session (not setupOnly) — requireRole handles this via requireAuth internals
// We use requireAuth here — setupOnly users can still call these to upgrade themselves
router.post('/2fa/disable',       requireAuth, auth.disable2fa)
router.post('/password/change',   requireAuth, auth.changePassword)

export default router
