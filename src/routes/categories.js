import { Router } from 'express'
import { listCategories } from '../controllers/categories.controller.js'

const router = Router()

// Read-only — the 5 scent families are managed by `npm run seed:categories`
router.get('/', listCategories)

export default router
