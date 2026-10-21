import { Router } from 'express'
import { getUploadSignature, discardImages } from '../controllers/uploads.controller.js'

const router = Router()

router.post('/signature', getUploadSignature)
router.post('/discard',   discardImages)

export default router
