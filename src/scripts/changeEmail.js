/**
 * src/scripts/changeEmail.js
 * Moves an existing account to a new email address — e.g. to replace a dummy
 * admin email with a real inbox that can receive OTP codes.
 * Role, password and 2FA are kept. All existing sessions are signed out.
 *
 * Usage:
 *   node src/scripts/changeEmail.js <old-email> <new-email>
 *   npm run change-email -- <old-email> <new-email>
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import { config } from '../config/index.js'
import { User } from '../models/User.js'

const [oldEmail, newEmail] = process.argv.slice(2).map(e => e?.trim().toLowerCase())

if (!oldEmail || !newEmail) {
  console.error('Usage: node src/scripts/changeEmail.js <old-email> <new-email>')
  process.exit(1)
}

await mongoose.connect(config.mongoUri)

const user = await User.findOne({ email: oldEmail })
if (!user) {
  console.error('❌ No user found with email:', oldEmail)
  process.exit(1)
}

if (await User.exists({ email: newEmail })) {
  console.error('❌ Another account already uses:', newEmail)
  console.error('   Delete or rename that account first, or promote it with makeAdmin.js instead.')
  process.exit(1)
}

await User.updateOne({ _id: user._id }, {
  $set: { email: newEmail },
  $inc: { sessionVersion: 1 },   // invalidate sessions issued under the old email
})

console.log(`✓ ${oldEmail} → ${newEmail} (role: ${user.role})`)
await mongoose.disconnect()
