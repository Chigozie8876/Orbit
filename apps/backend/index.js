const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');
const { StrKey, Keypair, rpc, Networks, TransactionBuilder, Contract, Address } = require('@stellar/stellar-sdk');
const { executeIdempotently, withBillingLock, sendResult } = require('./idempotency');
const { API_KEY_ENVIRONMENTS, issueApiKey, requireApiKey } = require('./apiKeys');
const {
    createRateLimiter,
    createStoreFromEnv,
    apiKeyTierLimit,
    apiKeyTierLimitsFromEnv,
    resolveApiKeyTier,
} = require('./rateLimit');
const { createReputationScorer, createHorizonWalletLookup } = require('./reputation');
const { isRelayerError, createRelayerFromEnv } = require('./relayer');
const { createFeeEstimator } = require('./fee-estimator');
const { getAuditLogsQuerySchema, getClientIp, getActorAddress, writeAuditLog } = require('./audit');
const {
    createWebhookSchema,
    updateWebhookSchema,
    backfillWebhookSchema,
    generateSigningSecret,
    dispatchWebhookEvent,
    resendWebhookDelivery,
    replayWebhookEvents,
    replayDeadLetter,
    setDeliveryObserver,
} = require('./webhooks');
const { createDeliveryAlertObserver, registerWebhookAlertRoutes } = require('./webhook-alerts');
const {
    DUNNING_INTERVAL_DAYS,
    MAX_DUNNING_RETRIES,
    calculateNextDunningRetry,
    generateRecoveryLink,
    markSubscriptionPastDue,
    processDunningRetries,
} = require('./dunning');
const { registerComplianceRoutes } = require('./compliance');
const { registerDunningWorkflowRoutes, loadDunningWorkflow } = require('./dunning-workflow');
const { registerSigningSessionRoutes } = require('./signing-sessions');
const { registerTransactionExportRoute, confirmedSettlementAmount } = require('./transaction-report');
const { registerCustomerPortalRoutes } = require('./customer-portal');
const { registerFailureRecoveryRoutes } = require('./failure-recovery');
const { registerAnalyticsRoutes } = require('./analytics');
const { registerCouponRoutes, normalizeCode } = require('./coupons');
const { registerGraphql } = require('./graphql');
const { createSubscriptionEventBus } = require('./subscription-stream');
const { registerHandoverRoutes } = require('./handover-sessions');
const { configuredIndexer, registerIndexerRoutes } = require('./ledger-indexer');
const { recordPullFailure, registerBillingResolutionRoutes } = require('./billing-resolution');
const {
    isFiatCurrency,
    getRate,
    calculateUsdcUnits,
    quoteUsdcAmount,
    getSupportedRates,
    startOracleWorker,
    SlippageError,
    RateUnavailableError,
} = require('./oracle');
const {
    createPayoutSplitDispatcher,
    createStellarSplitForwarder,
    registerPayoutSplitRoutes,
} = require('./payout-splits');
const {
    createPriceIndexationWorker,
    registerPriceIndexationRoutes,
} = require('./price-indexation');
const {
    createSnapshotExportWorker,
    registerSnapshotRoutes,
} = require('./contract-state-snapshot');
const { getDatabaseManager } = require('./db');
const { registerPrivacyRoutes } = require('./privacy');
const { createUsageBufferFromEnv, registerUsageRoutes, rollupUsage } = require('./usage-meter');
const { registerCohortRoutes } = require('./cohorts');
const { registerNotificationTemplateRoutes } = require('./notification-templates');
const { registerProofRoutes } = require('./proofs');
const { registerOrganizationRoutes } = require('./organizations');
const { registerRpcProxyRoute } = require('./rpc-proxy');
const { registerHealthMetrics, recordPullOutcome, setDbPoolSource } = require('./health-metrics');
const { captureStripeRawBody, registerStripeBillingRoutes } = require('./stripe-billing');
const { registerCredentialRoutes } = require('./credentials');
const { registerPaymentLinkRoutes } = require('./payment-links');
const { checkSchemaOnStartup } = require('./migrate');
const { createInvoiceService, registerInvoiceRoutes } = require('./invoices');
const { createEmailDispatcher, sendSettlementReceipt } = require('./receipt-email');
const { getSharedRpcPool } = require('./rpc-pool');
const { registerDevFundingRoutes } = require('./dev-faucet');

