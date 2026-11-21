import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BILLING_CYCLES,
  PROMO_MESSAGES,
  discountedUsdcAmount,
  formatPromoTerms,
  promoAuthorization,
  promoCycles,
  validatePromoCode,
} from '../src/promo.js';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const MONTH = 2_592_000;
const plan = { id: 'plan-1', usdc_amount: '200000000', interval_seconds: MONTH }; // 20 USDC / month

const quote = (overrides = {}) => ({
  valid: true,
  code: 'HALF3',
  currency: 'USDC',
  original_amount: 200000000,
  discounted_amount: 100000000,
  savings: 100000000,
  duration_months: 3,
  expires_at: '2026-12-31T00:00:00Z',
  ...overrides,
});

const respond = (status, body) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
};

test('a valid code returns the quote and calls /api/promo/validate', async () => {
  const { fetchImpl, calls } = respond(200, quote());
  const result = await validatePromoCode({ apiUrl: 'https://api.test', planId: 'plan-1', code: '  half3 ', fetchImpl, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.quote.code, 'HALF3');
  assert.equal(calls[0].url, 'https://api.test/api/promo/validate');
  assert.deepEqual(JSON.parse(calls[0].init.body), { plan_id: 'plan-1', code: 'half3' });
});

test('an invalid code reports a clear reason', async () => {
  const { fetchImpl } = respond(422, { valid: false, reason: 'invalid', error: 'x' });
  const result = await validatePromoCode({ apiUrl: '', planId: 'plan-1', code: 'NOPE99', fetchImpl, now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'invalid', message: PROMO_MESSAGES.invalid });
});

test('an expired code is reported as expired, not merely invalid', async () => {
  const { fetchImpl } = respond(422, { valid: false, reason: 'expired' });
  const result = await validatePromoCode({ apiUrl: '', planId: 'plan-1', code: 'SUMMER', fetchImpl, now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'expired', message: 'This promo code has expired.' });
});

test('a quote whose expiry has already passed is refused locally', async () => {
  const { fetchImpl } = respond(200, quote({ expires_at: '2026-11-21T11:59:59Z' }));
  const result = await validatePromoCode({ apiUrl: '', planId: 'plan-1', code: 'HALF3', fetchImpl, now: NOW });
  assert.equal(result.reason, 'expired');
});

test('used-up and inapplicable codes get their own messages', async () => {
  for (const reason of ['exhausted', 'not_applicable']) {
    const { fetchImpl } = respond(422, { valid: false, reason });
    const result = await validatePromoCode({ apiUrl: '', planId: 'plan-1', code: 'HALF3', fetchImpl, now: NOW });
    assert.equal(result.message, PROMO_MESSAGES[reason]);
  }
});

test('malformed codes are rejected without a request', async () => {
  const { fetchImpl, calls } = respond(200, quote());
  for (const code of ['', 'ab', 'has space', 'x'.repeat(33), '<script>']) {
    const result = await validatePromoCode({ apiUrl: '', planId: 'plan-1', code, fetchImpl, now: NOW });
    assert.equal(result.reason, 'invalid', code);
  }
  assert.equal(calls.length, 0);
});

test('network failures and server errors are reported as retryable', async () => {
  const offline = await validatePromoCode({ apiUrl: '', planId: 'p', code: 'HALF3', now: NOW, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(offline.reason, 'network');
  const { fetchImpl } = respond(500, { error: 'boom' });
  assert.equal((await validatePromoCode({ apiUrl: '', planId: 'p', code: 'HALF3', fetchImpl, now: NOW })).reason, 'network');
});

test('a quote that would not lower the price is not applied', async () => {
  const { fetchImpl } = respond(200, quote({ discounted_amount: 200000000 }));
  assert.equal((await validatePromoCode({ apiUrl: '', planId: 'p', code: 'HALF3', fetchImpl, now: NOW })).reason, 'not_applicable');
});

test('without a promo the authorization is unchanged: plan amount for 12 cycles', () => {
  assert.deepEqual(promoAuthorization(plan, null), {
    amount: '200000000',
    billingCycles: DEFAULT_BILLING_CYCLES,
    allowance: '2400000000',
    promotional: false,
  });
});

test('a promo authorizes the discounted amount for exactly the promotional cycles', () => {
  // 20 USDC -> 10 USDC for the first 3 months: the subscriber signs for 30 USDC, not 240.
  assert.deepEqual(promoAuthorization(plan, quote()), {
    amount: '100000000',
    billingCycles: 3,
    allowance: '300000000',
    promotional: true,
  });
});

test('promotional months map onto the plan interval', () => {
  assert.equal(promoCycles(3, MONTH), 3);
  assert.equal(promoCycles(1, 7 * 86_400), 4); // weekly: ~4 cycles a month
  assert.equal(promoCycles(2, 86_400), 60); // daily
  assert.equal(promoCycles(1, 365 * 86_400), 1); // never less than one cycle
  assert.equal(promoCycles(0, MONTH), 1);
});

test('fiat-denominated quotes discount the USDC amount proportionally', () => {
  const fiat = quote({ currency: 'USD', original_amount: 20, discounted_amount: 15, duration_months: 2 });
  assert.equal(discountedUsdcAmount(plan, fiat), 150000000n);
  assert.deepEqual(promoAuthorization(plan, fiat), { amount: '150000000', billingCycles: 2, allowance: '300000000', promotional: true });
});

test('discount badges reflect the promotional terms', () => {
  assert.deepEqual(formatPromoTerms(quote()), {
    currency: 'USDC',
    original: '20.00',
    discounted: '10.00',
    period: 'for the first 3 months',
    badge: '-50%',
  });
  assert.equal(formatPromoTerms(quote({ duration_months: 1 })).period, 'for the first month');
  assert.equal(formatPromoTerms(quote({ currency: 'EUR', original_amount: 49.99, discounted_amount: 39.99 })).discounted, '39.99');
});
