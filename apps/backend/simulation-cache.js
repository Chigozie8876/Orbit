'use strict';

/**
 * Transaction simulation footprint cache (#290).
 *
 * Simulating a transaction against Soroban RPC costs 400-800ms per call, even
 * though footprints for common calls (`pull_funds`, `create_vault`) barely
 * change between ledgers. This cache keeps those results for a short window
 * measured in ledgers, and drops them as soon as the ledger advances past
 * that window.
 */

const DEFAULT_TTL_LEDGERS = 10; // ~50s at ~5s per ledger
const DEFAULT_MAX_ENTRIES = 500;

class SimulationCache {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlLedgers=10] Entry lifetime in ledgers.
   * @param {number} [options.maxEntries=500] Upper bound on cached entries.
   */
  constructor({ ttlLedgers = DEFAULT_TTL_LEDGERS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (!Number.isInteger(ttlLedgers) || ttlLedgers < 1) {
      throw new RangeError('ttlLedgers must be a positive integer');
    }
    this.ttlLedgers = ttlLedgers;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> { value, ledger }
    this.currentLedger = null;
    this.stats = { hits: 0, misses: 0, invalidations: 0 };
  }

  /**
   * Record the latest ledger sequence. When it advances, every entry older
   * than the TTL window is removed.
   */
  observeLedger(sequence) {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new RangeError('ledger sequence must be a non-negative integer');
    }
    if (this.currentLedger !== null && sequence < this.currentLedger) {
      return; // ignore out-of-order observations
    }
    this.currentLedger = sequence;
    for (const [key, entry] of this.entries) {
      if (this._isExpired(entry, sequence)) {
        this.entries.delete(key);
        this.stats.invalidations += 1;
      }
    }
  }

  _isExpired(entry, ledger) {
    return ledger - entry.ledger >= this.ttlLedgers;
  }

  /** Returns the cached value for `key`, or `undefined` on a miss. */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return undefined;
    }
    if (this.currentLedger !== null && this._isExpired(entry, this.currentLedger)) {
      this.entries.delete(key);
      this.stats.invalidations += 1;
      this.stats.misses += 1;
      return undefined;
    }
    this.stats.hits += 1;
    return entry.value;
  }

  set(key, value, ledger = this.currentLedger) {
    if (ledger === null) {
      throw new Error('observeLedger() must be called before set()');
    }
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Evict the oldest insertion; Map preserves insertion order.
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
      this.stats.invalidations += 1;
    }
    this.entries.set(key, { value, ledger });
  }

  invalidate(key) {
    if (this.entries.delete(key)) {
      this.stats.invalidations += 1;
    }
  }

  clear() {
    this.stats.invalidations += this.entries.size;
    this.entries.clear();
  }
}

/**
 * Raise a cached fee estimate so it is never below the network's current
 * minimum inclusion fee (#290, dynamic fee adjuster). Values are stroops.
 */
function applyFeeFloor(estimate, { minInclusionFee = 0, baseReserve = 0 } = {}) {
  const floor = Math.max(Number(minInclusionFee) || 0, Number(baseReserve) || 0);
  const fee = Number(estimate.fee) || 0;
  return { ...estimate, fee: Math.max(fee, floor) };
}

/**
 * Serve a simulation from cache when possible, otherwise run the live
 * simulation and cache its result.
 *
 * If the cached footprint fails the pre-flight `isValid` check, the entry is
 * invalidated and the live simulation runs instead. A broken cache lookup
 * also falls through to the live path, so API clients never see a cache error.
 * Errors from the live simulation itself are still thrown.
 *
 * @returns {Promise<{ value: any, source: 'cache' | 'live' }>}
 */
async function getOrSimulate(cache, key, { ledger, simulate, isValid = () => true }) {
  cache.observeLedger(ledger);

  let cached;
  try {
    cached = cache.get(key);
  } catch (_err) {
    cached = undefined;
  }

  if (cached !== undefined) {
    let valid = false;
    try {
      valid = isValid(cached) === true;
    } catch (_err) {
      valid = false;
    }
    if (valid) {
      return { value: cached, source: 'cache' };
    }
    cache.invalidate(key);
  }

  const value = await simulate();
  try {
    cache.set(key, value, ledger);
  } catch (_err) {
    // Caching is best-effort; the live result is still correct.
  }
  return { value, source: 'live' };
}

module.exports = {
  SimulationCache,
  applyFeeFloor,
  getOrSimulate,
  DEFAULT_TTL_LEDGERS,
};
