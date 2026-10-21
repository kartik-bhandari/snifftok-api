/**
 * src/lib/cloudinary.js
 * Cloudinary SDK configuration and helper functions.
 *
 * SECURITY: CLOUDINARY_API_SECRET is NEVER sent to the browser.
 * The signature endpoint only returns the signature and public params.
 */

import { v2 as cloudinary } from 'cloudinary'
import { config } from '../config/index.js'

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key:    config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure:     true,
})

export { cloudinary }

/**
 * Generate a signed upload signature for direct browser uploads.
 * Returns only the fields needed by the browser — never the API secret.
 *
 * @param {string} folder - Cloudinary folder (e.g. 'snifftok/products')
 * @returns {{ signature, timestamp, apiKey, cloudName, folder }}
 */
export function generateUploadSignature(folder = 'snifftok/products') {
  const timestamp = Math.round(Date.now() / 1000)

  // Only sign params that are actually included in the upload request.
  // allowed_formats is NOT included in the signature — it's enforced server-side
  // via Cloudinary upload presets, or simply validated post-upload.
  const paramsToSign = {
    folder,
    timestamp,
  }

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    config.cloudinary.apiSecret,
  )

  return {
    signature,
    timestamp,
    apiKey:    config.cloudinary.apiKey,
    cloudName: config.cloudinary.cloudName,
    folder,
    allowedFormats: 'jpg,jpeg,png,webp',  // sent in FormData but NOT signed
  }
}

/**
 * Delete images from Cloudinary by publicId.
 * Returns results keyed by publicId.
 *
 * @param {string[]} publicIds
 * @returns {Promise<object>}
 */
export async function deleteImages(publicIds) {
  if (!publicIds?.length) return {}
  try {
    const result = await cloudinary.api.delete_resources(publicIds, {
      resource_type: 'image',
    })
    return result
  } catch (err) {
    console.error('[cloudinary] deleteImages error:', err.message)
    return { error: err.message }
  }
}
