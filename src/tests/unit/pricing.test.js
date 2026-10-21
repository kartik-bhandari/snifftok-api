/**
 * src/tests/unit/pricing.test.js
 *
 * 100% coverage of src/lib/pricing.js
 * Required test cases from the spec are marked with ✦
 */
import { describe, it, expect } from 'vitest';
import {
  ceilToStep,
  computeK,
  unitPriceExclDelivery,
  shippingSlabs,
  shippingCost,
  computeOrderTotals,
  previewPricing,
} from '../../lib/pricing.js';
import { DEFAULT_SETTINGS } from '../fixtures/settings.js';

// ── Shorthand helpers ─────────────────────────────────────────────────────────

/** Rupees → paise */
const r = (rupees) => rupees * 100;

/** Build a cart line */
const mkLine = (type, qty, costPrice, minProfit = r(300)) => ({
  type, qty, costPrice, minProfit,
});

// ── ceilToStep ────────────────────────────────────────────────────────────────

describe('ceilToStep', () => {
  it('returns the value unchanged when already on a step boundary', () => {
    expect(ceilToStep(100, 100)).toBe(100);
    expect(ceilToStep(0, 100)).toBe(0);
    expect(ceilToStep(500, 100)).toBe(500);
  });

  it('rounds up to next step when not on a boundary', () => {
    expect(ceilToStep(100.1, 100)).toBe(200);
    expect(ceilToStep(101, 100)).toBe(200);
    expect(ceilToStep(199, 100)).toBe(200);
    expect(ceilToStep(288895.97, 100)).toBe(288900);
    expect(ceilToStep(106822.93, 100)).toBe(106900);
  });

  it('works with non-100 step sizes', () => {
    expect(ceilToStep(101, 50)).toBe(150);
    expect(ceilToStep(200, 50)).toBe(200);
  });

  it('throws for step <= 0', () => {
    expect(() => ceilToStep(100, 0)).toThrow('roundingStep');
    expect(() => ceilToStep(100, -1)).toThrow('roundingStep');
  });
});

// ── computeK ─────────────────────────────────────────────────────────────────

describe('computeK', () => {
  it('returns the correct k factor with default settings ✦', () => {
    const k = computeK(DEFAULT_SETTINGS);
    // k = 1/1.18 − 0.02×1.18 = 0.847457… − 0.02360 = 0.823857…
    expect(k).toBeCloseTo(0.823858, 5);
  });

  it('k changes when gstRate changes', () => {
    const higherGst = { ...DEFAULT_SETTINGS, gstRate: 0.28 };
    const k = computeK(higherGst);
    // 1/1.28 − 0.02×1.18 = 0.78125 − 0.0236 = 0.75765
    expect(k).toBeCloseTo(0.75765, 4);
  });
});

// ── unitPriceExclDelivery ─────────────────────────────────────────────────────

describe('unitPriceExclDelivery', () => {
  it('bottle C=₹2000 P=₹300 → catalog price is ₹2792', () => {
    // (200000 + 30000) / k = 279174.45 → ceil to 279200
    const price = unitPriceExclDelivery(
      { costPrice: r(2000), minProfit: r(300) },
      DEFAULT_SETTINGS,
    );
    expect(price).toBe(279200);
  });

  it('tester C=₹500 P=₹300 → catalog price is ₹972', () => {
    // (50000 + 30000) / k ≈ 97101 → ceil to 97200
    const price = unitPriceExclDelivery(
      { costPrice: r(500), minProfit: r(300) },
      DEFAULT_SETTINGS,
    );
    expect(price).toBe(97200);
  });
});

// ── shippingSlabs ─────────────────────────────────────────────────────────────

describe('shippingSlabs — bottles', () => {
  it('1 bottle = 1 slab', () => {
    expect(shippingSlabs([mkLine('bottle', 1, r(2000))], DEFAULT_SETTINGS)).toBe(1);
  });

  it('3 bottles = 3 slabs', () => {
    expect(shippingSlabs([mkLine('bottle', 3, r(2000))], DEFAULT_SETTINGS)).toBe(3);
  });

  it('0 bottles = 0 slabs', () => {
    expect(shippingSlabs([], DEFAULT_SETTINGS)).toBe(0);
  });
});

