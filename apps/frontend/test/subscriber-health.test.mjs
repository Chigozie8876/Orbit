import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRITICAL_RETRY_COUNT,
  DUE_SOON_HOURS,
  assessSubscriberHealth,
  canSendBalanceReminder,
  summarizeChurnRisk,
} from '../src/lib/subscriber-health.ts';

const NOW = new Date('2026-11-20T12:00:00Z');
const inDays = (days) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
const sub = (overrides = {}) => ({ status: 'active', amount: 20, nextBillingAt: inDays(20), ...overrides });
const codes = (health) => health.factors.map((f) => f.code);

test('a funded subscription with no failures is good', () => {
  const health = assessSubscriberHealth(sub({ liquidity: { balance: 500, allowance: 240 } }), NOW);
  assert.equal(health.level, 'good');
  assert.deepEqual(health.factors, []);
});

test('subscriptions that no longer renew are not scored', () => {
  for (const status of ['cancelled', 'churned']) {
    assert.deepEqual(assessSubscriberHealth(sub({ status, retryCount: 5 }), NOW), { level: null, factors: [] });
  }
});

test('an on-chain balance below one cycle is critical and reports the shortfall', () => {
  const health = assessSubscriberHealth(sub({ liquidity: { balance: 12.5, allowance: 240 } }), NOW);
  assert.equal(health.level, 'critical');
  assert.deepEqual(health.factors[0], {
    code: 'insufficient_balance',
    severity: 'critical',
    params: { balance: 12.5, amount: 20 },
  });
});

test('a balance covering less than two cycles is a warning', () => {
  const health = assessSubscriberHealth(sub({ liquidity: { balance: 30, allowance: 240 } }), NOW);
  assert.equal(health.level, 'warning');
  assert.deepEqual(codes(health), ['low_balance']);
});

test('an allowance below one cycle is critical; below two cycles a warning', () => {
  assert.deepEqual(codes(assessSubscriberHealth(sub({ liquidity: { balance: 500, allowance: 10 } }), NOW)), ['allowance_exhausted']);
  const low = assessSubscriberHealth(sub({ liquidity: { balance: 500, allowance: 35 } }), NOW);
  assert.equal(low.level, 'warning');
  assert.deepEqual(low.factors, [{ code: 'allowance_low', severity: 'warning', params: { cycles: 1 } }]);
});

test('the classified reason of the last failed pull is critical', () => {
  const cases = {
    insufficient_balance: 'insufficient_balance',
    insufficient_allowance: 'allowance_exhausted',
    expired_allowance: 'allowance_expired',
  };
  for (const [failure, factor] of Object.entries(cases)) {
    const health = assessSubscriberHealth(sub({ lastFailure: { code: failure } }), NOW);
    assert.equal(health.level, 'critical', failure);
    assert.ok(codes(health).includes(factor), failure);
  }
  // Unknown failure codes do not invent a factor.
  assert.equal(assessSubscriberHealth(sub({ lastFailure: { code: 'rpc_timeout' } }), NOW).level, 'good');
});

test('one failed retry is a warning, repeated failures are critical', () => {
  assert.equal(assessSubscriberHealth(sub({ retryCount: 1 }), NOW).level, 'warning');
  const repeated = assessSubscriberHealth(sub({ retryCount: CRITICAL_RETRY_COUNT }), NOW);
  assert.equal(repeated.level, 'critical');
  assert.deepEqual(repeated.factors[0].params, { count: CRITICAL_RETRY_COUNT });
});

test('a past-due subscription is critical', () => {
  assert.deepEqual(codes(assessSubscriberHealth(sub({ status: 'past_due' }), NOW)), ['past_due']);
});

test('a warning becomes critical when the renewal is due soon', () => {
  const soon = assessSubscriberHealth(sub({ nextBillingAt: inDays(1), liquidity: { balance: 30, allowance: 240 } }), NOW);
  assert.equal(soon.level, 'critical');
  assert.deepEqual(codes(soon), ['due_soon', 'low_balance']);
  assert.equal(soon.factors[0].params.hours, 24);

  // Exactly at the window edge still counts; just past it does not.
  const edge = new Date(NOW.getTime() + DUE_SOON_HOURS * 3_600_000).toISOString();
  assert.equal(assessSubscriberHealth(sub({ nextBillingAt: edge, retryCount: 1 }), NOW).level, 'critical');
  const later = new Date(NOW.getTime() + (DUE_SOON_HOURS + 1) * 3_600_000).toISOString();
  assert.equal(assessSubscriberHealth(sub({ nextBillingAt: later, retryCount: 1 }), NOW).level, 'warning');
});

test('a due pull escalates warnings even without a parseable date', () => {
  const health = assessSubscriberHealth(sub({ status: 'pending_pull', nextBillingAt: 'Due Now', retryCount: 1 }), NOW);
  assert.equal(health.level, 'critical');
  assert.ok(codes(health).includes('due_soon'));
});

test('a due renewal alone is not a risk', () => {
  assert.equal(assessSubscriberHealth(sub({ status: 'pending_pull', nextBillingAt: inDays(0) }), NOW).level, 'good');
});

test('the same factor is reported once, at its worst severity, critical first', () => {
  const health = assessSubscriberHealth(
    sub({ lastFailure: { code: 'insufficient_balance' }, liquidity: { balance: 5, allowance: 35 } }),
    NOW,
  );
  assert.deepEqual(codes(health), ['insufficient_balance', 'allowance_low']);
});

test('zero-amount plans ignore the liquidity snapshot', () => {
  assert.equal(assessSubscriberHealth(sub({ amount: 0, liquidity: { balance: 0, allowance: 0 } }), NOW).level, 'good');
});

test('summarizeChurnRisk counts at-risk subscriptions and the revenue they carry', () => {
  const summary = summarizeChurnRisk([
    sub({ amount: 29, liquidity: { balance: 1, allowance: 500 } }), // critical
    sub({ amount: 15, retryCount: 1 }), // warning
    sub({ amount: 49.99, status: 'past_due' }), // critical
    sub({ amount: 100 }), // good
    sub({ amount: 75, status: 'cancelled', retryCount: 3 }), // not scored
  ], NOW);
  assert.deepEqual(summary, {
    atRisk: 3,
    critical: 2,
    warning: 1,
    revenueAtRisk: 93.99,
    criticalRevenueAtRisk: 78.99,
    scored: 4,
  });
});

test('summarizeChurnRisk on an empty or healthy list reports no risk', () => {
  assert.deepEqual(summarizeChurnRisk([], NOW), { atRisk: 0, critical: 0, warning: 0, revenueAtRisk: 0, criticalRevenueAtRisk: 0, scored: 0 });
  assert.equal(summarizeChurnRisk([sub()], NOW).atRisk, 0);
});

test('balance reminders are offered only for risks the subscriber can fix', () => {
  assert.equal(canSendBalanceReminder(assessSubscriberHealth(sub({ liquidity: { balance: 1, allowance: 500 } }), NOW)), true);
  assert.equal(canSendBalanceReminder(assessSubscriberHealth(sub({ lastFailure: { code: 'expired_allowance' } }), NOW)), true);
  assert.equal(canSendBalanceReminder(assessSubscriberHealth(sub({ retryCount: 3 }), NOW)), false);
  assert.equal(canSendBalanceReminder(assessSubscriberHealth(sub(), NOW)), false);
});
