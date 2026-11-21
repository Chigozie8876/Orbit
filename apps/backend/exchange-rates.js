// ---------------------------------------------------------------------------
// Stellar asset exchange-rate synchronization (#303)
//
// - polls a configurable primary/secondary price oracle on a background timer
// - keeps a short-lived (60s) snapshot in Redis with an in-memory fallback and
//   retains older snapshots so a failed poll can degrade to labelled stale data
// - archives one row per asset per hour in Postgres, deduplicated by hour
// - serves GET /api/rates without ever performing network I/O in the request
// ---------------------------------------------------------------------------

const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';
const DEFAULT_COINGECKO_URL =
    'https://api.coingecko.com/api/v3/simple/price?ids=stellar,usd-coin,eurc&vs_currencies=usd';
const DEFAULT_COINGECKO_IDS = { XLM: 'stellar', USDC: 'usd-coin', EURC: 'eurc' };
const DEFAULT_BASELINES = { USDC: 1, EURC: 1, XLM: 0.1 };

const RATE_CACHE_TTL_MS = Number(process.env.EXCHANGE_RATE_CACHE_TTL_MS) || 60_000;
// Older snapshots stay readable for explicit stale fallback; freshness is
// governed by RATE_CACHE_TTL_MS, not by this retention window.
const RATE_CACHE_RETENTION_MS =
    Number(process.env.EXCHANGE_RATE_CACHE_RETENTION_MS) || 6 * 60 * 60 * 1000;
const RATE_FETCH_TIMEOUT_MS = Number(process.env.EXCHANGE_RATE_FETCH_TIMEOUT_MS) || 5_000;
const DEFAULT_SYNC_INTERVAL_MS = Number(process.env.EXCHANGE_RATE_SYNC_INTERVAL_MS) || 60_000;
const DEFAULT_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_PREFIX = process.env.EXCHANGE_RATE_REDIS_PREFIX || 'orbit:rates:';
const CACHE_KEY = `${CACHE_PREFIX}snapshot:v1`;

// Issuers are environment-driven: the same code runs against pubnet and
// testnet, where USDC/EURC have different issuers.
const SUPPORTED_ASSETS = [
    {
        code: 'USDC',
        type: 'credit_alphanum4',
        issuer: process.env.EXCHANGE_RATE_USDC_ISSUER || null,
    },
    {
        code: 'EURC',
        type: 'credit_alphanum4',
        issuer: process.env.EXCHANGE_RATE_EURC_ISSUER || null,
    },
    { code: 'XLM', type: 'native', issuer: null },
];
const SUPPORTED_ASSET_CODES = SUPPORTED_ASSETS.map((asset) => asset.code);

const isPositivePrice = (value) => {
    const price = Number(value);
    return Number.isFinite(price) && price > 0;
};

const parseBaselines = (env = process.env) => {
    let configured = {};
    if (env.EXCHANGE_RATE_STATIC_BASELINES) {
        try {
            configured = JSON.parse(env.EXCHANGE_RATE_STATIC_BASELINES);
        } catch {
            configured = {};
        }
    }
    const prices = {};
    for (const code of SUPPORTED_ASSET_CODES) {
        const price = configured[code];
        prices[code] = isPositivePrice(price) ? Number(price) : DEFAULT_BASELINES[code];
    }
    return prices;
};

// All providers return { prices: { USDC, EURC, XLM }, source, fetchedAt }.
// A provider must return every supported asset; a partial feed is rejected so
// it can never overwrite a complete previous snapshot.
const normalizePrices = (prices) => {
    if (!prices || typeof prices !== 'object') return null;
    const normalized = {};
    for (const code of SUPPORTED_ASSET_CODES) {
        const value = prices[code] ?? prices[code.toLowerCase()];
        if (!isPositivePrice(value)) return null;
        normalized[code] = Number(value);
    }
    return normalized;
};

