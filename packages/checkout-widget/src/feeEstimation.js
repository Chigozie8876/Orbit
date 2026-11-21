/**
 * Dynamic fee estimation and network congestion monitoring from Stellar Horizon fee_stats.
 */

export const DEFAULT_BASE_FEE_STROOPS = 100;
export const CONGESTION_CAPACITY_THRESHOLD = 0.8; // 80% ledger capacity
export const RECOMMENDED_FEE_BUMP_STROOPS = 100; // +100 stroops bump during surge

export const NETWORK_STATUS = {
  OPTIMAL: {
    status: 'optimal',
    badge: '🟢 Network Optimal',
    label: 'Network Optimal',
  },
  CONGESTED: {
    status: 'congested',
    badge: '🟡 High Traffic',
    label: 'High Traffic',
  },
};

/**
 * Parses raw Horizon /fee_stats payload and determines congestion status & fee recommendations.
 *
 * @param {object} stats - Horizon /fee_stats response
 * @returns {object} Parsed fee stats with congestion indicators and recommendations
 */
export function parseFeeStats(stats) {
  if (!stats || typeof stats !== 'object') {
    return {
      status: NETWORK_STATUS.OPTIMAL.status,
      badge: NETWORK_STATUS.OPTIMAL.badge,
      label: NETWORK_STATUS.OPTIMAL.label,
      isCongested: false,
      capacityUsage: 0,
      baseFeeStroops: DEFAULT_BASE_FEE_STROOPS,
      standardFeeStroops: DEFAULT_BASE_FEE_STROOPS,
      recommendedFeeStroops: DEFAULT_BASE_FEE_STROOPS,
      feeBumpStroops: 0,
      standardFeeXlm: (DEFAULT_BASE_FEE_STROOPS / 10_000_000).toFixed(7),
      recommendedFeeXlm: (DEFAULT_BASE_FEE_STROOPS / 10_000_000).toFixed(7),
    };
  }

  const baseFee = Number(stats.last_ledger_base_fee) || DEFAULT_BASE_FEE_STROOPS;
  const capacityUsage = parseFloat(stats.ledger_capacity_usage) || 0;

  const feeCharged = stats.fee_charged || {};
  const maxFee = stats.max_fee || {};

  const minAccepted = Number(stats.min_accepted_fee ?? feeCharged.min ?? baseFee);
  const modeAccepted = Number(stats.mode_accepted_fee ?? feeCharged.mode ?? baseFee);
  const p95Accepted = Number(stats.p95_accepted_fee ?? feeCharged.p95 ?? maxFee.p95 ?? baseFee);

  // High congestion triggers:
  // 1. Ledger capacity usage exceeds threshold (e.g. >= 80%)
  // 2. 95th percentile or mode fee charged is higher than the standard base fee
  // 3. Minimum accepted fee exceeds base fee
  const isCongested =
    capacityUsage >= CONGESTION_CAPACITY_THRESHOLD ||
    p95Accepted > baseFee ||
    modeAccepted > baseFee ||
    minAccepted > baseFee;

  const networkStatus = isCongested ? NETWORK_STATUS.CONGESTED : NETWORK_STATUS.OPTIMAL;

  const standardFeeStroops = Math.max(DEFAULT_BASE_FEE_STROOPS, baseFee);
  const feeBumpStroops = isCongested ? RECOMMENDED_FEE_BUMP_STROOPS : 0;
  const recommendedFeeStroops = standardFeeStroops + feeBumpStroops;

  return {
    status: networkStatus.status,
    badge: networkStatus.badge,
    label: networkStatus.label,
    isCongested,
    capacityUsage,
    baseFeeStroops: baseFee,
    minAcceptedFeeStroops: minAccepted,
    modeAcceptedFeeStroops: modeAccepted,
    p95AcceptedFeeStroops: p95Accepted,
    standardFeeStroops,
    recommendedFeeStroops,
    feeBumpStroops,
    standardFeeXlm: (standardFeeStroops / 10_000_000).toFixed(7),
    recommendedFeeXlm: (recommendedFeeStroops / 10_000_000).toFixed(7),
  };
}

/**
 * Fetches fee_stats from Stellar Horizon endpoint.
 *
 * @param {object} params
 * @param {string} params.horizonUrl - Horizon base URL (e.g. https://horizon-testnet.stellar.org)
 * @param {Function} [params.fetchImpl] - Optional custom fetch implementation
 * @returns {Promise<object>} Parsed fee stats
 */
export async function fetchFeeStats({ horizonUrl, fetchImpl = globalThis.fetch }) {
  if (!horizonUrl) {
    return parseFeeStats(null);
  }

  const endpoint = `${horizonUrl.replace(/\/$/, '')}/fee_stats`;
  try {
    const res = await fetchImpl(endpoint);
    if (!res.ok) {
      console.warn(`Horizon fee_stats returned HTTP ${res.status}, falling back to defaults`);
      return parseFeeStats(null);
    }
    const data = await res.json();
    return parseFeeStats(data);
  } catch (err) {
    console.warn('Failed to fetch Horizon fee_stats, falling back to defaults:', err);
    return parseFeeStats(null);
  }
}

/**
 * Computes the total fee breakdown for authorization transactions based on the selected fee bid type.
 *
 * @param {object} params
 * @param {object} params.feeStats - Parsed fee stats from parseFeeStats
 * @param {'recommended' | 'standard'} [params.feeBidType='recommended'] - User-selected fee bid
 * @param {number} [params.operationsCount=2] - Number of operations/transactions (typically 2: approval + vault)
 * @returns {object} Fee breakdown
 */
export function calculateFeeBreakdown({
  feeStats,
  feeBidType = 'recommended',
  operationsCount = 2,
}) {
  const stats = feeStats || parseFeeStats(null);
  const selectedPerOpStroops =
    feeBidType === 'standard' ? stats.standardFeeStroops : stats.recommendedFeeStroops;

  const totalFeeStroops = selectedPerOpStroops * operationsCount;
  const totalFeeXlm = (totalFeeStroops / 10_000_000).toFixed(7);
  const baseFeeTotalXlm = ((stats.standardFeeStroops * operationsCount) / 10_000_000).toFixed(7);
  const surgeBumpTotalXlm =
    feeBidType === 'recommended' && stats.isCongested
      ? ((stats.feeBumpStroops * operationsCount) / 10_000_000).toFixed(7)
      : '0.0000000';

  return {
    feeBidType,
    feePerOpStroops: selectedPerOpStroops,
    feePerOpXlm: (selectedPerOpStroops / 10_000_000).toFixed(7),
    totalFeeStroops,
    totalFeeXlm,
    baseFeeTotalXlm,
    surgeBumpTotalXlm,
    operationsCount,
    isCongested: stats.isCongested,
    badge: stats.badge,
  };
}
