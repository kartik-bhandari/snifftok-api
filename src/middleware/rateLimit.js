/**
 * src/middleware/rateLimit.js
 * express-rate-limit instances for auth endpoints.
 */

import rateLimit from 'express-rate-limit'

/** TEMPORARILY DISABLED — re-enable by setting max back to 5 once stable */
export const authRateLimit = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              10_000,            // effectively off
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { message: 'Too many attempts. Please try again in 15 minutes.' },
  skip: () => process.env.NODE_ENV === 'test',
})

/** More lenient limit for other auth endpoints (me, logout, 2FA) */
export const generalRateLimit = rateLimit({
  windowMs:         1 * 60 * 1000,     // 1 minute
  max:              60,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { message: 'Too many requests.' },
  skip: () => process.env.NODE_ENV === 'test',
})