const fetchJson = async (url, fetchImpl, timeoutMs = RATE_FETCH_TIMEOUT_MS) => {
    if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller.signal,
        });
        if (!response || !response.ok) {
            throw new Error(`Oracle request failed with status ${response?.status ?? 'unknown'}`);
        }
        return await response.json();
    } catch (err) {
        throw new Error(`Oracle request failed: ${err?.message || err}`);
    } finally {
        clearTimeout(timeout);
    }
};

const coingeckoProvider = ({ env, getFetch }) => async () => {
    const ids = { ...DEFAULT_COINGECKO_IDS };
    if (env.EXCHANGE_RATE_COINGECKO_IDS) {
        try {
            Object.assign(ids, JSON.parse(env.EXCHANGE_RATE_COINGECKO_IDS));
        } catch {
            // Keep the defaults when the override is malformed.
        }
    }
    const url = env.EXCHANGE_RATE_COINGECKO_URL || DEFAULT_COINGECKO_URL;
    const body = await fetchJson(url, getFetch());
    const prices = {};
    for (const code of SUPPORTED_ASSET_CODES) {
        const entry = body?.[ids[code]];
        prices[code] = entry?.usd ?? entry?.usd_price;
    }
    const normalized = normalizePrices(prices);
    if (!normalized) throw new Error('CoinGecko response is missing a valid USD quote');
    return { prices: normalized, source: 'coingecko', fetchedAt: new Date().toISOString() };
};

// Horizon's orderbook `price` is counter units per unit of base. With XLM as
// base, it is directly the XLM price in the counter stablecoin. Crossing the
// USDC and EURC books removes the need for a second fiat price feed.
const horizonOrderbookPrice = async (horizonUrl, counter, getFetch, env) => {
    if (!counter.issuer) return null;
    const url = new URL(`${horizonUrl.replace(/\/$/, '')}/orderbook`);
    url.searchParams.set('base_asset_type', 'native');
    url.searchParams.set('counter_asset_type', counter.type);
    url.searchParams.set('counter_asset_code', counter.code);
    url.searchParams.set('counter_asset_issuer', counter.issuer);
    url.searchParams.set('limit', '1');
    const body = await fetchJson(url.toString(), getFetch());
    const ask = Number(body?.asks?.[0]?.price);
    const bid = Number(body?.bids?.[0]?.price);
    const price = isPositivePrice(ask) ? ask : bid;
    return isPositivePrice(price) ? price : null;
};

const stellarDexProvider = ({ env, getFetch }) => async () => {
    const horizonUrl = env.HORIZON_URL || DEFAULT_HORIZON_URL;
    const stableBaseline = isPositivePrice(env.EXCHANGE_RATE_STABLE_USD_BASELINE)
        ? Number(env.EXCHANGE_RATE_STABLE_USD_BASELINE)
        : 1;
    const usdc = SUPPORTED_ASSETS.find((asset) => asset.code === 'USDC');
    const eurc = SUPPORTED_ASSETS.find((asset) => asset.code === 'EURC');
    const xlmUsdc = await horizonOrderbookPrice(horizonUrl, usdc, getFetch, env);
    if (!isPositivePrice(xlmUsdc)) {
        throw new Error('Stellar DEX has no usable XLM/USDC orderbook');
    }
    const xlmEurc = await horizonOrderbookPrice(horizonUrl, eurc, getFetch, env);
    const prices = { USDC: stableBaseline, XLM: xlmUsdc * stableBaseline };
    if (isPositivePrice(xlmEurc)) {
        prices.EURC = (xlmUsdc / xlmEurc) * stableBaseline;
    }
    const normalized = normalizePrices(prices);
    if (!normalized) throw new Error('Stellar DEX response is missing a valid orderbook price');
    return { prices: normalized, source: 'stellar-dex', fetchedAt: new Date().toISOString() };
};