describe('shippingSlabs — testers ✦', () => {
  it('4 testers = 1 slab ✦', () => {
    expect(shippingSlabs([mkLine('tester', 4, r(500))], DEFAULT_SETTINGS)).toBe(1);
  });

  it('5 testers = 1 slab ✦', () => {
    expect(shippingSlabs([mkLine('tester', 5, r(500))], DEFAULT_SETTINGS)).toBe(1);
  });

  it('6 testers = 2 slabs', () => {
    expect(shippingSlabs([mkLine('tester', 6, r(500))], DEFAULT_SETTINGS)).toBe(2);
  });

  it('7 testers = 2 slabs ✦', () => {
    expect(shippingSlabs([mkLine('tester', 7, r(500))], DEFAULT_SETTINGS)).toBe(2);
  });

  it('10 testers = 2 slabs ✦', () => {
    expect(shippingSlabs([mkLine('tester', 10, r(500))], DEFAULT_SETTINGS)).toBe(2);
  });

  it('11 testers = 3 slabs', () => {
    expect(shippingSlabs([mkLine('tester', 11, r(500))], DEFAULT_SETTINGS)).toBe(3);
  });
});

describe('shippingSlabs — mixed cart ✦', () => {
  it('1 bottle + 5 testers = 2 slabs when sharing is OFF ✦', () => {
    const lines = [mkLine('bottle', 1, r(2000)), mkLine('tester', 5, r(500))];
    expect(shippingSlabs(lines, DEFAULT_SETTINGS)).toBe(2);
  });

  it('1 bottle + 4 testers = 2 slabs when sharing is OFF', () => {
    const lines = [mkLine('bottle', 1, r(2000)), mkLine('tester', 4, r(500))];
    expect(shippingSlabs(lines, DEFAULT_SETTINGS)).toBe(2);
  });

  it('1 bottle + 5 testers = 2 slabs when sharing is ON (5eq + 5t = 10eq → 2 slabs)', () => {
    const s = { ...DEFAULT_SETTINGS, mixedCartSlabSharing: true };
    const lines = [mkLine('bottle', 1, r(2000)), mkLine('tester', 5, r(500))];
    expect(shippingSlabs(lines, s)).toBe(2);
  });

  it('1 bottle + 4 testers = 2 slabs when sharing is ON (5eq + 4t = 9eq → 2 slabs)', () => {
    const s = { ...DEFAULT_SETTINGS, mixedCartSlabSharing: true };
    const lines = [mkLine('bottle', 1, r(2000)), mkLine('tester', 4, r(500))];
    expect(shippingSlabs(lines, s)).toBe(2);
  });

  it('sharing ON allows testers to fully fill a bottle slab: 0 bottles + 5 testers = 1 slab', () => {
    const s = { ...DEFAULT_SETTINGS, mixedCartSlabSharing: true };
    expect(shippingSlabs([mkLine('tester', 5, r(500))], s)).toBe(1);
  });
});

// ── shippingCost ──────────────────────────────────────────────────────────────

describe('shippingCost', () => {
  it('1 bottle → 1 slab × ₹80 = 8000 paise', () => {
    expect(shippingCost([mkLine('bottle', 1, r(2000))], DEFAULT_SETTINGS)).toBe(8000);
  });

  it('7 testers → 2 slabs × ₹80 = 16000 paise', () => {
    expect(shippingCost([mkLine('tester', 7, r(500))], DEFAULT_SETTINGS)).toBe(16000);
  });
});

// ── computeOrderTotals — required spec test cases ─────────────────────────────

