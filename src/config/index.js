/**
 * src/config/index.js
 * Centralised configuration — read once on startup, used everywhere.
 */

export const config = {
  port:          parseInt(process.env.PORT ?? '5000', 10),
  nodeEnv:       process.env.NODE_ENV ?? 'development',
  mongoUri:      process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/snifftok',

  // JWT / Session
  sessionSecret:     process.env.SESSION_SECRET ?? 'dev-secret-change-me-min-32-chars',
  cookieDomain:      process.env.COOKIE_DOMAIN ?? '',   // empty = don't set Domain attribute
  cookieName:        'snifftok_session',

  // CSRF / CORS
  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Links in customer emails — defaults to the first CLIENT_ORIGIN (the storefront)
  storefrontUrl: (process.env.STOREFRONT_URL ?? (process.env.CLIENT_ORIGIN ?? 'http://localhost:3000').split(',')[0]).trim().replace(/\/+$/, ''),

  // TOTP secret encryption key — must be 64 hex chars (32 bytes)
  totpKey: process.env.TOTP_ENCRYPTION_KEY ??
    '0000000000000000000000000000000000000000000000000000000000000000',

  // Rate limits
  loginMaxAttempts:  5,
  lockDurationMs:    15 * 60 * 1000,   // 15 minutes

  // Cookie maxAge
  customerCookieMs:  30 * 24 * 3600 * 1000,   // 30 days
  adminCookieMs:     12 * 3600 * 1000,          // 12 hours
  pendingTokenMs:    10 * 60 * 1000,            // 10 minutes (2FA pending)

  // Cloudinary (API secret NEVER sent to browser)
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey:    process.env.CLOUDINARY_API_KEY    ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
  },

  isProd: () => process.env.NODE_ENV === 'production',
}