const httpProvider = ({ env, getFetch }) => async () => {
    const url = env.EXCHANGE_RATE_HTTP_URL;
    if (!url) throw new Error('EXCHANGE_RATE_HTTP_URL is not configured');
    const body = await fetchJson(url, getFetch());
    const raw = body?.prices || body?.rates || body;
    const prices = {};
    for (const code of SUPPORTED_ASSET_CODES) {
        const entry = raw?.[code];
        prices[code] = typeof entry === 'object' ? entry?.usd : entry;
    }
    const normalized = normalizePrices(prices);
    if (!normalized) throw new Error('HTTP oracle response is missing valid asset prices');
    return {
        prices: normalized,
        source: env.EXCHANGE_RATE_HTTP_SOURCE || 'http-oracle',
        fetchedAt: new Date().toISOString(),
    };
};

const staticProvider = ({ env }) => async () => ({
    prices: parseBaselines(env),
    source: 'static-baseline',
    // A configured baseline is a deliberate snapshot, not an oracle failure.
    fetchedAt: new Date().toISOString(),
    static: true,
});

const createProvider = (name, options) => {
    switch (String(name || '').toLowerCase()) {
        case 'coingecko':
            return coingeckoProvider(options);
        case 'stellar-dex':
        case 'horizon':
            return stellarDexProvider(options);
        case 'http':
            return httpProvider(options);
        case 'static':
            return staticProvider(options);
        default:
            return null;
    }
};

// ---------------------------------------------------------------------------
// Cache: Redis when available, in-memory otherwise. A failed Redis command
// degrades to memory rather than failing the worker or the request.
// ---------------------------------------------------------------------------

function createRateCache({
    env = process.env,
    redis = null,
    RedisClient = null,
    logger = console,
    now = Date.now,
    ttlMs = RATE_CACHE_TTL_MS,
} = {}) {
    let memory = null;
    let ownedRedis = null;
    let client = redis;
    if (!client && env.REDIS_URL) {
        try {
            const Redis = RedisClient || require('ioredis');
            client = new Redis(env.REDIS_URL, {
                enableOfflineQueue: false,
                maxRetriesPerRequest: 1,
                commandTimeout: Number(env.REDIS_COMMAND_TIMEOUT_MS) || 250,
            });
            client.on('error', (err) => logger.error?.(`Rate cache Redis error: ${err.message}`));
            client.unref?.();
            ownedRedis = client;
        } catch (err) {
            logger.warn?.(`Rate cache Redis unavailable, using memory: ${err.message}`);
            client = null;
        }
    }

    const key = CACHE_KEY;
    const isFresh = (snapshot) =>
        Boolean(snapshot?.fetchedAt) && now() - new Date(snapshot.fetchedAt).getTime() <= ttlMs;

    return {
        key: CACHE_KEY,
        isFresh,
        async read() {
            if (client) {
                try {
                    const raw = await client.get(key);
                    if (raw) return JSON.parse(raw);
                } catch (err) {
                    logger.warn?.(`Rate cache read failed, using memory: ${err.message}`);
                }
            }
            if (memory && now() - memory.storedAt <= RATE_CACHE_RETENTION_MS) return memory.snapshot;
            return null;
        },
        async write(snapshot) {
            memory = { snapshot, storedAt: now() };
            if (client) {
                try {
                    const ttlSeconds = Math.max(1, Math.ceil(RATE_CACHE_RETENTION_MS / 1000));
                    await client.set(key, JSON.stringify(snapshot), 'EX', ttlSeconds);
                } catch (err) {
                    logger.warn?.(`Rate cache write failed, using memory: ${err.message}`);
                }
            }
        },
        async close() {
            if (ownedRedis) await ownedRedis.quit().catch(() => {});
        },
    };
}

// ---------------------------------------------------------------------------
// Historical archive: one row per (asset, hour). Upsert with an explicit
// conflict target keeps replayed synchronizations idempotent.
// ---------------------------------------------------------------------------