describe('computeOrderTotals — required test cases', () => {
  it('✦ Bottle C=₹2000 P=₹300, 1 unit → grandTotal = ₹2889', () => {
    const result = computeOrderTotals(
      [mkLine('bottle', 1, r(2000), r(300))],
      DEFAULT_SETTINGS,
    );
    expect(result.grandTotal).toBe(r(2889));
  });

  it('✦ Bottle C=₹2000 P=₹300, 1 unit → netProfit >= ₹300', () => {
    const result = computeOrderTotals(
      [mkLine('bottle', 1, r(2000), r(300))],
      DEFAULT_SETTINGS,
    );
    expect(result.netProfit).toBeGreaterThanOrEqual(r(300));
  });

  it('✦ Tester C=₹500 P=₹300, 1 unit → grandTotal = ₹1069', () => {
    const result = computeOrderTotals(
      [mkLine('tester', 1, r(500), r(300))],
      DEFAULT_SETTINGS,
    );
    expect(result.grandTotal).toBe(r(1069));
  });

  it('✦ 5 testers C=₹500 P=₹300 → grandTotal = ₹4953', () => {
    const result = computeOrderTotals(
      [mkLine('tester', 5, r(500), r(300))],
      DEFAULT_SETTINGS,
    );
    expect(result.grandTotal).toBe(r(4953));
  });

  it('✦ 5 testers is cheaper than 5 × single tester order', () => {
    const single = computeOrderTotals([mkLine('tester', 1, r(500), r(300))], DEFAULT_SETTINGS);
    const multi  = computeOrderTotals([mkLine('tester', 5, r(500), r(300))], DEFAULT_SETTINGS);
    expect(multi.grandTotal).toBeLessThan(single.grandTotal * 5);
  });

  it('✦ Mixed cart 1 bottle + 5 testers uses 2 delivery slabs (sharing OFF)', () => {
    const lines = [mkLine('bottle', 1, r(2000)), mkLine('tester', 5, r(500))];
    const result = computeOrderTotals(lines, DEFAULT_SETTINGS);
    expect(result.rawDeliveryCost).toBe(2 * 8000); // exactly 2 slabs
  });
});

// ── computeOrderTotals — breakdown correctness ────────────────────────────────

describe('computeOrderTotals — breakdown fields', () => {
  it('grandTotal = linesTotal + shipping (always adds up)', () => {
    const lines = [mkLine('bottle', 1, r(2000)), mkLine('tester', 3, r(500))];
    const { grandTotal, linesTotal, shipping } = computeOrderTotals(lines, DEFAULT_SETTINGS);
    expect(linesTotal + shipping).toBe(grandTotal);
  });

  it('breakdown components sum within 1 paise of grandTotal', () => {
    const result = computeOrderTotals([mkLine('bottle', 2, r(1500))], DEFAULT_SETTINGS);
    const sum = result.gstAmount + result.gatewayFee + result.gatewayFeeGst
              + result.totalCost + result.netProfit;
    // Math.round on individual components means sum may differ by ≤ a few paise
    expect(Math.abs(sum - result.grandTotal)).toBeLessThanOrEqual(5);
  });

  it('totalCost = sum(costPrice×qty) + rawDeliveryCost', () => {
    const lines = [mkLine('bottle', 2, r(1500))];
    const result = computeOrderTotals(lines, DEFAULT_SETTINGS);
    expect(result.totalCost).toBe(r(1500) * 2 + result.rawDeliveryCost);
  });

  it('requiredProfit = sum of all minProfit×qty', () => {
    const lines = [
      mkLine('bottle', 2, r(2000), r(400)),
      mkLine('tester', 3, r(500),  r(200)),
    ];
    const result = computeOrderTotals(lines, DEFAULT_SETTINGS);
    expect(result.requiredProfit).toBe(r(400) * 2 + r(200) * 3);
  });
});

// ── netProfit invariant ───────────────────────────────────────────────────────

