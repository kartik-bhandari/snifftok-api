/**
 * src/scripts/seedCategories.js
 * Syncs the Category collection with the 5 scent families in
 * src/data/scentFamilies.js. Safe to run multiple times.
 *
 *   - Creates or updates each family (matched by slug)
 *   - Deactivates every other category (isActive: false — nothing is deleted)
 *   - Lists products still assigned to a deactivated category, so they can be
 *     re-assigned in the admin panel
 *
 * Usage:
 *   npm run seed:categories              # apply
 *   npm run seed:categories -- --dry-run # show what would change, write nothing
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import { config } from '../config/index.js'
import { Category } from '../models/Category.js'
import { Product } from '../models/Product.js'
import { SCENT_FAMILIES, SCENT_FAMILY_SLUGS } from '../data/scentFamilies.js'

const dryRun = process.argv.includes('--dry-run')

async function seed() {
  await mongoose.connect(config.mongoUri)
  console.log(`✓ Connected to MongoDB${dryRun ? ' (dry run — no changes will be written)' : ''}\n`)

  // ── Upsert the 5 families ──────────────────────────────────────────────────
  for (const family of SCENT_FAMILIES) {
    const exists = await Category.exists({ slug: family.slug })
    if (!dryRun) {
      await Category.updateOne(
        { slug: family.slug },
        { $set: { ...family, isActive: true } },
        { upsert: true, runValidators: true },
      )
    }
    console.log(`  ${exists ? '↻ Update' : '+ Create'}: ${family.name}`)
  }

  // ── Deactivate everything else ─────────────────────────────────────────────
  const others = await Category.find({ slug: { $nin: SCENT_FAMILY_SLUGS }, isActive: true }).lean()
  for (const c of others) console.log(`  – Deactivate: ${c.name}`)
  if (!dryRun && others.length) {
    await Category.updateMany({ _id: { $in: others.map(c => c._id) } }, { $set: { isActive: false } })
  }

  // ── Products that need a new category ──────────────────────────────────────
  const inactiveIds = (await Category.find({ slug: { $nin: SCENT_FAMILY_SLUGS } }).select('_id').lean()).map(c => c._id)
  const orphans = await Product.find({
    $or: [{ categoryId: { $in: inactiveIds } }, { categoryId: null }, { categoryId: { $exists: false } }],
  }).select('name').lean()

  if (orphans.length) {
    console.log(`\n⚠  ${orphans.length} product(s) need one of the 5 categories — set it in the admin panel:`)
    for (const p of orphans) console.log(`     • ${p.name}`)
  }

  console.log(`\nDone${dryRun ? ' (dry run)' : ''}.`)
  await mongoose.disconnect()
}

seed().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
