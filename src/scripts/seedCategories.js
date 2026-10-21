/**
 * src/scripts/seedCategories.js
 * Seeds the default product categories. Safe to run multiple times.
 *
 * Usage: npm run seed:categories
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import { config } from '../config/index.js'
import { Category } from '../models/Category.js'

const DEFAULT_CATEGORIES = [
  'Men',
  'Women',
  'Unisex',
  'Oud',
  'Attar',
  'Arabic Fragrances',
]

async function seed() {
  await mongoose.connect(config.mongoUri)
  console.log('✓ Connected to MongoDB')

  let created = 0
  let skipped = 0

  for (const name of DEFAULT_CATEGORIES) {
    try {
      await Category.create({ name })
      console.log(`  ✓ Created: ${name}`)
      created++
    } catch (err) {
      if (err.code === 11000) {
        console.log(`  – Skipped (exists): ${name}`)
        skipped++
      } else {
        throw err
      }
    }
  }

  console.log(`\nDone — ${created} created, ${skipped} already existed.`)
  await mongoose.disconnect()
}

seed().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
