/**
 * src/models/Otp.js
 * Short-lived OTP document used for passwordless email login.
 *
 * Security design:
 * - Only the bcrypt hash of the code is stored (never the plaintext).
 * - `attempts` limits brute force to 5 guesses per OTP.
 * - `expiresAt` TTL index auto-deletes documents after 10 minutes.
 * - `used` flag prevents replay after a successful verification.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

const otpSchema = new Schema({
  email:     { type: String, required: true, lowercase: true, trim: true, index: true },
  codeHash:  { type: String, required: true },          // bcrypt hash of 6-digit code
  expiresAt: { type: Date,   required: true, index: { expireAfterSeconds: 0 } },
  attempts:  { type: Number, default: 0 },              // increment on wrong guess
  used:      { type: Boolean, default: false },         // flip to true after success
}, { timestamps: true })

export const Otp = mongoose.model('Otp', otpSchema)
