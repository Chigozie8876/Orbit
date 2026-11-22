import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeeStats,
  fetchFeeStats,
  calculateFeeBreakdown,
  DEFAULT_BASE_FEE_STROOPS,
  RECOMMENDED_FEE_BUMP_STROOPS,
  NETWORK_STATUS,
} from '../src/feeEstimation.js';

describe('feeEstimation module', () => {
  it('parses normal fee stats and indicates Network Optimal', () => {
    const raw = {
      last_ledger: '123456',
      last_ledger_base_fee: '100',
      ledger_capacity_usage: '0.35',
      min_accepted_fee: '100',
      mode_accepted_fee: '100',
      p95_accepted_fee: '100',
      fee_charged: { min: '100', mode: '100', p95: '100' },
    };

    const parsed = parseFeeStats(raw);

    assert.equal(parsed.status, NETWORK_STATUS.OPTIMAL.status);
    assert.equal(parsed.badge, '🟢 Network Optimal');
    assert.equal(parsed.isCongested, false);
    assert.equal(parsed.baseFeeStroops, 100);
    assert.equal(parsed.standardFeeStroops, 100);
    assert.equal(parsed.recommendedFeeStroops, 100);
    assert.equal(parsed.feeBumpStroops, 0);
  });

  it('triggers surge and High Traffic warning when ledger capacity exceeds threshold', () => {
    const raw = {
      last_ledger: '123457',
      last_ledger_base_fee: '100',
      ledger_capacity_usage: '0.85', // > 0.8 threshold
      min_accepted_fee: '100',
      mode_accepted_fee: '100',
      p95_accepted_fee: '100',
      fee_charged: { min: '100', mode: '100', p95: '100' },
    };

    const parsed = parseFeeStats(raw);

    assert.equal(parsed.status, NETWORK_STATUS.CONGESTED.status);
    assert.equal(parsed.badge, '🟡 High Traffic');
    assert.equal(parsed.isCongested, true);
    assert.equal(parsed.standardFeeStroops, 100);
    assert.equal(parsed.feeBumpStroops, RECOMMENDED_FEE_BUMP_STROOPS);
    assert.equal(parsed.recommendedFeeStroops, 100 + RECOMMENDED_FEE_BUMP_STROOPS);
    assert.equal(parsed.recommendedFeeXlm, '0.0000200');
  });

  it('triggers surge when p95 or mode fee indicates fee escalation', () => {
    const raw = {
      last_ledger: '123458',
      last_ledger_base_fee: '100',
      ledger_capacity_usage: '0.50',
      min_accepted_fee: '100',
      mode_accepted_fee: '150',
      p95_accepted_fee: '300',
      fee_charged: { min: '100', mode: '150', p95: '300' },
    };

    const parsed = parseFeeStats(raw);

    assert.equal(parsed.isCongested, true);
    assert.equal(parsed.badge, '🟡 High Traffic');
    assert.equal(parsed.recommendedFeeStroops, 200);
  });

  it('handles null, undefined, or malformed responses gracefully with safe fallbacks', () => {
    const parsedNull = parseFeeStats(null);
    assert.equal(parsedNull.status, NETWORK_STATUS.OPTIMAL.status);
    assert.equal(parsedNull.badge, '🟢 Network Optimal');
    assert.equal(parsedNull.standardFeeStroops, DEFAULT_BASE_FEE_STROOPS);
    assert.equal(parsedNull.recommendedFeeStroops, DEFAULT_BASE_FEE_STROOPS);

    const parsedEmpty = parseFeeStats({});
    assert.equal(parsedEmpty.isCongested, false);
    assert.equal(parsedEmpty.standardFeeStroops, 100);
  });

  it('fetches fee stats from Horizon endpoint and parses successfully', async () => {
    const mockHorizon = {
      last_ledger_base_fee: '100',
      ledger_capacity_usage: '0.92',
      p95_accepted_fee: '200',
    };

    const mockFetch = async (url) => {
      assert.ok(url.includes('/fee_stats'));
      return {
        ok: true,
        json: async () => mockHorizon,
      };
    };

    const result = await fetchFeeStats({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      fetchImpl: mockFetch,
    });

    assert.equal(result.isCongested, true);
    assert.equal(result.badge, '🟡 High Traffic');
    assert.equal(result.recommendedFeeStroops, 200);
  });

  it('falls back to optimal standard fee when Horizon endpoint fails or errors', async () => {
    const failingFetch = async () => {
      throw new Error('Network timeout');
    };

    const result = await fetchFeeStats({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      fetchImpl: failingFetch,
    });

    assert.equal(result.status, NETWORK_STATUS.OPTIMAL.status);
    assert.equal(result.standardFeeStroops, DEFAULT_BASE_FEE_STROOPS);
    assert.equal(result.isCongested, false);
  });

  it('calculates network fee breakdown for recommended and standard user bids', () => {
    const congestedStats = parseFeeStats({
      last_ledger_base_fee: '100',
      ledger_capacity_usage: '0.95',
      p95_accepted_fee: '250',
    });

    // 1. Recommended bid with surge fee bump
    const recommendedBreakdown = calculateFeeBreakdown({
      feeStats: congestedStats,
      feeBidType: 'recommended',
      operationsCount: 2,
    });

    assert.equal(recommendedBreakdown.feePerOpStroops, 200);
    assert.equal(recommendedBreakdown.totalFeeStroops, 400);
    assert.equal(recommendedBreakdown.totalFeeXlm, '0.0000400');
    assert.equal(recommendedBreakdown.baseFeeTotalXlm, '0.0000200');
    assert.equal(recommendedBreakdown.surgeBumpTotalXlm, '0.0000200');

    // 2. Standard bid (user opted out of recommended bump)
    const standardBreakdown = calculateFeeBreakdown({
      feeStats: congestedStats,
      feeBidType: 'standard',
      operationsCount: 2,
    });

    assert.equal(standardBreakdown.feePerOpStroops, 100);
    assert.equal(standardBreakdown.totalFeeStroops, 200);
    assert.equal(standardBreakdown.totalFeeXlm, '0.0000200');
    assert.equal(standardBreakdown.surgeBumpTotalXlm, '0.0000000');
  });
});
