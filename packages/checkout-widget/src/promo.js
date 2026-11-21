/**
 * Promo codes in <OrbitCheckout /> (#299).
 *
 * `validatePromoCode` asks the merchant API whether a code applies to the plan
 * and returns a discount quote or a specific, user-facing reason it does not.
 * `promoAuthorization` turns that quote into the parameters the vault is
 * authorized with, so the allowance the subscriber signs in Freighter matches
 * the discounted schedule rather than the full price.
 *
 * Why the promotional period is authorized on its own: an Orbit vault pulls
 * exactly `amount_per_interval` every cycle, so it cannot charge a discounted
 * price and later the regular one. With a promo, the vault is created at the
 * discounted amount for the promotional cycles only, and the allowance is
 * exactly `discounted amount × promotional cycles`. The regular price then
 * needs a fresh authorization (the backend's price re-authorization flow),
 * which the checkout states up front.
 *
 * No React here, so the logic is unit-tested with node:test.
 */

const STROOPS_PER_USDC = 10_000_000;
const DAYS_PER_MONTH = 30;
const SECONDS_PER_DAY = 86_400;
/** Cycles authorized when no promo applies (unchanged default). */
export const DEFAULT_BILLING_CYCLES = 12;

const CODE_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

export const PROMO_MESSAGES = {
  invalid: 'This promo code is not valid.',
  expired: 'This promo code has expired.',
  exhausted: 'This promo code has reached its redemption limit.',
  not_applicable: 'This promo code cannot be applied to this plan.',
  network: 'Could not check this promo code. Check your connection and try again.',
};

/**
 * Validates `code` for `planId` via `POST {apiUrl}/api/promo/validate`.
 * Resolves `{ ok: true, quote }` or `{ ok: false, reason, message }`; never
 * throws, so the form can show the message and keep what the user typed.
 */
export async function validatePromoCode({ apiUrl, planId, code, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const trimmed = String(code ?? '').trim();
  if (!CODE_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'invalid', message: PROMO_MESSAGES.invalid };
  }

  let response;
  let payload;
  try {
    response = await fetchImpl(`${apiUrl}/api/promo/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan_id: planId, code: trimmed }),
    });
    payload = await response.json().catch(() => ({}));
  } catch {
    return { ok: false, reason: 'network', message: PROMO_MESSAGES.network };
  }

  if (!response.ok || !payload?.valid) {
    const reason = PROMO_MESSAGES[payload?.reason] ? payload.reason : response.status >= 500 ? 'network' : 'invalid';
    return { ok: false, reason, message: PROMO_MESSAGES[reason] };
  }
  // Never apply a quote that has already run out, even if the server raced it.
  if (payload.expires_at && Date.parse(payload.expires_at) <= now) {
    return { ok: false, reason: 'expired', message: PROMO_MESSAGES.expired };
  }
  const discounted = Number(payload.discounted_amount);
  const original = Number(payload.original_amount);
  if (!(discounted > 0) || !(original > discounted) || !(Number(payload.duration_months) >= 1)) {
    return { ok: false, reason: 'not_applicable', message: PROMO_MESSAGES.not_applicable };
  }
  return { ok: true, quote: payload };
}

/** Billing cycles the promotional months span for this plan's interval (at least one). */
export function promoCycles(durationMonths, intervalSeconds) {
  const months = Number(durationMonths);
  const interval = Number(intervalSeconds);
  if (!(months > 0) || !(interval > 0)) return 1;
  return Math.max(1, Math.round((months * DAYS_PER_MONTH * SECONDS_PER_DAY) / interval));
}

/**
 * The discounted per-cycle amount in raw USDC units (7 decimals). USDC plans are
 * quoted in raw units already; fiat plans are discounted proportionally from
 * the plan's USDC amount.
 */
export function discountedUsdcAmount(plan, quote) {
  const usdc = BigInt(plan.usdc_amount);
  if ((quote.currency ?? 'USDC') === 'USDC') return BigInt(Math.floor(Number(quote.discounted_amount)));
  // Fiat: scale the USDC amount by discounted/original, in integer math.
  const scale = 1_000_000n;
  const ratio = BigInt(Math.floor((Number(quote.discounted_amount) / Number(quote.original_amount)) * Number(scale)));
  return (usdc * ratio) / scale;
}

/**
 * Vault authorization parameters for the checkout. Without a promo: the plan
 * amount for `DEFAULT_BILLING_CYCLES`. With one: the discounted amount for the
 * promotional cycles, so `allowance = amount × billingCycles` is exactly what
 * the discounted schedule costs.
 */
export function promoAuthorization(plan, quote) {
  if (!quote) {
    const amount = BigInt(plan.usdc_amount);
    return {
      amount: amount.toString(),
      billingCycles: DEFAULT_BILLING_CYCLES,
      allowance: (amount * BigInt(DEFAULT_BILLING_CYCLES)).toString(),
      promotional: false,
    };
  }
  const amount = discountedUsdcAmount(plan, quote);
  if (amount <= 0n) throw new RangeError('Discounted amount must be positive');
  const billingCycles = promoCycles(quote.duration_months, plan.interval_seconds);
  return {
    amount: amount.toString(),
    billingCycles,
    allowance: (amount * BigInt(billingCycles)).toString(),
    promotional: true,
  };
}

const formatAmount = (amount, currency) =>
  (currency === 'USDC' ? Number(amount) / STROOPS_PER_USDC : Number(amount)).toFixed(2);

/**
 * Display strings for the discount badge, e.g. original "20.00", discounted
 * "10.00", "for the first 3 months", "-50%".
 */
export function formatPromoTerms(quote) {
  const currency = quote.currency ?? 'USDC';
  const original = Number(quote.original_amount);
  const discounted = Number(quote.discounted_amount);
  const months = Number(quote.duration_months);
  const percentOff = Math.round(((original - discounted) / original) * 100);
  return {
    currency,
    original: formatAmount(original, currency),
    discounted: formatAmount(discounted, currency),
    period: months === 1 ? 'for the first month' : `for the first ${months} months`,
    badge: `-${percentOff}%`,
  };
}
