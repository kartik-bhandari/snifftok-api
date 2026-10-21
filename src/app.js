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
import { requireAuth, requireAdminOrStaff, requireAdmin } from './middleware/auth.js'

const app = express()

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet())

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: config.clientOrigins,
  credentials: true,
  allowedHeaders: ['Content-Type', 'X-Requested-With', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}))

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

// Admin routes — require admin or staff role (full session only — not setupOnly)
app.use('/api/admin', requireAuth, requireAdminOrStaff, (req, res, next) => {
  next()
})

// Admin sub-routes
app.use('/api/admin/products',   requireAuth, requireAdminOrStaff, productsRouter)
app.use('/api/admin/categories', requireAuth, requireAdminOrStaff, categoriesRouter)
app.use('/api/admin/pricing',    requireAuth, requireAdminOrStaff, pricingRouter)
app.use('/api/admin/uploads',    requireAuth, requireAdminOrStaff, uploadsRouter)

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