const app = express();
const feeEstimator = createFeeEstimator({ horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org' });
let defaultUsageBuffer;
const getUsageBuffer = () => app.locals.usageBuffer || (defaultUsageBuffer ??= createUsageBufferFromEnv());
// Set when running behind a reverse proxy so req.ip (used for rate limiting) is the client's address
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.use(cors());

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
// Shared by every limiter and the reputation scorer: Redis (with an in-memory
// fallback) when REDIS_URL is set, so limits hold across all API instances
const rateLimitStore = createStoreFromEnv();
// Wallet age is scored only when Horizon is configured; tests inject app.locals.walletLookup
const horizonWalletLookup = process.env.HORIZON_URL
    ? createHorizonWalletLookup({ horizonUrl: process.env.HORIZON_URL })
    : null;
const reputation = createReputationScorer({
    store: rateLimitStore,
    walletLookup: async (address) => {
        const lookup = app.locals.walletLookup || horizonWalletLookup;
        return lookup ? lookup(address) : null;
    },
    ipTrustAfterMs: Number(process.env.REPUTATION_IP_TRUST_AFTER_MS) || undefined,
});
// Coarse per-IP limit on every route, public or not, so unauthenticated traffic
// (including floods of invalid API keys) cannot exhaust the database. Scaled by the
// IP's reputation: new IPs and repeat offenders get less, merchant IPs more.
const ipRateLimit = createRateLimiter({
    name: 'ip',
    store: rateLimitStore,
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: reputation.ipLimit(Number(process.env.IP_RATE_LIMIT_MAX) || 300),
    keyGenerator: (req) => req.ip,
    onLimitReached: (req) => reputation.recordViolation(req.ip),
});
// Per-API-key limit on authenticated merchant routes (#231). The key's tier quota
// (free: 60, pro: 600 requests per window by default) is the base allowance, which
// reputation scoring then scales by key environment and wallet age as before.
const apiKeyTierLimits = apiKeyTierLimitsFromEnv();
const apiKeyTierQuota = apiKeyTierLimit(apiKeyTierLimits);
const apiKeyRateLimit = createRateLimiter({
    name: 'key',
    store: rateLimitStore,
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: (req) => reputation.apiKeyLimit(apiKeyTierQuota(req))(req),
    keyGenerator: (req) => req.apiKey?.id,
    message: "API key rate limit exceeded, please retry later",
    describe: (req) => ({ tier: resolveApiKeyTier(req, apiKeyTierLimits) }),
});
app.locals.rateLimiters = { ip: ipRateLimit, apiKey: apiKeyRateLimit };
app.locals.reputation = reputation;

app.use(ipRateLimit);
// Keeps the raw bytes of Stripe webhooks, which are signed over the exact body (#131)
app.use(express.json({ verify: captureStripeRawBody }));

// Multi-region database manager with read-replica failover (#139)
const dbManager = getDatabaseManager();
const getPrimarySupabase = (appInstance = app) => dbManager.getPrimaryClient(appInstance);
const getReadSupabase = (appInstance = app) => dbManager.getReadClient(appInstance);
const getSupabase = () => getPrimarySupabase(app);

// Merchant routes: authenticate the API key, then apply its rate limit
const authenticateMerchant = [requireApiKey(getSupabase), reputation.markAuthenticated, apiKeyRateLimit];
registerAnalyticsRoutes(app, getSupabase);
registerPaymentLinkRoutes(app, getSupabase, authenticateMerchant);
// Testnet Friendbot + USDC trustline bootstrap for local development (#232);
// not registered at all when NODE_ENV=production
registerDevFundingRoutes(app, {
    getFetch: () => app.locals.fetchImpl,
    getHorizonServer: () => app.locals.devHorizonServer,
});

// Allows tests to inject a mock Soroban RPC server instead of hitting testnet
let defaultRpcPool;
const getSorobanServer = (rpcUrl) => {
    if (app.locals.sorobanServer) return app.locals.sorobanServer;
    if (process.env.SOROBAN_RPC_SERVERS) {
        defaultRpcPool ??= getSharedRpcPool();
        return defaultRpcPool.proxy();
    }
    return new rpc.Server(rpcUrl);
};

// One relayer per process: its sequence cache and channel pool must be shared by all requests.
// Tests inject their own through app.locals.relayer.
let defaultRelayer;
const getRelayer = () => {
    if (app.locals.relayer) return app.locals.relayer;
    if (defaultRelayer === undefined) {
        defaultRelayer = createRelayerFromEnv({
            server: getSorobanServer(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'),
            getSupabase,
            feeEstimator,
        });
    }
    return defaultRelayer;
};

// Forward transfers for merchant payout splits (#160). The merchant treasury (or a
// dedicated split relayer) signs and pays; when no key is configured, splits are
// still recorded as pending so an operator can reconcile them later.
let defaultSplitForwarder;
const getSplitForwarder = () => {
    if (app.locals.splitForwarder !== undefined) return app.locals.splitForwarder;
    if (defaultSplitForwarder === undefined) {
        const secret = process.env.SPLIT_RELAYER_SECRET_KEY || process.env.RELAYER_SECRET_KEY;
        const tokenContractId = process.env.SPLIT_TOKEN_CONTRACT_ID || process.env.USDC_CONTRACT_ID;
        if (!secret || !tokenContractId) {
            defaultSplitForwarder = null;
        } else {
            defaultSplitForwarder = createStellarSplitForwarder({
                server: getSorobanServer(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'),
                sourceKeypair: Keypair.fromSecret(secret),
                tokenContractId,
                networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
            });
        }
    }
    return defaultSplitForwarder;
};

const getPayoutSplitDispatcher = () => createPayoutSplitDispatcher({
    supabase: getSupabase(),
    forwarder: getSplitForwarder(),
    getTreasuryWallet: async (merchantId) => {
        const supabase = getSupabase();
        if (!supabase) return null;
        const { data } = await supabase.from('merchants').select('wallet_address').eq('id', merchantId).maybeSingle();
        return data?.wallet_address ?? null;
    },
});

// Per-merchant throttle on relay requests, on top of the general API key limit
const relayRateLimit = createRateLimiter({
    name: 'relay',
    store: rateLimitStore,
    windowMs: Number(process.env.RELAYER_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    limit: Number(process.env.RELAYER_RATE_LIMIT_MAX) || 10,
    keyGenerator: (req) => req.merchant?.id,
    message: "Relay rate limit exceeded, please retry later",
});
app.locals.rateLimiters.relay = relayRateLimit;

// How long to keep polling getTransaction() for a submitted hash before giving up
const TX_POLL_TIMEOUT_MS = Number(process.env.TX_POLL_TIMEOUT_MS) || 30000;
const TX_POLL_INTERVAL_MS = Number(process.env.TX_POLL_INTERVAL_MS) || 1000;

// Billing lease for preparing a pull (simulation only)
const PREPARE_LOCK_TTL_SECONDS = Number(process.env.PREPARE_LOCK_TTL_SECONDS) || 60;
// Billing lease for submitting a pull must outlive confirmation polling
const submitLockTtlSeconds = (pollTimeoutMs) => Math.ceil(pollTimeoutMs / 1000) + 60;
// A relayed pull may also wait for a free channel and retry submission before polling
const relayLockTtlSeconds = (pollTimeoutMs) =>
    submitLockTtlSeconds(pollTimeoutMs) + Math.ceil((Number(process.env.RELAYER_QUEUE_TIMEOUT_MS) || 30000) / 1000) + 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls getTransaction(hash) until it settles to SUCCESS/FAILED, or returns NOT_FOUND on timeout
const waitForTransaction = async (server, hash, { timeoutMs = TX_POLL_TIMEOUT_MS, intervalMs = TX_POLL_INTERVAL_MS } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let lastResponse = await server.getTransaction(hash);

    while (lastResponse.status === "NOT_FOUND" && Date.now() < deadline) {
        await sleep(intervalMs);
        lastResponse = await server.getTransaction(hash);
    }

    return lastResponse;
};

// ==========================================
// VALIDATION SCHEMAS
// ==========================================

const stellarAddressSchema = z.string().refine(
    (val) => StrKey.isValidEd25519PublicKey(val),
    { message: "must be a valid Stellar Ed25519 public address" }
);

// merchant_id is taken from the API key; a client-supplied value is only checked against it
const optionalMerchantIdSchema = z.string().uuid("merchant_id must be a valid UUID").optional();

// USDC plans store raw token units (USDC has 7 decimals, so 290000000 = 29
// USDC), same as the contract's amount_per_interval. Fiat plans (USD/EUR) store
// a price_amount in that currency, which the exchange rate oracle converts to
// raw USDC units at the moment of pull (#96).
const usdcPlanSchema = z.object({
    merchant_id: optionalMerchantIdSchema,
    name: z.string().trim().min(1, "name cannot be empty"),
    usdc_amount: z.coerce.number()
        .int("usdc_amount must be an integer in raw token units")
        .positive("usdc_amount must be greater than 0"),
    interval_seconds: z.coerce.number().int().positive("interval_seconds must be a positive integer"),
    currency: z.enum(['USDC']).default('USDC'),
});

const fiatPlanSchema = z.object({
    merchant_id: optionalMerchantIdSchema,
    name: z.string().trim().min(1, "name cannot be empty"),
    price_amount: z.coerce.number()
        .positive("price_amount must be greater than 0"),
    interval_seconds: z.coerce.number().int().positive("interval_seconds must be a positive integer"),
    currency: z.enum(['USD', 'EUR']),
});

// Validates the body against the schema for its pricing currency, so a USDC
// plan still requires usdc_amount and a fiat plan still requires price_amount.
const parseCreatePlanBody = (body) => {
    const currencyResult = z
        .object({ currency: z.enum(['USDC', 'USD', 'EUR']) })
        .safeParse({ currency: body?.currency ?? 'USDC' });
    if (!currencyResult.success) return currencyResult;

    return currencyResult.data.currency === 'USDC'
        ? usdcPlanSchema.safeParse(body)
        : fiatPlanSchema.safeParse(body);
};

const getPlanParamsSchema = z.object({
    id: z.string().uuid("id parameter must be a valid UUID"),
});

const getSubscribersQuerySchema = z.object({
    merchant_id: optionalMerchantIdSchema,
});

const createSubscriptionSchema = z.object({
    plan_id: z.string().uuid("plan_id must be a valid UUID"),
    customer_wallet_address: stellarAddressSchema,
    metadata: z.record(z.any()).optional().default({}),
    coupon_code: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

const triggerPullSchema = z.object({
    subscription_id: z.string().uuid("subscription_id must be a valid UUID"),
}).strict();

const submitPullSchema = z.object({
    subscription_id: z.string().uuid("subscription_id must be a valid UUID"),
    signed_xdr: z.string().min(1, "signed_xdr is required"),
}).strict();

const relaySubmitPullSchema = z.object({
    subscription_id: z.string().uuid("subscription_id must be a valid UUID"),
    signed_auth_entry_xdr: z.string().min(1, "signed_auth_entry_xdr is required"),
}).strict();

const createApiKeySchema = z.object({
    name: z.string().trim().min(1, "name cannot be empty").max(255, "name must be at most 255 characters"),
    environment: z.enum(API_KEY_ENVIRONMENTS, { message: "environment must be 'live' or 'test'" }),
}).strict();

const apiKeyParamsSchema = z.object({
    id: z.string().uuid("id parameter must be a valid UUID"),
});

// PostgREST reports a .single() lookup that matched no rows as an error, not as empty data
const isNoRowsError = (error) => error?.code === 'PGRST116';

// Postgres foreign key violation, e.g. inserting a subscription for a plan that does not exist
const isForeignKeyError = (error) => error?.code === '23503';

// Postgres unique violation, e.g. the same wallet subscribing to the same plan twice
const isUniqueViolation = (error) => error?.code === '23505';

const formatZodError = (err) => {
    const issue = err.issues[0];
    const field = issue.path.join('.') || 'input';
    return `Invalid input on ${field}: ${issue.message}`;
};

// Rejects a client-supplied merchant_id that names a merchant other than the authenticated one
const merchantMismatch = (req, merchantId) =>
    merchantId !== undefined && merchantId !== req.merchant.id;

const MERCHANT_MISMATCH_ERROR = { error: "merchant_id does not match the authenticated API key" };

// ==========================================
// ROUTE 1: POST /plans (Create a new pricing plan)
// ==========================================
app.post('/plans', authenticateMerchant, async (req, res) => {
    const parseResult = parseCreatePlanBody(req.body);
    if (!parseResult.success) {
        return res.status(400).json({ error: formatZodError(parseResult.error) });
    }
    if (merchantMismatch(req, parseResult.data.merchant_id)) return res.status(403).json(MERCHANT_MISMATCH_ERROR);

    const { name, currency, interval_seconds } = parseResult.data;
    const merchant_id = req.merchant.id;
    const supabase = getPrimarySupabase();
    if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });
    if (!dbManager.isPrimaryHealthy()) {
        return res.status(503).json({ error: "Primary database is currently unavailable; write operations are suspended" });
    }

    const result = await executeIdempotently({
        supabase,
        req,
        label: "creating plan",
        resolveMerchant: () => ({ merchantId: merchant_id }),
    }, async () => {
        // Fiat plans: cache the current USDC equivalent for dashboards. The
        // authoritative amount is always recalculated at the moment of pull;
        // when the cache is cold the placeholder stays 0 until the oracle
        // worker publishes the first rate.
        let usdc_amount = parseResult.data.usdc_amount;
        const price_amount = parseResult.data.price_amount;
        if (isFiatCurrency(currency)) {
            usdc_amount = 0;
            try {
                const rateInfo = await getRate({
                    supabase,
                    fetchImpl: app.locals.fetchImpl,
                    currency,
                    allowNetwork: false,
                });
                if (rateInfo) usdc_amount = calculateUsdcUnits({ amount: price_amount, rate: rateInfo.rate });
            } catch (err) {
                console.error("Error deriving plan usdc_amount from oracle cache:", err.message);
            }
        }

        const { data, error } = await supabase
            .from('plans')
            .insert([{ merchant_id, name, currency, usdc_amount, price_amount, interval_seconds }])
            .select()
            .single();

        if (isForeignKeyError(error)) return { status: 404, body: { error: "Merchant not found" } };
        if (error) throw error;

        await writeAuditLog(supabase, {
            merchantId: merchant_id,
            actorAddress: getActorAddress(req, null),
            action: 'plan.create',
            resourceType: 'plan',
            resourceId: data.id,
            ipAddress: getClientIp(req),
            changesBefore: null,
            changesAfter: data,
        });

        return { status: 201, body: { message: "Plan created successfully", plan: data } };
    });
    sendResult(res, result);
});

// ==========================================
// ROUTE 2: GET /plans/:id (Fetch plan details for Checkout Widget)
// ==========================================
app.get('/plans/:id', async (req, res) => {
    const parseResult = getPlanParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
        return res.status(400).json({ error: formatZodError(parseResult.error) });
    }

    try {
        const { id } = parseResult.data;
        const supabase = getReadSupabase();
        if (!supabase) return res.status(500).json({ error: "Database client not initialized" });

        const { data, error } = await supabase
            .from('plans')
            .select('*, merchants(name, wallet_address)') // Also fetch the merchant's details
            .eq('id', id)
            .single();

        if (isNoRowsError(error)) return res.status(404).json({ error: "Plan not found" });
        if (error) throw error;
        if (!data) return res.status(404).json({ error: "Plan not found" });

        res.status(200).json({ plan: data });
    } catch (err) {
        console.error("Error fetching plan:", err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROUTE 3: GET /subscribers (Fetch active subscribers for dashboard)
// ==========================================
app.get('/subscribers', authenticateMerchant, async (req, res) => {
    const parseResult = getSubscribersQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
        return res.status(400).json({ error: formatZodError(parseResult.error) });
    }
    if (merchantMismatch(req, parseResult.data.merchant_id)) return res.status(403).json(MERCHANT_MISMATCH_ERROR);

    try {
        const merchant_id = req.merchant.id;
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });

        // Find all subscriptions tied to plans owned by this merchant
        const { data, error } = await supabase
            .from('subscriptions')
            .select(`
                *,
                plans!inner(merchant_id, name, usdc_amount)
            `)
            .eq('plans.merchant_id', merchant_id);

        if (error) throw error;

        res.status(200).json({ subscribers: data });
    } catch (err) {
        console.error("Error fetching subscribers:", err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROUTE: GET /rates (Exchange rate oracle)
// ==========================================
// Returns the supported fiat->USDC conversion pairs with their newest cached
// rate, refreshed from the live feed on a cold cache (#96).
app.get('/rates', async (req, res) => {
    try {
        const supabase = getReadSupabase();
        if (!supabase) return res.status(500).json({ error: "Database client not initialized" });

        const rates = await getSupportedRates({ supabase, fetchImpl: app.locals.fetchImpl });
        res.status(200).json(rates);
    } catch (err) {
        console.error("Error fetching exchange rates:", err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROUTE 4: POST /trigger-pull (The Blockchain Bridge)
// ==========================================
// Loads a subscription owned by the authenticated merchant. Another merchant's
// subscription is reported as not found so its existence is not revealed.
const loadPullContext = async (supabase, subscriptionId, merchant) => {
    const { data: sub, error: subError } = await supabase
        .from('subscriptions')
        .select(`
            *,
            plans ( merchant_id, usdc_amount, interval_seconds, currency, price_amount )
        `)
        .eq('id', subscriptionId)
        .single();

    if (isNoRowsError(subError) || !sub) return { status: 404, error: "Subscription not found" };
    if (subError) throw subError;
    if (sub.plans?.merchant_id !== merchant.id) return { status: 404, error: "Subscription not found" };
    // A coupon quote must not silently charge the fixed-price legacy Soroban vault.
    if (sub.coupon_id && !sub.promotion_onchain_verified) {
        return { status: 409, error: "Promotional vault terms are not verified on-chain; billing is blocked" };
    }

    return { sub, merchant };
};

// Records the confirmed outcome of a pull transaction, whoever submitted it
const applyPullOutcome = async ({
    supabase,
    req,
    sub,
    merchant,
    subscription_id,
    txHash,
    status,
    confirmation = null,
    server = null,
    signedTx = null,
    extraBody = {},
    // Seconds spent waiting for Soroban confirmation, for orbit_pull_duration_seconds (#230)
    confirmationSeconds = null,
}) => {
    recordPullOutcome(status, confirmationSeconds);
    if (status === "SUCCESS") {
        const pullTime = new Date();
        const nextBilling = new Date(pullTime.getTime() + Number(sub.plans.interval_seconds) * 1000);

        await supabase
            .from('subscriptions')
            .update({
                next_billing_date: nextBilling.toISOString(),
                status: 'active',
                retry_count: 0,
                dunning_status: null,
                next_dunning_retry_at: null,
                last_failure: null,
            })
            .eq('id', subscription_id);

        await writeAuditLog(supabase, {
            merchantId: sub.plans.merchant_id,
            actorAddress: getActorAddress(req, merchant.wallet_address),
            action: 'pull.execute',
            resourceType: 'subscription',
            resourceId: subscription_id,
            ipAddress: getClientIp(req),
            changesBefore: { next_billing_date: sub.next_billing_date, status: sub.status },
            changesAfter: { next_billing_date: nextBilling.toISOString(), status: 'active', txHash },
        });

        if (sub.plans.merchant_id) {
            // Fiat plans report the settled amount in raw USDC units
            // converted at the current cached rate (#96)
            let settledAmount = sub.plans.usdc_amount;
            if (isFiatCurrency(sub.plans?.currency)) {
                try {
                    const quote = await quoteUsdcAmount({
                        supabase,
                        plan: sub.plans,
                        subscription: sub,
                        fetchImpl: app.locals.fetchImpl,
                        allowNetwork: false,
                        enforceSlippage: false,
                    });
                    settledAmount = quote.usdc_amount;
                } catch {
                    // Keep the stored plan amount when the cache cannot price it
                }
            }

            // Only emit settlement events for independently verified on-chain transfers.
            const verifiedAmount = confirmedSettlementAmount(confirmation, {
                customerWallet: sub.customer_wallet_address,
                merchantWallet: merchant.wallet_address,
                contractId: process.env.ORBIT_CONTRACT_ID,
            });
            if (verifiedAmount === null) {
                console.error('CRITICAL: confirmed transfer missing verified amount; reconcile transaction:', txHash);
            } else {
                const paymentRecord = {
                    merchant_id: sub.plans.merchant_id,
                    subscription_id,
                    plan_id: sub.plan_id,
                    customer_wallet_address: sub.customer_wallet_address,
                    amount_usdc_units: verifiedAmount,
                    status: 'settled',
                    tx_hash: txHash,
                    settled_at: pullTime.toISOString(),
                };
                const { data: payment, error: paymentError } = await supabase
                    .from('payment_transactions').insert([paymentRecord]).select().single();
                if (paymentError && paymentError.code !== '23505') {
                    console.error('CRITICAL: on-chain settlement needs ledger reconciliation:', txHash, paymentError);
                } else {
                    // Publication happens only after a confirmed transfer is recorded,
                    // and is safe for consumers to deduplicate by transaction hash.
                    app.locals.paymentEventBus?.publish('paymentSettled', {
                        id: txHash, merchantId: sub.plans.merchant_id,
                        subscriptionId: subscription_id,
                        amount: String(verifiedAmount),
                        txHash, status: 'settled', settledAt: pullTime.toISOString(),
                    }).catch((error) => console.error('Settlement stream publish failed:', error));
                }
                if (payment) {
                    try {
                        const invoiceService = app.locals.invoiceService || createInvoiceService({ supabase });
                        const receipt = await invoiceService.createForSettledPayment({
                            payment, merchant, plan: sub.plans, subscription: sub,
                            ledgerSequence: confirmation?.ledger ?? confirmation?.ledgerSequence ?? null,
                        });
                        if (receipt?.invoice && receipt?.pdf) {
                            const dispatcher = app.locals.receiptEmailDispatcher || createEmailDispatcher({
                                fetchImpl: app.locals.fetchImpl || globalThis.fetch,
                            });
                            await sendSettlementReceipt({
                                dispatcher,
                                invoice: receipt.invoice,
                                payment,
                                merchant,
                                plan: sub.plans,
                                subscription: sub,
                                pdf: receipt.pdf,
                            });
                        }
                    } catch (invoiceError) {
                        console.error('Invoice generation failed:', invoiceError);
                    }
                }
            }

            await dispatchWebhookEvent(supabase, {
                merchantId: sub.plans.merchant_id,
                eventType: 'payment.settled',
                payload: {
                    event: 'payment.settled',
                    subscription_id,
                    customer_wallet_address: sub.customer_wallet_address,
                    amount: settledAmount,
                    txHash,
                    settled_at: pullTime.toISOString(),
                },
                fetchImpl: app.locals.fetchImpl,
            });

            // Automated revenue sharing (#160): forward each configured split
            // share from the merchant treasury, recording the primary pull hash
            // next to every secondary split transfer hash. Failures here never
            // fail the settlement itself.
            try {
                await getPayoutSplitDispatcher().handlePaymentSettled({
                    merchantId: sub.plans.merchant_id,
                    subscriptionId: subscription_id,
                    primaryTxHash: txHash,
                    amountUnits: sub.plans.usdc_amount,
                    settledAt: pullTime.toISOString(),
                    fetchImpl: app.locals.fetchImpl,
                });
            } catch (splitErr) {
                console.error("Payout split dispatch failed:", splitErr);
            }
        }

        return {
            status: 200,
            body: { message: "Successfully pulled funds on-chain!", txHash, ...extraBody },
        };
    }

    if (status === "FAILED") {
        await recordPullFailure(supabase, subscription_id, 'Transaction failed on-chain; inspect transaction diagnostics for the specific contract error.', txHash);
        if (server && signedTx) {
            let failureReason = 'Transaction failed on-chain; inspect transaction diagnostics for the specific contract error.';
            try {
                const simulation = await server.simulateTransaction(signedTx);
                if (simulation?.error) failureReason = simulation.error;
            } catch {
                // Keep the original failure when RPC diagnostics are unavailable
            }
            await recordPullFailure(supabase, subscription_id, failureReason, txHash);
        }
        await markSubscriptionPastDue(supabase, subscription_id, {
            actorAddress: merchant.wallet_address,
            ipAddress: getClientIp(req),
            fetchImpl: app.locals.fetchImpl,
        });

        return {
            status: 502,
            body: { error: "Transaction failed on-chain", txHash, ...extraBody },
        };
    }

    // Still NOT_FOUND after the timeout: outcome unknown, let the caller poll later.
    // Keep the lease until it expires so no second pull races the one still in flight.
    await recordPullFailure(supabase, subscription_id, 'RPC timeout: transaction submitted but not yet confirmed. Do not retry until its outcome is known.', txHash);
    if (server && signedTx) {
        await recordPullFailure(
            supabase,
            subscription_id,
            'Transaction submitted, but Soroban RPC confirmation timed out (NOT_FOUND)',
            txHash,
        );
    }
    return {
        status: 202,
        body: { message: "Transaction submitted but not yet confirmed; check back later", txHash, ...extraBody },
        holdLock: true,
    };
};

app.post('/trigger-pull', authenticateMerchant, async (req, res) => {
    const parseResult = triggerPullSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({ error: formatZodError(parseResult.error) });
    }

    let ownedSubscriptionId;
    try {
        const { subscription_id } = parseResult.data;
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });

        const context = await loadPullContext(supabase, subscription_id, req.merchant);
        if (context.error) return res.status(context.status).json({ error: context.error });
        const { sub, merchant } = context;
        ownedSubscriptionId = subscription_id;

        const result = await executeIdempotently({
            supabase,
            req,
            label: "preparing pull",
            resolveMerchant: () => ({ merchantId: sub.plans.merchant_id }),
        }, async () => {
            // Price the pull (#96): fiat plans convert price_amount into raw
            // USDC units at the live rate and are rejected when the rate moved
            // more than the slippage tolerance away from the quoted rate.
            let pricing;
            try {
                pricing = await quoteUsdcAmount({
                    supabase,
                    plan: sub.plans,
                    subscription: sub,
                    fetchImpl: app.locals.fetchImpl,
                });
            } catch (err) {
                if (err instanceof SlippageError) {
                    return { status: 409, body: { error: err.message, ...err.details } };
                }
                if (err instanceof RateUnavailableError) {
                    return { status: 503, body: { error: err.message } };
                }
                throw err;
            }

            // A fiat subscription created while the rate cache was cold has no
            // quote yet: store this pull's rate so the next one is guarded.
            if (
                isFiatCurrency(sub.plans?.currency) &&
                pricing.rate != null &&
                (sub.quoted_rate === null || sub.quoted_rate === undefined)
            ) {
                const { error: quoteError } = await supabase
                    .from('subscriptions')
                    .update({ quoted_rate: pricing.rate })
                    .eq('id', subscription_id);
                if (quoteError) console.error("Failed to persist subscription quote:", quoteError.message);
            }

            return withBillingLock({
                supabase,
                subscriptionId: subscription_id,
                ttlSeconds: PREPARE_LOCK_TTL_SECONDS,
            }, async () => {
                const ORBIT_CONTRACT_ID = process.env.ORBIT_CONTRACT_ID;
                if (!ORBIT_CONTRACT_ID) {
                    return { status: 500, body: { error: "ORBIT_CONTRACT_ID not set in .env" } };
                }

                const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
                const server = getSorobanServer(rpcUrl);
                const contract = new Contract(ORBIT_CONTRACT_ID);

                // 3. Build the Soroban Transaction
                const account = await server.getAccount(merchant.wallet_address);

                const tx = new TransactionBuilder(account, {
                    fee: String(await feeEstimator.estimate({ priority: "standard" })),
                    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET
                })
                .addOperation(contract.call("pull_funds",
                    Address.fromString(sub.customer_wallet_address).toScVal(),
                    Address.fromString(merchant.wallet_address).toScVal()
                ))
                .setTimeout(30)
                .build();

                // Simulate and return an unsigned envelope. The merchant signs it in their wallet.
                const preparedTx = await server.prepareTransaction(tx);

                await writeAuditLog(supabase, {
                    merchantId: sub.plans.merchant_id,
                    actorAddress: getActorAddress(req, merchant.wallet_address),
                    action: 'pull.prepare',
                    resourceType: 'subscription',
                    resourceId: subscription_id,
                    ipAddress: getClientIp(req),
                    changesBefore: null,
                    changesAfter: { subscription_id, merchant_address: merchant.wallet_address },
                });

                return {
                    status: 200,
                    body: {
                        transaction_xdr: preparedTx.toXDR(),
                        network_passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
                        merchant_address: merchant.wallet_address,
                        subscription_id,
                        // Amount to settle this cycle (raw USDC units)
                        usdc_amount: pricing.usdc_amount,
                        currency: pricing.currency,
                        rate: pricing.rate,
                    },
                };
            });
        });
        if (result.status >= 500) await recordPullFailure(supabase, subscription_id, result.body?.error || 'Pull preparation failed');
        sendResult(res, result);
    } catch (err) {
        console.error("Error preparing pull:", err);
        if (ownedSubscriptionId) await recordPullFailure(getSupabase(), ownedSubscriptionId, err.message).catch(console.error);
        res.status(500).json({ error: err.message });
    }
});

// Accept only a wallet-signed envelope, verify the merchant signature, then submit it.
app.post('/submit-pull', authenticateMerchant, async (req, res) => {
    const parseResult = submitPullSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: formatZodError(parseResult.error) });

    let ownedSubscriptionId;
    try {
        const { subscription_id, signed_xdr } = parseResult.data;
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });
        const context = await loadPullContext(supabase, subscription_id, req.merchant);
        if (context.error) return res.status(context.status).json({ error: context.error });
        const { sub, merchant } = context;
        ownedSubscriptionId = subscription_id;

        const pollTimeoutMs = app.locals.txPollTimeoutMs ?? TX_POLL_TIMEOUT_MS;

        const result = await executeIdempotently({
            supabase,
            req,
            label: "submitting pull",
            resolveMerchant: () => ({ merchantId: sub.plans.merchant_id }),
        }, async () => {
            const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
            let signedTx;
            try {
                signedTx = TransactionBuilder.fromXDR(signed_xdr, networkPassphrase);
            } catch {
                return { status: 400, body: { error: "signed_xdr is not a valid Stellar transaction envelope" } };
            }
            if (signedTx.source !== merchant.wallet_address) {
                return { status: 401, body: { error: "Transaction source does not match the plan owner's address" } };
            }
            const invocation = signedTx.operations.length === 1 && signedTx.operations[0].type === 'invokeHostFunction'
                ? signedTx.operations[0].func?.invokeContract
                : null;
            const isExpectedPull = invocation
                && invocation.functionName.toString() === 'pull_funds'
                && StrKey.encodeContract(invocation.contractAddress.contractId.value) === process.env.ORBIT_CONTRACT_ID
                && invocation.args.length === 2
                && Address.fromScVal(invocation.args[0]).toString() === sub.customer_wallet_address
                && Address.fromScVal(invocation.args[1]).toString() === merchant.wallet_address;
            if (!isExpectedPull) {
                return { status: 400, body: { error: "Signed transaction does not match this subscription's pull" } };
            }
            const merchantKey = Keypair.fromPublicKey(merchant.wallet_address);
            const hasMerchantSignature = signedTx.signatures.some(({ signature }) =>
                merchantKey.verify(signedTx.hash(), signature.value)
            );
            if (!hasMerchantSignature) {
                return { status: 401, body: { error: "A valid merchant wallet signature is required" } };
            }

            // Only one submission per subscription may be in flight at a time
            return withBillingLock({
                supabase,
                subscriptionId: subscription_id,
                ttlSeconds: submitLockTtlSeconds(pollTimeoutMs),
            }, async () => {
                const server = getSorobanServer(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org');
                const submitResponse = await server.sendTransaction(signedTx);

                if (submitResponse.status !== "PENDING" && submitResponse.status !== "SUCCESS") {
                    throw new Error(`Transaction submission failed: ${JSON.stringify(submitResponse)}`);
                }

                const txHash = submitResponse.hash;

                // 5. Confirm the transaction actually landed before touching billing state
                const confirmStarted = process.hrtime.bigint();
                const confirmation = await waitForTransaction(server, txHash, {
                    timeoutMs: pollTimeoutMs,
                    intervalMs: app.locals.txPollIntervalMs ?? TX_POLL_INTERVAL_MS,
                });

                return applyPullOutcome({
                    supabase,
                    req,
                    sub,
                    merchant,
                    subscription_id,
                    txHash,
                    status: confirmation.status,
                    confirmation,
                    server,
                    signedTx,
                    confirmationSeconds: Number(process.hrtime.bigint() - confirmStarted) / 1e9,
                });
            });
        });
        sendResult(res, result);
    } catch (err) {
        console.error("Error submitting pull:", err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROUTE 4b: Sponsored pulls through the fee-bump relayer
// ==========================================
// The merchant signs only the Soroban authorization for pull_funds; the Orbit relayer
// submits the transaction and pays its fees, so the merchant wallet needs no XLM for fees.

const relayerErrorResult = (err) => ({
    status: err.status,
    body: { error: err.message, code: err.code },
    headers: err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : undefined,
});

const RELAYER_NOT_CONFIGURED = { error: "Gas sponsorship relayer is not configured", code: "relayer_unavailable" };

app.post('/relay/prepare-pull', authenticateMerchant, relayRateLimit, async (req, res) => {
    const parseResult = triggerPullSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: formatZodError(parseResult.error) });

    try {
        const { subscription_id } = parseResult.data;
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });
        const relayer = getRelayer();
        if (!relayer) return res.status(503).json(RELAYER_NOT_CONFIGURED);

        const context = await loadPullContext(supabase, subscription_id, req.merchant);