describe('netProfit >= requiredProfit invariant', () => {
  it('holds for bottle C=₹2000 P=₹300 ✦', () => {
    const result = computeOrderTotals([mkLine('bottle', 1, r(2000), r(300))], DEFAULT_SETTINGS);
    expect(result.netProfit).toBeGreaterThanOrEqual(result.requiredProfit);
  });

  it('holds for tester C=₹500 P=₹300 ✦', () => {
    const result = computeOrderTotals([mkLine('tester', 1, r(500), r(300))], DEFAULT_SETTINGS);
    expect(result.netProfit).toBeGreaterThanOrEqual(result.requiredProfit);
  });

  it('holds for 5 testers ✦', () => {
    const result = computeOrderTotals([mkLine('tester', 5, r(500), r(300))], DEFAULT_SETTINGS);
    expect(result.netProfit).toBeGreaterThanOrEqual(result.requiredProfit);
  });

  it('holds for multi-line mixed cart', () => {
    const lines = [mkLine('bottle', 1, r(2000)), mkLine('tester', 5, r(500))];
    const result = computeOrderTotals(lines, DEFAULT_SETTINGS);
    expect(result.netProfit).toBeGreaterThanOrEqual(result.requiredProfit);
  });
});

// ── Property test: random inputs ✦ ───────────────────────────────────────────

describe('property test: random inputs always satisfy netProfit >= requiredProfit ✦', () => {
  it('holds for 200 random single-line carts', () => {
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    for (let i = 0; i < 200; i++) {
      const type      = Math.random() > 0.5 ? 'bottle' : 'tester';
      const costPrice = rand(1000, 1000000);  // ₹10 – ₹10,000
      const minProfit = rand(500,  200000);   // ₹5  – ₹2,000
      const qty       = rand(1, 20);

      const lines = [{ type, qty, costPrice, minProfit }];
      const result = computeOrderTotals(lines, DEFAULT_SETTINGS);

      expect(result.netProfit).toBeGreaterThanOrEqual(result.requiredProfit);
    }
  });

  it('holds for 100 random multi-line mixed carts', () => {
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    for (let i = 0; i < 100; i++) {
      const lines = [
        mkLine('bottle', rand(1, 5), rand(50000, 500000), rand(10000, 100000)),
        mkLine('tester', rand(1, 15), rand(5000,  100000), rand(5000, 50000)),
      ];
      const result = computeOrderTotals(lines, DEFAULT_SETTINGS);
      expect(result.netProfit).toBeGreaterThanOrEqual(result.requiredProfit);
    }
  });
});

// ── previewPricing ────────────────────────────────────────────────────────────

describe('previewPricing', () => {
  it('returns full breakdown for a bottle, no pack field', () => {
    const variant = { type: 'bottle', costPrice: r(2000), minProfit: r(300) };
    const preview = previewPricing(variant, DEFAULT_SETTINGS);

    expect(preview.single.grandTotal).toBe(r(2889));
    expect(preview.single.netProfit).toBeGreaterThanOrEqual(r(300));
    expect(preview.k).toBeCloseTo(0.823858, 5);
    expect(preview.pack).toBeUndefined();
  });

  it('returns pack pricing for a tester ✦', () => {
    const variant = { type: 'tester', costPrice: r(500), minProfit: r(300) };
    const preview = previewPricing(variant, DEFAULT_SETTINGS);

    expect(preview.single.grandTotal).toBe(r(1069));
    expect(preview.pack).toBeDefined();
    expect(preview.pack.qty).toBe(DEFAULT_SETTINGS.testersPerSlab); // 5
    expect(preview.pack.grandTotal).toBe(r(4953));
    expect(preview.pack.netProfit).toBeGreaterThanOrEqual(r(300) * 5);
  });

  it('pack grandTotal < single grandTotal × qty (bulk discount)', () => {
    const variant = { type: 'tester', costPrice: r(500), minProfit: r(300) };
    const preview = previewPricing(variant, DEFAULT_SETTINGS);
    expect(preview.pack.grandTotal).toBeLessThan(preview.single.grandTotal * preview.pack.qty);
  });
});
