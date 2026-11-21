import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import {
    DEFAULT_BASELINES,
    RATE_CACHE_TTL_MS,
    buildRatePayload,
    createExchangeRateWorker,
    createRateArchive,
    createRateCache,
} from '../exchange-rates.js';

const goodPrices = { USDC: 1, EURC: 1.08, XLM: 0.12 };
const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const makeCache = (initial = null, now = () => Date.now()) => {
    let snapshot = initial;
    return {
        writeCalls: 0,
        async read() { return snapshot; },
        async write(next) { snapshot = next; this.writeCalls += 1; },
        isFresh(value) {
            return Boolean(value?.fetchedAt) && now() - new Date(value.fetchedAt).getTime() <= RATE_CACHE_TTL_MS;
        },
        async close() {},
        get snapshot() { return snapshot; },
    };
};

const noopArchive = () => ({ intervalMs: 0, async archive() { return false; } });

const makeWorker = ({ fetchImpl, cache, archive, env = {}, ...rest } = {}) => createExchangeRateWorker({
    env: {
        EXCHANGE_RATE_PRIMARY_ORACLE: 'coingecko',
        EXCHANGE_RATE_SECONDARY_ORACLE: 'http',
        EXCHANGE_RATE_HTTP_URL: 'https://oracle.example/prices',
        ...env,
    },
    getFetch: () => fetchImpl,
    cache: cache || makeCache(),
    archive: archive || noopArchive(),
    ...rest,
});

afterEach(() => {
    delete app.locals.exchangeRateWorker;
});

describe('exchange rate polling', () => {
    it('uses the secondary oracle when the primary feed fails', async () => {
        const now = Date.now();
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new Error('primary offline'))
            .mockResolvedValueOnce(jsonResponse({ prices: goodPrices }));
        const cache = makeCache();
        const worker = makeWorker({ fetchImpl, cache });

        const result = await worker.sync();

        expect(result.ok).toBe(true);
        expect(result.snapshot.prices).toEqual(goodPrices);
        expect(result.snapshot.source).toBe('http-oracle');
        expect(cache.snapshot.source).toBe('http-oracle');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('rejects malformed feeds without overwriting a valid cached snapshot', async () => {
        const now = Date.now();
        const cached = {
            prices: goodPrices,
            source: 'coingecko',
            fetchedAt: new Date(now - 1000).toISOString(),
            static: false,
        };
        const cache = makeCache(cached, () => now);
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ 'usd-coin': { usd: 1 } })) // missing EUR/XLM
            .mockResolvedValueOnce(jsonResponse({ prices: { USDC: 1, EURC: -3, XLM: 0.1 } }));
        const worker = makeWorker({ fetchImpl, cache, now: () => now });

        const result = await worker.sync();

        expect(result.ok).toBe(false);
        expect(cache.snapshot).toBe(cached);
        expect(cache.writeCalls).toBe(0);
    });

    it('does not start a second synchronization while one is in flight', async () => {
        let resolvePrimary;
        const primary = new Promise((resolve) => { resolvePrimary = resolve; });
        const fetchImpl = vi.fn().mockReturnValueOnce(primary);
        const worker = makeWorker({ fetchImpl });

        const first = worker.sync();
        const second = worker.sync();
        expect(second).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        resolvePrimary(jsonResponse({ prices: goodPrices }));
        await expect(first).resolves.toMatchObject({ ok: true });
    });

    it('archives at most one row set per asset and hour', async () => {
        const now = Date.now();
        const supabase = {
            from: vi.fn(() => ({
                upsert: vi.fn(async () => ({ error: null })),
            })),
        };
        const archive = createRateArchive({ getSupabase: () => supabase });
        const fetchImpl = vi.fn(async () => jsonResponse({ prices: goodPrices }));
        const worker = makeWorker({ fetchImpl, archive, now: () => now });

        await worker.sync();
        await worker.sync();

        expect(supabase.from).toHaveBeenCalledTimes(1);
        expect(supabase.from).toHaveBeenCalledWith('exchange_rate_history');
    });
});

