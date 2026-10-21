import { Router } from 'express'
import { pricingPreview } from '../controllers/pricing.controller.js'
import { requireAdmin } from '../middleware/auth.js'

const router = Router()

// Admin-only — staff cannot see cost/profit
router.post('/preview', requireAdmin, pricingPreview)

export default router