function archiveHour(fetchedAt, now = Date.now) {
    const time = fetchedAt ? new Date(fetchedAt) : new Date(now());
    if (Number.isNaN(time.getTime())) time.setTime(now());
    time.setUTCMinutes(0, 0, 0);
    return time.toISOString();
}

function createRateArchive({ getSupabase, logger = console, intervalMs = DEFAULT_ARCHIVE_INTERVAL_MS } = {}) {
    let lastHour = null;
    return {
        intervalMs,
        async archive(snapshot) {
            const supabase = typeof getSupabase === 'function' ? getSupabase() : getSupabase;
            if (!supabase || !snapshot?.fetchedAt || snapshot.static) return false;
            if (typeof supabase.from !== 'function') return false;
            const hour = archiveHour(snapshot.fetchedAt);
            if (hour === lastHour) return false;
            const rows = SUPPORTED_ASSET_CODES.map((asset) => ({
                asset,
                price_usd: snapshot.prices[asset],
                source: snapshot.source,
                captured_at: snapshot.fetchedAt,
                archive_hour: hour,
            }));
            try {
                const { error } = await supabase
                    .from('exchange_rate_history')
                    .upsert(rows, { onConflict: 'asset,archive_hour' });
                if (error) {
                    logger.error?.(`Exchange rate archive failed: ${error.message || error}`);
                    return false;
                }
                lastHour = hour;
                return true;
            } catch (err) {
                logger.error?.(`Exchange rate archive failed: ${err.message || err}`);
                return false;
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Worker + snapshot assembly
// ---------------------------------------------------------------------------

const buildSnapshot = ({ prices, source, fetchedAt, static: isStatic = false }) => ({
    prices: normalizePrices(prices) || { ...parseBaselines() },
    source,
    fetchedAt,
    static: Boolean(isStatic),
});

function createExchangeRateWorker({
    env = process.env,
    getFetch = () => globalThis.fetch,
    cache,
    archive,
    getSupabase = () => null,
    primary = env.EXCHANGE_RATE_PRIMARY_ORACLE || 'coingecko',
    secondary = env.EXCHANGE_RATE_SECONDARY_ORACLE || 'stellar-dex',
    intervalMs = Number(env.EXCHANGE_RATE_SYNC_INTERVAL_MS) || DEFAULT_SYNC_INTERVAL_MS,
    logger = console,
    onError,
    now = Date.now,
} = {}) {
    const rateCache = cache || createRateCache({ env, logger, now });
    const rateArchive = archive || createRateArchive({ getSupabase, logger });
    const providerOptions = { env, getFetch };
    const primaryProvider = createProvider(primary, providerOptions);
    const secondaryProvider = createProvider(secondary, providerOptions);
    let timer = null;
    let inFlight = null;
    let lastSyncAt = null;
    let lastError = null;
    let lastSource = null;

    const pollProvider = async (provider) => {
        if (!provider) return null;
        try {
            const result = await provider();
            return buildSnapshot(result);
        } catch (err) {
            lastError = err?.message || String(err);
            return null;
        }
    };

    // One shared promise prevents overlapping synchronizations when the timer
    // fires while a slow feed is still being polled.
    const sync = () => {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            let snapshot = await pollProvider(primaryProvider);
            if (!snapshot) snapshot = await pollProvider(secondaryProvider);
            if (!snapshot) {
                return { ok: false, error: lastError || 'No primary or secondary oracle returned valid rates' };
            }
            await rateCache.write(snapshot);
            lastSyncAt = snapshot.fetchedAt;
            lastSource = snapshot.source;
            lastError = null;
            await rateArchive.archive(snapshot);
            return { ok: true, snapshot };
        })();
        const clearInFlight = () => {
            inFlight = null;
        };
        inFlight.then(clearInFlight, clearInFlight);
        return inFlight;
    };

    const readSnapshot = async ({ allowNetwork = false } = {}) => {
        const cached = await rateCache.read().catch(() => null);
        const fresh = rateCache.isFresh(cached);
        if (fresh) return { ...cached, cacheStatus: 'hit', fresh: true, fallbackUsed: false };

        if (allowNetwork) {
            const result = await sync().catch(() => ({ ok: false }));
            if (result.ok) return { ...result.snapshot, cacheStatus: 'miss', fresh: true, fallbackUsed: false };
        }

        if (cached && normalizePrices(cached.prices)) {
            return { ...cached, cacheStatus: fresh ? 'hit' : 'stale', fresh: false, fallbackUsed: true };
        }

        // Explicitly configured baseline, never presented as a fresh sync.
        return {
            ...buildSnapshot({ prices: parseBaselines(env), source: 'static-baseline', fetchedAt: null, static: true }),
            cacheStatus: 'miss',
            fresh: false,
            fallbackUsed: true,
        };
    };

    return {
        sync,
        readSnapshot,
        getStatus: () => ({ lastSyncAt, lastSource, lastError }),
        start() {
            if (timer) return this;
            // Kick off immediately but never block startup on network I/O.
            sync().catch((err) => {
                const message = err?.message || String(err);
                if (typeof onError === 'function') onError(err);
                else logger.error?.(`Exchange rate sync failed: ${message}`);
            });
            timer = setInterval(() => {
                sync().catch((err) => {
                    const message = err?.message || String(err);
                    if (typeof onError === 'function') onError(err);
                    else logger.error?.(`Exchange rate sync failed: ${message}`);
                });
            }, Math.max(1000, intervalMs));
            timer.unref?.();
            return this;
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            return rateCache.close?.();
        },
    };
}

// Structured payload for GET /api/rates. All values are derived from the USD
// price map, so the conversion matrix is internally consistent.
function buildRatePayload(snapshot) {
    const prices = normalizePrices(snapshot?.prices) || parseBaselines();
    const fiatRates = {
        USD: 1,
        EUR: isPositivePrice(prices.EURC) ? prices.EURC : null,
    };
    const ratesUsd = { ...prices, ...fiatRates };
    const conversionMatrix = {};
    for (const from of Object.keys(ratesUsd)) {
        conversionMatrix[from] = {};
        for (const to of Object.keys(ratesUsd)) {
            conversionMatrix[from][to] = from === to ? 1 : ratesUsd[from] / ratesUsd[to];
        }
    }

    const assets = {};
    for (const asset of SUPPORTED_ASSETS) {
        assets[asset.code] = {
            code: asset.code,
            type: asset.type,
            issuer: asset.issuer,
            price_usd: prices[asset.code],
            source: snapshot?.source ?? null,
            fetched_at: snapshot?.fetchedAt ?? null,
            fresh: Boolean(snapshot?.fresh),
        };
    }

    return {
        assets,
        supported_assets: [...SUPPORTED_ASSET_CODES],
        prices,
        fiat_rates: fiatRates,
        conversion_matrix: conversionMatrix,
        last_sync_at: snapshot?.fetchedAt ?? null,
        rate_source: snapshot?.source ?? null,
        cache_status: snapshot?.cacheStatus || 'miss',
        fresh: Boolean(snapshot?.fresh),
        fallback_used: Boolean(snapshot?.fallbackUsed),
    };
}

module.exports = {
    SUPPORTED_ASSETS,
    SUPPORTED_ASSET_CODES,
    RATE_CACHE_TTL_MS,
    RATE_CACHE_RETENTION_MS,
    DEFAULT_SYNC_INTERVAL_MS,
    DEFAULT_BASELINES,
    CACHE_KEY,
    createRateCache,
    createRateArchive,
    createExchangeRateWorker,
    buildRatePayload,
    buildSnapshot,
    archiveHour,
    normalizePrices,
    parseBaselines,
};
