/**
 * src/lib/pricing.js
 *
 * Pure pricing functions — no I/O, no side effects, no external imports.
 * All monetary values are INTEGER PAISE. Divide by 100 only at API response edges.
 *
 * Core formula derivation:
 *   Of every ₹1 the customer pays:
 *     - GST:              g / (1 + g)         ← included-in-price GST
 *     - Gateway fee:      f                   ← e.g. 2%
 *     - Gateway fee GST:  f × fg              ← 18% on the gateway fee
 *     - Remainder:        goes to cost + delivery + profit
 *
 *   So the "net fraction" that covers cost+delivery+profit is:
 *     k = 1/(1+g) − f×(1+fg)
 *
 *   Therefore:  grandTotal = ceil( (totalCost + totalProfit + delivery) / k, roundingStep )
 *
 *   With default settings (g=0.18, f=0.02, fg=0.18):
 *     k = 1/1.18 − 0.02×1.18 ≈ 0.823858
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Round `value` up to the nearest multiple of `step`.
 * Both inputs are in paise (integers). `value` may be a float during intermediate
 * calculation — the result is always an integer.
 *
 * @param {number} value - raw paise value (may be fractional)
 * @param {number} step  - rounding step in paise (e.g. 100 = ₹1)
 * @returns {number} integer paise
 */
export function ceilToStep(value, step) {
  if (step <= 0) throw new RangeError(`roundingStep must be > 0, got ${step}`);
  return Math.ceil(value / step) * step;
}

// ─── Core divisor ────────────────────────────────────────────────────────────

/**
 * Compute the k divisor from Settings.
 * k = 1/(1+gstRate) − gatewayFeeRate × (1+gatewayFeeGstRate)
 *
 * Do NOT hardcode this value — always derive it from Settings so that
 * changing a rate in the database automatically propagates.
 *
 * @param {object} settings - Settings document
 * @returns {number} k (≈ 0.823858 with default settings)
 */
export function computeK(settings) {
  const { gstRate, gatewayFeeRate, gatewayFeeGstRate } = settings;
  return 1 / (1 + gstRate) - gatewayFeeRate * (1 + gatewayFeeGstRate);
}

// ─── Catalog price (single unit, no delivery) ────────────────────────────────

/**
 * Compute the catalog display price for one unit of a variant.
 * This price excludes delivery — delivery appears as a separate line in the cart.
 *
 * unitPriceExclDelivery = ceilToStep((C + P) / k, roundingStep)
 *
 * @param {{ costPrice: number, minProfit: number }} variant - paise values
 * @param {object} settings
 * @returns {number} paise
 */
export function unitPriceExclDelivery(variant, settings) {
  const { costPrice, minProfit } = variant;
  const k = computeK(settings);
  return ceilToStep((costPrice + minProfit) / k, settings.roundingStep);
}

// ─── Shipping ─────────────────────────────────────────────────────────────────

/**
 * Count the number of delivery slabs for a cart.
 *
 * Rules:
 *  - Each bottle occupies exactly 1 slab.
 *  - Testers share slabs: ceil(testerQty / testersPerSlab) slabs.
 *  - By default (mixedCartSlabSharing = false), bottle slabs and tester slabs
 *    are counted separately and summed.
 *  - When mixedCartSlabSharing = true, testers fill remaining capacity in
 *    bottle slabs: treat each bottle as `testersPerSlab` tester-equivalents,
 *    then ceil(total_equivalents / testersPerSlab).
 *
 * @param {Array<{ type: string, qty: number }>} lines
 * @param {object} settings
 * @returns {number} number of slabs (integer ≥ 0)
 */
export function shippingSlabs(lines, settings) {
  const { testersPerSlab, mixedCartSlabSharing } = settings;

  let bottleQty = 0;
  let testerQty = 0;

  for (const line of lines) {
    if (line.type === 'bottle') bottleQty += line.qty;
    else if (line.type === 'tester') testerQty += line.qty;
  }

  if (mixedCartSlabSharing) {
    // Bottles and testers share a common slab pool.
    // A bottle is equivalent to testersPerSlab tester units for slab counting.
    const totalEquivalents = bottleQty * testersPerSlab + testerQty;
    return totalEquivalents === 0 ? 0 : Math.ceil(totalEquivalents / testersPerSlab);
  }

  // Default: separate slab pools for bottles and testers.
  const bottleSlabs = bottleQty;                                              // 1 slab per bottle
  const testerSlabs = testerQty > 0 ? Math.ceil(testerQty / testersPerSlab) : 0;
  return bottleSlabs + testerSlabs;
}

/**
 * Compute raw delivery cost in paise.
 *
 * @param {Array<{ type: string, qty: number }>} lines
 * @param {object} settings
 * @returns {number} paise (integer)
 */
export function shippingCost(lines, settings) {
  return shippingSlabs(lines, settings) * settings.deliveryPerSlab;
}

// ─── Order totals ─────────────────────────────────────────────────────────────

