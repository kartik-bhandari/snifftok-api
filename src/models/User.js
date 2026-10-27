import mongoose from 'mongoose'

const { Schema } = mongoose

const twoFactorSchema = new Schema({
  enabled:             { type: Boolean, default: false },
  secretEncrypted:     { type: String, default: null },    // AES-256-GCM encrypted base32 secret
  recoveryCodesHashed: { type: [String], default: [] },    // bcrypt hashes — shown only once
  verifiedAt:          { type: Date, default: null },
}, { _id: false })

const userSchema = new Schema({
  email:             { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash:      { type: String, required: false, select: false },  // absent for OTP-only customers
  name:              { type: String, required: true, trim: true },
  role:              { type: String, enum: ['customer', 'staff', 'admin'], default: 'customer' },
  isActive:          { type: Boolean, default: true },

  // Brute-force protection
  failedLoginCount:  { type: Number, default: 0 },
  lockedUntil:       { type: Date, default: null },

  // Session invalidation — increment on logout or password change
  sessionVersion:    { type: Number, default: 0, select: false },

  twoFactor:         { type: twoFactorSchema, default: () => ({}) },
  lastLoginAt:       { type: Date, default: null },
}, { timestamps: true })

/** Safe representation — never expose passwordHash, sessionVersion, twoFactor secrets */
userSchema.methods.toSafeObject = function () {
  return {
    id:               this._id.toString(),
    email:            this.email,
    name:             this.name,
    role:             this.role,
    twoFactorEnabled: this.twoFactor?.enabled ?? false,
    lastLoginAt:      this.lastLoginAt,
  }
}

export const User = mongoose.model('User', userSchema)
