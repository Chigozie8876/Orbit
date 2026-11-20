import { describe, expect, it, vi } from 'vitest';
import { SorobanRpcPool } from '../rpc-pool.js';

describe('SorobanRpcPool', () => {
  it('fails over after retryable server errors and quarantines the failed node', async () => {
    const a = { getTransaction: vi.fn().mockRejectedValue(Object.assign(new Error('server error'), { status: 500 })) };
    const b = { getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS' }) };
    const servers = { 'https://a': a, 'https://b': b };
    const pool = new SorobanRpcPool({
      urls: Object.keys(servers), serverFactory: (url) => servers[url],
      sleep: async () => {}, random: () => 0, now: (() => { let n = 0; return () => ++n; })(),
    });
    pool.nodes[0].latencyMs = 1; pool.nodes[1].latencyMs = 2;
    await expect(pool.request('getTransaction', 'hash')).resolves.toEqual({ status: 'SUCCESS' });
    expect(pool.nodes[0].healthy).toBe(false);
    expect(pool.nodes[0].quarantinedUntil).toBeGreaterThan(0);
  });

  it('re-tests quarantined nodes through getLatestLedger', async () => {
    const server = { getLatestLedger: vi.fn().mockResolvedValue({ sequence: 42 }) };
    let now = 100;
    const pool = new SorobanRpcPool({ urls: ['https://a'], serverFactory: () => server, quarantineMs: 10, now: () => now });
    pool.markFailure(pool.nodes[0]);
    now = 111;
    await expect(pool.probe(pool.nodes[0])).resolves.toBe(true);
    expect(pool.nodes[0].healthy).toBe(true);
  });
});