/**
 * Compute all order totals from cart lines and settings.
 *
 * grandTotal = ceilToStep( (ΣC·qty + ΣP·qty + D) / k, roundingStep )
 *
 * The customer-facing shipping line is derived as:
 *   shipping = grandTotal − Σ(unitPriceExclDelivery · qty)
 * so the numbers always add up exactly on the invoice.
 *
 * INVARIANT (asserted): netProfit >= Σ(minProfit·qty)
 * Ceiling rounding can only increase profit, never reduce it.
 *
 * @param {Array<{
 *   type: string,
 *   qty: number,
 *   costPrice: number,   // paise
 *   minProfit: number,   // paise
 * }>} lines
 * @param {object} settings
 * @returns {{
 *   grandTotal: number,
 *   linesTotal: number,
 *   shipping: number,
 *   gstAmount: number,
 *   gatewayFee: number,
 *   gatewayFeeGst: number,
 *   totalCost: number,
 *   netProfit: number,
 *   requiredProfit: number,
 *   rawDeliveryCost: number,
 *   k: number,
 *   lines: Array,        // input lines enriched with unitPrice
 * }}
 */
export function computeOrderTotals(lines, settings) {
  const { gstRate, gatewayFeeRate, gatewayFeeGstRate, roundingStep } = settings;
  const k = computeK(settings);

  let totalC = 0; // Σ costPrice × qty  (paise)
  let totalP = 0; // Σ minProfit  × qty  (paise)

  for (const line of lines) {
    totalC += line.costPrice * line.qty;
    totalP += line.minProfit * line.qty;
  }

  const D = shippingCost(lines, settings); // raw delivery cost (integer paise)

  // Grand total: single ceiling over the entire cart
  const grandTotal = ceilToStep((totalC + totalP + D) / k, roundingStep);

  // ── Breakdown (informational — grandTotal is the single authoritative number) ──
  // Use Math.round for breakdown items; rounding error goes into netProfit.
  const gstAmount     = Math.round(grandTotal * gstRate / (1 + gstRate));
  const gatewayFee    = Math.round(grandTotal * gatewayFeeRate);
  const gatewayFeeGst = Math.round(gatewayFee * gatewayFeeGstRate);
  const totalCost     = totalC + D;
  const netProfit     = grandTotal - gstAmount - gatewayFee - gatewayFeeGst - totalCost;

  // ── Profit invariant ──────────────────────────────────────────────────────────
  if (netProfit < totalP) {
    throw new Error(
      `Pricing invariant violated: netProfit (${netProfit} p) < requiredProfit (${totalP} p). ` +
      `grandTotal=${grandTotal}, k=${k}`
    );
  }

  // ── Per-line unit prices (for invoice display) ────────────────────────────────
  const enrichedLines = lines.map((line) => ({
    ...line,
    unitPrice: unitPriceExclDelivery(
      { costPrice: line.costPrice, minProfit: line.minProfit },
      settings
    ),
  }));

  const linesTotal = enrichedLines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
  // Derived shipping: always equals grandTotal minus line items — numbers add up exactly.
  const shipping = grandTotal - linesTotal;

  return {
    lines:           enrichedLines,
    linesTotal,
    shipping,          // displayed shipping line (may exceed rawDeliveryCost due to rounding)
    grandTotal,
    gstAmount,
    gatewayFee,
    gatewayFeeGst,
    totalCost,
    netProfit,
    requiredProfit:  totalP,
    rawDeliveryCost: D,   // raw paise before / k — useful for debugging
    k,
  };
}

// ─── Admin preview ────────────────────────────────────────────────────────────

/**
 * Full pricing preview for the admin product form.
 * Returns a breakdown for a single unit, and (for testers) a full-slab pack.
 *
 * @param {{ type: string, costPrice: number, minProfit: number }} variant
 * @param {object} settings
 */
export function previewPricing(variant, settings) {
  const { costPrice, minProfit, type } = variant;
  const { testersPerSlab } = settings;

  const singleLine = [{ type, qty: 1, costPrice, minProfit }];
  const single = computeOrderTotals(singleLine, settings);

  const result = {
    variant: { type, costPrice, minProfit },
    k: single.k,
    single: {
      grandTotal:    single.grandTotal,
      gstAmount:     single.gstAmount,
      gatewayFee:    single.gatewayFee,
      gatewayFeeGst: single.gatewayFeeGst,
      rawDelivery:   single.rawDeliveryCost,
      totalCost:     single.totalCost,
      netProfit:     single.netProfit,
    },
  };

  // Tester-only: show full-slab pack pricing (cheaper per unit due to shared slab)
  if (type === 'tester') {
    const packLine = [{ type, qty: testersPerSlab, costPrice, minProfit }];
    const pack = computeOrderTotals(packLine, settings);
    result.pack = {
      qty:           testersPerSlab,
      grandTotal:    pack.grandTotal,
      perUnit:       Math.round(pack.grandTotal / testersPerSlab), // approx, informational
      gstAmount:     pack.gstAmount,
      gatewayFee:    pack.gatewayFee,
      gatewayFeeGst: pack.gatewayFeeGst,
      rawDelivery:   pack.rawDeliveryCost,
      totalCost:     pack.totalCost,
      netProfit:     pack.netProfit,
    };
  }

  return result;
}
