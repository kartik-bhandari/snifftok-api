/**
 * Default Settings fixture for unit tests.
 * Mirrors the singleton Settings document in MongoDB.
 * All monetary values are integer paise.
 */
export const DEFAULT_SETTINGS = {
  gstRate:              0.18,
  gatewayFeeRate:       0.02,
  gatewayFeeGstRate:    0.18,
  deliveryPerSlab:      8000,   // ₹80 per slab
  testersPerSlab:       5,
  defaultMinProfit: {
    bottle:             30000,  // ₹300
    tester:             30000,  // ₹300
  },
  roundingStep:         100,    // round up to nearest ₹1
  mixedCartSlabSharing: false,
  reservationHoldHours: 24,
  vendor: {
    name:            'snifftok',
    whatsappNumber:  '919876543210',
  },
};
