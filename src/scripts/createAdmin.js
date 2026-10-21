/**
 * Create or reset the admin account.
 * Usage: node src/scripts/createAdmin.js
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'admin@snifftok.com'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@snifftok2024'
const ADMIN_NAME     = process.env.ADMIN_NAME     || 'Admin'

await mongoose.connect(process.env.MONGODB_URI ?? process.env.MONGO_URI)

const User = mongoose.model('User', new mongoose.Schema({
  name:               String,
  email:              { type: String, lowercase: true },
  passwordHash:       String,
  role:               { type: String, default: 'customer' },
  isActive:           { type: Boolean, default: true },
  sessionVersion:     { type: Number, default: 1 },
  failedLoginCount:   { type: Number, default: 0 },
  twoFactor:          { enabled: { type: Boolean, default: false } },
}, { strict: false }))

const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12)
const existing     = await User.findOne({ email: ADMIN_EMAIL.toLowerCase() })

if (existing) {
  await User.updateOne({ _id: existing._id }, {
    $set: {
      passwordHash,
      role:                'admin',
      isActive:            true,
      'twoFactor.enabled': false,
      sessionVersion:      (existing.sessionVersion ?? 1) + 1,
      failedLoginCount:    0,
      lockedUntil:         null,
    }
  })
  console.log(`✓ Reset password + role for: ${ADMIN_EMAIL}`)
} else {
  await User.create({
    name: ADMIN_NAME,
    email: ADMIN_EMAIL.toLowerCase(),
    passwordHash,
    role:                'admin',
    isActive:            true,
    sessionVersion:      1,
    'twoFactor.enabled': false,
  })
  console.log(`✓ Created admin account: ${ADMIN_EMAIL}`)
}

console.log(`  Email:    ${ADMIN_EMAIL}`)
console.log(`  Password: ${ADMIN_PASSWORD}`)

await mongoose.disconnect()
