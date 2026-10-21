/**
 * src/tests/setup.js
 * Vitest global setup — starts MongoMemoryServer, connects Mongoose,
 * clears collections between tests.
 */

import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { beforeAll, afterAll, afterEach } from 'vitest'

// Override env for tests
process.env.NODE_ENV            = 'test'
process.env.SESSION_SECRET      = 'test-secret-at-least-32-chars-long-for-jwt'
process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64)  // 64 hex chars for tests
process.env.CLIENT_ORIGIN       = 'http://localhost:3000,http://localhost:5173'
process.env.COOKIE_DOMAIN       = ''

let mongod

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri())
}, 60_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
}, 30_000)

afterEach(async () => {
  // Wipe all collections between tests for isolation
  const collections = mongoose.connection.collections
  await Promise.all(Object.values(collections).map(c => c.deleteMany({})))
})
