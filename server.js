/**
 * server.js — HTTP entry point.
 * Connects to MongoDB then starts the Express server.
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import { config } from './src/config/index.js'
import app from './src/app.js'

async function start() {
  try {
    await mongoose.connect(config.mongoUri)
    console.log('✓ MongoDB connected')

    app.listen(config.port, () => {
      console.log(`✓ snifftok API listening on port ${config.port} [${config.nodeEnv}]`)
    })
  } catch (err) {
    console.error('Failed to start server:', err)
    process.exit(1)
  }
}

start()
