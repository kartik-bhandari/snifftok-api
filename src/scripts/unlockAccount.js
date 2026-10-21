/**
 * src/scripts/unlockAccount.js
 * Usage: node src/scripts/unlockAccount.js <email>
 * Resets failedLoginCount and clears lockedUntil for a given account.
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import { config } from '../config/index.js'

const email = process.argv[2]
if (!email) {
  console.error('Usage: node src/scripts/unlockAccount.js <email>')
  process.exit(1)
}

await mongoose.connect(config.mongoUri)
console.log('✓ Connected to MongoDB')

const result = await mongoose.connection.db.collection('users').updateOne(
  { email: email.toLowerCase().trim() },
  {
    $set: {
      failedLoginCount: 0,
      lockedUntil:      null,
    },
  },
)

if (result.matchedCount === 0) {
  console.error(`✗ No user found with email: ${email}`)
} else {
  console.log(`✓ Unlocked account: ${email}`)
}

await mongoose.disconnect()
