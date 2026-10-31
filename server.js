/**
 * server.js — HTTP entry point.
 * Connects to MongoDB then starts the Express server.
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import { config } from './src/config/index.js'
import app from './src/app.js'
import { expireUnpaidOrders } from './src/lib/payments.js'

const EXPIRY_CHECK_MS = 5 * 60 * 1000   // cancel unpaid checkouts every 5 minutes

async function start() {
  try {
    await mongoose.connect(config.mongoUri)
    console.log('✓ MongoDB connected')

    app.listen(config.port, () => {
      console.log(`✓ snifftok API listening on port ${config.port} [${config.nodeEnv}]`)
    })

    // Release stock held by online orders that were never paid
    const expire = () => expireUnpaidOrders()
      .then(n => n && console.log(`✓ Cancelled ${n} unpaid order(s)`))
      .catch(err => console.error('Unpaid order check failed:', err.message))
    expire()
    setInterval(expire, EXPIRY_CHECK_MS).unref()
  } catch (err) {
    console.error('Failed to start server:', err)
    process.exit(1)
  }
}

start()
