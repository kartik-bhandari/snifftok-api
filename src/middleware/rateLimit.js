/**
 * src/middleware/rateLimit.js
 * express-rate-limit instances for auth endpoints.
 */

import rateLimit from 'express-rate-limit'

/** 5 requests per 15 minutes per IP on login and register */
export const authRateLimit = rateLimit({
  windowMs:         15 * 60 * 1000,    // 15 minutes
  max:              5,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { message: 'Too many attempts. Please try again in 15 minutes.' },
  skip: () => process.env.NODE_ENV === 'test',   // don't rate-limit in tests
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
