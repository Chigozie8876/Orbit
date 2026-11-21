import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStreamBalance, formatStreamBalance, totalStreamAmount } from '../src/lib/stream-balance.ts';

const schedule = (overrides = {}) => ({
  ratePerSecond: 2,
  startTime: 1_000_000,
  endTime: 1_000_000 + 100_000,
  withdrawnAmount: 0,
  ...overrides,
});

test('balance accrues at the stream rate', () => {
  assert.equal(computeStreamBalance(schedule(), 1_000_000 + 10_000), 20);
});

test('balance is zero before the stream starts', () => {
  assert.equal(computeStreamBalance(schedule(), 500_000), 0);
});

test('accrual stops at the end of the stream', () => {
  const s = schedule();
  assert.equal(computeStreamBalance(s, s.endTime + 60_000), totalStreamAmount(s));
  assert.equal(totalStreamAmount(s), 200);
});

test('withdrawn amount is subtracted from the claimable balance', () => {
  assert.equal(computeStreamBalance(schedule({ withdrawnAmount: 15 }), 1_000_000 + 10_000), 5);
});

test('balance never goes negative when withdrawals exceed accrual', () => {
  assert.equal(computeStreamBalance(schedule({ withdrawnAmount: 50 }), 1_000_000 + 1_000), 0);
});

test('an inverted or empty window accrues nothing', () => {
  const s = schedule({ startTime: 2_000_000, endTime: 1_000_000 });
  assert.equal(computeStreamBalance(s, 3_000_000), 0);
  assert.equal(totalStreamAmount(s), 0);
});

test('balance grows by rate times the 100ms tick', () => {
  const s = schedule({ ratePerSecond: 1 });
  const a = computeStreamBalance(s, 1_000_000 + 1_000);
  const b = computeStreamBalance(s, 1_000_000 + 1_100);
  assert.ok(Math.abs(b - a - 0.1) < 1e-9);
});

test('formats to six decimal places', () => {
  assert.equal(formatStreamBalance(1.5), '1.500000');
  assert.equal(formatStreamBalance(0.0000001), '0.000000');
});