describe('cache freshness and fallback hierarchy', () => {
    it('marks an expired cache as stale and falls back to cached rates', async () => {
        const now = Date.now();
        const stale = {
            prices: goodPrices,
            source: 'coingecko',
            fetchedAt: new Date(now - RATE_CACHE_TTL_MS - 1).toISOString(),
            static: false,
        };
        const worker = makeWorker({
            cache: makeCache(stale, () => now),
            fetchImpl: vi.fn(), // no request is made from a read
            now: () => now,
        });

        const snapshot = await worker.readSnapshot();

        expect(snapshot.fresh).toBe(false);
        expect(snapshot.cache_status).toBe('stale');
        expect(snapshot.fallbackUsed).toBe(true);
        expect(snapshot.prices).toEqual(goodPrices);
    });

    it('uses explicitly configured static baselines when nothing is cached', async () => {
        const worker = makeWorker({ cache: makeCache(), fetchImpl: vi.fn() });
        const snapshot = await worker.readSnapshot();

        expect(snapshot.source).toBe('static-baseline');
        expect(snapshot.fresh).toBe(false);
        expect(snapshot.fallbackUsed).toBe(true);
        expect(snapshot.prices).toEqual(DEFAULT_BASELINES);
    });

    it('reports a fresh cache hit with its original source', async () => {
        const now = Date.now();
        const cached = {
            prices: goodPrices,
            source: 'stellar-dex',
            fetchedAt: new Date(now - 1000).toISOString(),
            static: false,
        };
        const worker = makeWorker({ cache: makeCache(cached, () => now), fetchImpl: vi.fn() });

        const snapshot = await worker.readSnapshot();

        expect(snapshot).toMatchObject({ fresh: true, cacheStatus: 'hit', fallbackUsed: false });
        expect(snapshot.source).toBe('stellar-dex');
    });
});

describe('GET /api/rates', () => {
    it('returns the typed asset map with cache headers and a conversion matrix', async () => {
        const now = Date.now();
        const worker = makeWorker({
            cache: makeCache({
                prices: goodPrices,
                source: 'coingecko',
                fetchedAt: new Date(now - 1000).toISOString(),
                static: false,
            }, () => now),
            fetchImpl: vi.fn(),
            now: () => now,
        });
        app.locals.exchangeRateWorker = worker;

        const res = await request(app).get('/api/rates');

        expect(res.status).toBe(200);
        expect(res.headers['x-rate-cache']).toBe('HIT');
        expect(res.headers['x-rate-cache-status']).toBe('hit');
        expect(res.headers['x-rate-freshness']).toBe('fresh');
        expect(res.body.assets).toHaveProperty('USDC');
        expect(res.body.assets).toHaveProperty('EURC');
        expect(res.body.assets).toHaveProperty('XLM');
        expect(res.body.prices).toEqual(goodPrices);
        expect(res.body.fiat_rates).toHaveProperty('USD');
        expect(res.body.conversion_matrix.USDC.EURC).toBeCloseTo(1 / 1.08, 6);
        expect(res.body.last_sync_at).toBeTruthy();
        expect(res.body.rate_source).toBe('coingecko');
        expect(res.body.cache_status).toBe('hit');
    });

    it('labels static fallback data as stale in both headers and payload', async () => {
        app.locals.exchangeRateWorker = makeWorker({ cache: makeCache(), fetchImpl: vi.fn() });

        const res = await request(app).get('/api/rates');

        expect(res.status).toBe(200);
        expect(res.body.fresh).toBe(false);
        expect(res.body.fallback_used).toBe(true);
        expect(res.body.rate_source).toBe('static-baseline');
        expect(res.headers['x-rate-freshness']).toBe('stale');
        expect(res.headers['x-rate-cache-status']).toBe('miss');
    });

    it('builds a deterministic payload from a snapshot', () => {
        const payload = buildRatePayload({
            prices: goodPrices,
            source: 'coingecko',
            fetchedAt: '2026-11-21T00:00:00.000Z',
            fresh: true,
            cacheStatus: 'hit',
        });
        expect(payload.supported_assets).toEqual(['USDC', 'EURC', 'XLM']);
        expect(payload.conversion_matrix.XLM.USDC).toBeCloseTo(0.12, 6);
        expect(payload.fresh).toBe(true);
    });
});

describe('createRateCache', () => {
    it('expires entries through the supplied clock and falls back to memory', async () => {
        let now = 1000;
        const cache = createRateCache({
            env: {},
            now: () => now,
            redis: {
                get: async () => JSON.stringify({ prices: goodPrices, fetchedAt: new Date(900).toISOString() }),
                set: async () => {},
            },
        });

        expect(cache.isFresh(await cache.read())).toBe(true);
        now += RATE_CACHE_TTL_MS + 1;
        expect(cache.isFresh(await cache.read())).toBe(false);
        await cache.close();
    });
});
