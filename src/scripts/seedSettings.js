import 'dotenv/config'
import mongoose from 'mongoose'

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/snifftok'
await mongoose.connect(uri)
console.log('Connected to', uri)

const Settings = mongoose.model('Settings', new mongoose.Schema(
  { _id: { type: String, default: 'global' } },
  { strict: false, _id: false }
))

let doc = await Settings.findById('global').lean()
if (!doc) {
  doc = await Settings.create({
    _id: 'global',
    gstRate: 0.18,
    gatewayFeeRate: 0.02,
    gatewayFeeGstRate: 0.18,
    deliveryPerSlab: 8000,
    testersPerSlab: 5,
    roundingStep: 100,
  })
  console.log('✓ Settings seeded with defaults')
} else {
  console.log('✓ Settings already exist:', JSON.stringify(doc, null, 2))
}

await mongoose.disconnect()
console.log('Done.')
