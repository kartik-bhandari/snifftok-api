/**
 * Promote an existing user to admin role (no 2FA required for dev).
 * Usage: node src/scripts/makeAdmin.js your@email.com
 */
import 'dotenv/config'
import mongoose from 'mongoose'

const email = process.argv[2]
if (!email) {
  console.error('Usage: node src/scripts/makeAdmin.js <email>')
  process.exit(1)
}

await mongoose.connect(process.env.MONGO_URI ?? process.env.MONGODB_URI)

const User = mongoose.model('User', new mongoose.Schema({
  email:          String,
  role:           String,
  twoFactor:      { enabled: Boolean },
  isActive:       Boolean,
}, { strict: false }))

const user = await User.findOne({ email: email.toLowerCase() })
if (!user) {
  console.error('❌ No user found with email:', email)
  process.exit(1)
}

await User.updateOne({ _id: user._id }, {
  $set: {
    role:                   'admin',
    'twoFactor.enabled':    false,   // skip 2FA so login goes straight to session
    isActive:               true,
  }
})

console.log(`✓ ${email} is now admin (2FA disabled for dev)`)
await mongoose.disconnect()
