import { Router } from 'express'
import {
  listProducts, getProduct, createProduct,
  updateProduct, deleteProduct, archiveProduct, checkSku,
} from '../controllers/products.controller.js'
import { requireAdmin } from '../middleware/auth.js'

const router = Router()

router.get('/sku-check',    checkSku)         // GET /api/admin/products/sku-check?sku=...
router.get('/',             listProducts)
router.get('/:id',          getProduct)
router.post('/',            createProduct)
router.put('/:id',          updateProduct)
router.delete('/:id',       requireAdmin, deleteProduct)        // admin-only
router.post('/:id/archive', archiveProduct)

export default router
