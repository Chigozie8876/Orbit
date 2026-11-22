import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const { SimulationCache, applyFeeFloor, getOrSimulate } = createRequire(import.meta.url)('../simulation-cache.js');

describe('SimulationCache (#290)', () => {
  it('returns a cached value on a hit and counts it', () => {
    const cache = new SimulationCache({ ttlLedgers: 10 });
    cache.observeLedger(100);
    cache.set('pull_funds', { footprint: 'a' });

    expect(cache.get('pull_funds')).toEqual({ footprint: 'a' });
    expect(cache.stats.hits).toBe(1);
  });

  it('misses for an unknown key', () => {
    const cache = new SimulationCache();
    cache.observeLedger(1);

    expect(cache.get('nope')).toBeUndefined();
    expect(cache.stats.misses).toBe(1);
  });

  it('expires entries once the TTL in ledgers has elapsed', () => {
    const cache = new SimulationCache({ ttlLedgers: 10 });
    cache.observeLedger(100);
    cache.set('create_vault', 'fp');

    cache.observeLedger(109);
    expect(cache.get('create_vault')).toBe('fp');

    cache.observeLedger(110);
    expect(cache.get('create_vault')).toBeUndefined();
    expect(cache.entries.size).toBe(0);
  });

  it('purges expired entries as soon as the ledger advances', () => {
    const cache = new SimulationCache({ ttlLedgers: 5 });
    cache.observeLedger(10);
    cache.set('a', 1);
    cache.observeLedger(12);
    cache.set('b', 2);

    cache.observeLedger(15);
    expect([...cache.entries.keys()]).toEqual(['b']);
  });

  it('ignores ledger observations that go backwards', () => {
    const cache = new SimulationCache({ ttlLedgers: 10 });
    cache.observeLedger(100);
    cache.observeLedger(90);

    expect(cache.currentLedger).toBe(100);
  });

  it('evicts the oldest entry when full', () => {
    const cache = new SimulationCache({ maxEntries: 2 });
    cache.observeLedger(1);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('rejects an invalid TTL', () => {
    expect(() => new SimulationCache({ ttlLedgers: 0 })).toThrow(RangeError);
  });

  it('refuses to cache before any ledger has been observed', () => {
    expect(() => new SimulationCache().set('x', 1)).toThrow();
  });
});

describe('getOrSimulate (#290)', () => {
  it('runs the live simulation on a miss and caches the result', async () => {
    const cache = new SimulationCache();
    const simulate = vi.fn().mockResolvedValue({ fee: 100 });

    const first = await getOrSimulate(cache, 'k', { ledger: 5, simulate });
    const second = await getOrSimulate(cache, 'k', { ledger: 5, simulate });

    expect(first).toEqual({ value: { fee: 100 }, source: 'live' });
    expect(second).toEqual({ value: { fee: 100 }, source: 'cache' });
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('re-simulates after the ledger advances past the TTL', async () => {
    const cache = new SimulationCache({ ttlLedgers: 10 });
    const simulate = vi.fn().mockResolvedValue('fp');

    await getOrSimulate(cache, 'k', { ledger: 1, simulate });
    const later = await getOrSimulate(cache, 'k', { ledger: 20, simulate });

    expect(later.source).toBe('live');
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it('invalidates and re-simulates when the cached footprint fails pre-flight', async () => {
    const cache = new SimulationCache();
    const simulate = vi
      .fn()
      .mockResolvedValueOnce('stale')
      .mockResolvedValueOnce('fresh');
    const isValid = (value) => value !== 'stale';

    await getOrSimulate(cache, 'k', { ledger: 1, simulate, isValid });
    const result = await getOrSimulate(cache, 'k', { ledger: 1, simulate, isValid });

    expect(result).toEqual({ value: 'fresh', source: 'live' });
    expect(cache.stats.invalidations).toBeGreaterThanOrEqual(1);
  });

  it('treats a validator that throws as a failed check', async () => {
    const cache = new SimulationCache();
    const simulate = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    const isValid = () => {
      throw new Error('bad shape');
    };

    await getOrSimulate(cache, 'k', { ledger: 1, simulate, isValid });
    const result = await getOrSimulate(cache, 'k', { ledger: 1, simulate, isValid });

    expect(result.source).toBe('live');
  });

  it('falls through to live when the cache lookup itself throws', async () => {
    const cache = new SimulationCache();
    cache.get = () => {
      throw new Error('cache backend down');
    };
    const simulate = vi.fn().mockResolvedValue('live');

    await expect(
      getOrSimulate(cache, 'k', { ledger: 1, simulate }),
    ).resolves.toEqual({ value: 'live', source: 'live' });
  });

  it('still surfaces errors from the live simulation', async () => {
    const cache = new SimulationCache();
    const simulate = vi.fn().mockRejectedValue(new Error('rpc timeout'));

    await expect(getOrSimulate(cache, 'k', { ledger: 1, simulate })).rejects.toThrow('rpc timeout');
  });
});

describe('applyFeeFloor (#290)', () => {
  it('raises the estimate to the current minimum inclusion fee', () => {
    expect(applyFeeFloor({ fee: 50 }, { minInclusionFee: 100 })).toEqual({ fee: 100 });
  });

  it('keeps a higher estimate unchanged', () => {
    expect(applyFeeFloor({ fee: 500 }, { minInclusionFee: 100, baseReserve: 200 })).toEqual({ fee: 500 });
  });

  it('uses the base reserve when it is the larger floor', () => {
    expect(applyFeeFloor({ fee: 10 }, { minInclusionFee: 100, baseReserve: 300 })).toEqual({ fee: 300 });
  });
});
