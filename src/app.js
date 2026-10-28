/**
 * src/app.js
 * Creates and configures the Express application.
 * Does NOT connect to MongoDB or start listening — that happens in server.js.
 * Exported so tests can import the app without starting the HTTP server.
 */

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { config } from './config/index.js'
import { csrfProtection } from './middleware/csrf.js'
import authRouter       from './routes/auth.js'
import productsRouter   from './routes/products.js'
import categoriesRouter from './routes/categories.js'
import pricingRouter    from './routes/pricing.js'
import uploadsRouter    from './routes/uploads.js'
import storefrontRouter from './routes/storefront.js'
import { storefrontOrdersRouter, adminOrdersRouter } from './routes/orders.js'
import { requireAuth, requireAdminOrStaff, requireAdmin } from './middleware/auth.js'

const app = express()

// ── CORS — must come BEFORE helmet so preflight OPTIONS gets correct headers ──
const corsOptions = {
  origin(origin, callback) {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true)
    if (config.clientOrigins.includes(origin)) return callback(null, true)
    console.warn(`[CORS] Rejected origin: ${origin} | Allowed: ${config.clientOrigins.join(', ')}`)
    // No CORS headers (browser blocks the response) — don't throw, or the global
    // error handler turns it into a 500 before csrfProtection can return a 403
    callback(null, false)
  },
  credentials:    true,
  allowedHeaders: ['Content-Type', 'X-Requested-With', 'Authorization', 'X-CSRF-Token'],
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}

// Handle preflight for every route explicitly
app.options('*', cors(corsOptions))
app.use(cors(corsOptions))

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet())

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())

// ── CSRF protection ───────────────────────────────────────────────────────────
app.use(csrfProtection)

// ── Routes ────────────────────────────────────────────────────────────────────

// Auth (public + mixed)
app.use('/api/auth', authRouter)

// Public storefront — no auth required
app.use('/api/storefront', storefrontRouter)
app.use('/api/storefront/orders', storefrontOrdersRouter)

// Admin routes — require admin or staff role (full session only — not setupOnly)
app.use('/api/admin', requireAuth, requireAdminOrStaff, (req, res, next) => {
  next()
})

// Admin sub-routes
app.use('/api/admin/products',   requireAuth, requireAdminOrStaff, productsRouter)
app.use('/api/admin/categories', requireAuth, requireAdminOrStaff, categoriesRouter)
app.use('/api/admin/pricing',    requireAuth, requireAdminOrStaff, pricingRouter)
app.use('/api/admin/uploads',    requireAuth, requireAdminOrStaff, uploadsRouter)
app.use('/api/admin/orders',     requireAuth, requireAdminOrStaff, adminOrdersRouter)

// Admin-only sub-routes (settings, reports, users)
const adminOnlyPaths = ['/api/admin/settings', '/api/admin/reports', '/api/admin/staff']
adminOnlyPaths.forEach(path => {
  app.use(path, requireAuth, requireAdmin)
})

// Stub admin test route (verifies auth middleware works — used by integration tests)
app.get('/api/admin/ping', requireAuth, requireAdminOrStaff, (req, res) => {
  res.json({ ok: true, role: req.user.role })
})

// Stub admin-only test route
app.get('/api/admin/settings/ping', requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true })
})

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }))

// 404
app.use((_req, res) => res.status(404).json({ message: 'Not found.' }))

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ message: 'Internal server error.' })
})

export default app
