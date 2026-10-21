/**
 * src/scripts/seedAdmin.js
 * Creates or updates the first admin user from environment variables.
 * Safe to run multiple times — uses upsert.
 *
 * Usage:
 *   node src/scripts/seedAdmin.js
 *   npm run seed
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { config } from '../config/index.js'
import { User } from '../models/User.js'

const email    = process.env.ADMIN_EMAIL
const password = process.env.ADMIN_PASSWORD
const name     = process.env.ADMIN_NAME ?? 'Admin'

if (!email || !password) {
  console.error('❌  ADMIN_EMAIL and ADMIN_PASSWORD must be set in env.')
  process.exit(1)
}

async function seed() {
  await mongoose.connect(config.mongoUri)
  console.log('✓ Connected to MongoDB')

  const passwordHash = await bcrypt.hash(password, 12)

  const result = await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      $setOnInsert: { email: email.toLowerCase(), name, role: 'admin' },
      $set:         { passwordHash, isActive: true, failedLoginCount: 0, lockedUntil: null },
    },
    { upsert: true, new: true, runValidators: true },
  )

  const action = result.createdAt?.getTime() === result.updatedAt?.getTime() ? 'created' : 'updated'
  console.log(`✓ Admin user ${action}: ${result.email} (${result._id})`)

  await mongoose.disconnect()
}

seed().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
