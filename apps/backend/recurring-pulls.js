'use strict';

const crypto = require('node:crypto');

const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const DEFAULTS = {
    intervalMs: 30_000,
    pageSize: 100,
    leaseSeconds: 600,
    maxAttempts: DEFAULT_RETRY_DELAYS_MS.length + 1,
    transactionTimeoutMs: 5 * 60_000,
    transactionPollIntervalMs: 3_000,
    signerTimeoutMs: 15_000,
};

const jsonLogger = {
    info: (event, fields) => console.log(JSON.stringify({ level: 'info', event, ...fields })),
    warn: (event, fields) => console.warn(JSON.stringify({ level: 'warn', event, ...fields })),
    error: (event, fields) => console.error(JSON.stringify({ level: 'error', event, ...fields })),
};

const vaultIdFor = (user, merchant) =>
    crypto.createHash('sha256').update(`${user}:${merchant}`).digest('hex');

const isTransientPullError = (error) => {
    if (error?.name === 'AbortError') return true;
    const status = Number(error?.status ?? error?.statusCode);
    if (status === 429 || status >= 500) return true;
    const code = String(error?.code ?? '').toLowerCase();
    const message = String(error?.message ?? '').toLowerCase();
    return [
        'txbadseq',
        'try_again_later',
        'timeout',
        'timed out',
        'econnreset',
        'econnrefused',
        'enetunreach',
        'eai_again',
        'sequence number',
        'temporarily unavailable',
    ].some((part) => code.includes(part) || message.includes(part));
};

const retryDelayMs = (attemptCount) =>
    DEFAULT_RETRY_DELAYS_MS[Math.min(Math.max(0, attemptCount - 1), DEFAULT_RETRY_DELAYS_MS.length - 1)];

const createRemoteMerchantSigner = ({
    url,
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULTS.signerTimeoutMs,
}) => {
    if (!url || !token) throw new Error('RECURRING_PULL_SIGNER_URL and RECURRING_PULL_SIGNER_TOKEN are required');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required for the recurring pull signer');

    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname)) {
        throw new Error('The recurring pull signer URL must use HTTPS');
    }

    return {
        async signPullAuthorization(payload) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        action: 'sign_soroban_pull_authorization',
                        auth_entry_xdr: payload.authEntryXdr,
                        subscriber_address: payload.user,
                        merchant_address: payload.merchant,
                        contract_id: payload.contractId,
                        network_passphrase: payload.networkPassphrase,
                        valid_until_ledger: payload.validUntilLedger,
                    }),
                    signal: controller.signal,
                });
                if (!response.ok) {
                    throw Object.assign(new Error(`Merchant signer returned HTTP ${response.status}`), {
                        status: response.status,
                    });
                }
                const result = await response.json();
                if (typeof result?.signed_auth_entry_xdr !== 'string' || !result.signed_auth_entry_xdr) {
                    throw new Error('Merchant signer response must include signed_auth_entry_xdr');
                }
                return result.signed_auth_entry_xdr;
            } finally {
                clearTimeout(timer);
            }
        },
    };
};

const createSupabaseStore = (supabase) => ({
    async listDueSubscriptions({ now, limit, offset }) {
        const { data, error } = await supabase
            .from('subscriptions')
            .select(`
                id, plan_id, customer_wallet_address, next_billing_date, status,
                coupon_id, promotion_onchain_verified,
                plans!inner (
                    id, merchant_id, interval_seconds, usdc_amount, currency, price_amount,
                    merchants!inner ( id, wallet_address )
                )
            `)
            .eq('status', 'active')
            .lte('next_billing_date', now.toISOString())
            .order('id')
            .range(offset, offset + limit - 1);
        if (error) throw error;
        return data ?? [];
    },

    async claimCycle({ vaultId, billingCycle, subscriptionId, leaseToken, leaseSeconds }) {
        const { data, error } = await supabase.rpc('claim_recurring_pull_cycle', {
            p_vault_id: vaultId,
            p_billing_cycle: billingCycle,
            p_subscription_id: subscriptionId,
            p_lease_token: leaseToken,
            p_lease_seconds: leaseSeconds,
        });
        if (error) throw error;
        const claim = Array.isArray(data) ? data[0] : data;
        return {
            claimed: claim?.claimed === true,
            attemptCount: Number(claim?.attempt_count ?? 0),
            transactionHash: claim?.transaction_hash ?? null,
        };
    },

    async updateClaim({ vaultId, billingCycle, leaseToken, fields }) {
        const { data, error } = await supabase
            .from('recurring_pull_executions')
            .update(fields)
            .eq('vault_id', vaultId)
            .eq('billing_cycle', billingCycle)
            .eq('lease_token', leaseToken)
            .eq('state', 'processing')
            .select('vault_id');
        if (error) throw error;
        if (!data?.length) throw new Error('Recurring pull lease was lost before execution state could be updated');
    },

    async saveTransactionHash(claim, transactionHash) {
        await this.updateClaim({
            ...claim,
            fields: { transaction_hash: transactionHash, updated_at: new Date().toISOString() },
        });
    },

    async retryCycle(claim, { nextRetryAt, error, transactionHash }) {
        await this.updateClaim({
            ...claim,
            fields: {
                state: 'retry',
                next_retry_at: nextRetryAt.toISOString(),
                transaction_hash: transactionHash ?? null,
                last_error: error,
                lease_token: null,
                locked_until: null,
                updated_at: new Date().toISOString(),
            },
        });
    },

    async settleCycle(claim, { transactionHash, settledAt, nextBillingDate }) {
        const { data, error } = await supabase.rpc('settle_recurring_pull_cycle', {
            p_vault_id: claim.vaultId,
            p_billing_cycle: claim.billingCycle,
            p_lease_token: claim.leaseToken,
            p_transaction_hash: transactionHash,
            p_settled_at: settledAt.toISOString(),
            p_next_billing_date: nextBillingDate.toISOString(),
        });
        if (error) throw error;
        if (data !== true) throw new Error('Recurring pull lease was lost before settlement');
    },

    async failCycle(claim, { error, transactionHash }) {
        await this.updateClaim({
            ...claim,
            fields: {
                state: 'failed',
                transaction_hash: transactionHash ?? null,
                next_retry_at: null,
                last_error: error,
                lease_token: null,
                locked_until: null,
                updated_at: new Date().toISOString(),
            },
        });
    },
});

const createRecurringPullWorker = ({
    store,
    relayer,
    signer,
    contractId,
    networkPassphrase,
    waitForTransaction,
    settle,
    fail = async () => {},
    logger = jsonLogger,
    now = () => new Date(),
    options = {},
}) => {
    if (!store || !relayer || !signer || !contractId || !waitForTransaction || !settle) {
        throw new Error('Recurring pull worker is missing a required dependency');
    }
    const opts = { ...DEFAULTS, ...options };

    const finishSuccess = async ({ sub, claim, transactionHash, confirmation }) => {
        if (confirmation?.status !== 'SUCCESS') {
            throw new Error(`Cannot settle recurring pull without SUCCESS confirmation (received ${confirmation?.status ?? 'unknown'})`);
        }
        const merchant = sub.plans.merchants;
        const settledAt = now();
        const nextBillingDate = new Date(settledAt.getTime() + Number(sub.plans.interval_seconds) * 1000);
        await store.settleCycle(claim, { transactionHash, settledAt, nextBillingDate });
        try {
            await settle({ sub, merchant, transactionHash, confirmation, settledAt, nextBillingDate });
        } catch (error) {
            logger.error('recurring_pull.settlement_side_effect_error', {
                subscription_id: sub.id,
                transaction_hash: transactionHash,
                error: error.message,
            });
        }
    };

    const processSubscription = async (sub) => {
        const merchant = sub.plans?.merchants;
        if (!merchant?.wallet_address || !sub.customer_wallet_address || !sub.next_billing_date) {
            throw new Error(`Subscription ${sub.id} is missing recurring pull data`);
        }
        if (sub.coupon_id && !sub.promotion_onchain_verified) {
            logger.warn('recurring_pull.promotion_not_verified', { subscription_id: sub.id });
            return { status: 'blocked' };
        }

        const billingCycle = new Date(sub.next_billing_date);
        if (!Number.isFinite(billingCycle.getTime())) throw new Error(`Subscription ${sub.id} has an invalid next_billing_date`);
        const claim = {
            vaultId: vaultIdFor(sub.customer_wallet_address, merchant.wallet_address),
            billingCycle: billingCycle.toISOString(),
            subscriptionId: sub.id,
            leaseToken: crypto.randomUUID(),
            leaseSeconds: opts.leaseSeconds,
        };
        const acquired = await store.claimCycle(claim);
        if (!acquired.claimed) return { status: 'locked' };
        claim.attemptCount = acquired.attemptCount;
        let transactionHash = acquired.transactionHash;

        if (!transactionHash && claim.attemptCount > opts.maxAttempts) {
            const error = 'Recurring pull exceeded the configured maximum attempt count';
            await store.failCycle(claim, { error, transactionHash: null });
            try {
                await fail({ sub, merchant, transactionHash: null, error });
            } catch (failureError) {
                logger.error('recurring_pull.failure_settlement_error', {
                    subscription_id: sub.id,
                    error: failureError.message,
                });
            }
            return { status: 'failed', error };
        }

        try {
            let confirmation;
            if (transactionHash) {
                confirmation = await waitForTransaction(transactionHash, {
                    timeoutMs: opts.transactionTimeoutMs,
                    intervalMs: opts.transactionPollIntervalMs,
                });
            } else {
                const prepared = await relayer.preparePullAuthorization({
                    user: sub.customer_wallet_address,
                    merchant: merchant.wallet_address,
                });
                const signedEntryXdr = await signer.signPullAuthorization({
                    authEntryXdr: prepared.authEntryXdr,
                    user: sub.customer_wallet_address,
                    merchant: merchant.wallet_address,
                    contractId,
                    networkPassphrase,
                    validUntilLedger: prepared.validUntilLedger,
                });
                const entry = await relayer.verifyPullAuthorization({
                    entryXdr: signedEntryXdr,
                    user: sub.customer_wallet_address,
                    merchant: merchant.wallet_address,
                });
                const outcome = await relayer.relayPull({
                    merchantId: sub.plans.merchant_id,
                    entry,
                    user: sub.customer_wallet_address,
                    merchant: merchant.wallet_address,
                    onSubmitted: async ({ txHash }) => {
                        transactionHash = txHash;
                        await store.saveTransactionHash(claim, txHash);
                    },
                    confirm: async (server, txHash) => {
                        transactionHash = txHash;
                        confirmation = await waitForTransaction(txHash, {
                            timeoutMs: opts.transactionTimeoutMs,
                            intervalMs: opts.transactionPollIntervalMs,
                        });
                        return confirmation;
                    },
                });
                transactionHash = outcome.txHash;
                if (!confirmation) confirmation = { status: outcome.status };
            }

            if (confirmation.status === 'SUCCESS') {
                await finishSuccess({ sub, claim, transactionHash, confirmation });
                logger.info('recurring_pull.settled', {
                    subscription_id: sub.id,
                    billing_cycle: claim.billingCycle,
                    transaction_hash: transactionHash,
                });
                return { status: 'settled', transactionHash };
            }

            if (confirmation.status === 'NOT_FOUND') {
                throw Object.assign(new Error('Transaction confirmation timed out; preserving transaction hash for polling'), {
                    code: 'rpc_timeout',
                });
            }

            if (confirmation.status === 'FAILED') {
                const error = 'Soroban transaction failed on-chain';
                await store.failCycle(claim, { error, transactionHash });
                try {
                    await fail({ sub, merchant, transactionHash, error, confirmation });
                } catch (failureError) {
                    logger.error('recurring_pull.failure_settlement_error', {
                        subscription_id: sub.id,
                        transaction_hash: transactionHash,
                        error: failureError.message,
                    });
                }
                logger.warn('recurring_pull.failed_on_chain', { subscription_id: sub.id, transaction_hash: transactionHash });
                return { status: 'failed', transactionHash };
            }

            throw new Error(`Unexpected Soroban transaction status: ${confirmation.status}`);
        } catch (error) {
            if (isTransientPullError(error) && claim.attemptCount < opts.maxAttempts) {
                const nextRetryAt = new Date(now().getTime() + retryDelayMs(claim.attemptCount));
                await store.retryCycle(claim, {
                    nextRetryAt,
                    error: error.message,
                    transactionHash,
                });
                logger.warn('recurring_pull.retry_scheduled', {
                    subscription_id: sub.id,
                    attempt: claim.attemptCount,
                    next_retry_at: nextRetryAt.toISOString(),
                    error: error.message,
                });
                return { status: 'retry', nextRetryAt };
            }

            await store.failCycle(claim, { error: error.message, transactionHash });
            try {
                await fail({ sub, merchant, transactionHash, error: error.message });
            } catch (failureError) {
                logger.error('recurring_pull.failure_settlement_error', {
                    subscription_id: sub.id,
                    transaction_hash: transactionHash,
                    error: failureError.message,
                });
            }
            logger.error('recurring_pull.permanent_failure', {
                subscription_id: sub.id,
                attempt: claim.attemptCount,
                transaction_hash: transactionHash,
                error: error.message,
            });
            return { status: 'failed', error: error.message };
        }
    };

    const runOnce = async () => {
        const dueAt = now();
        const subscriptions = [];
        for (let offset = 0; ; offset += opts.pageSize) {
            const page = await store.listDueSubscriptions({ now: dueAt, limit: opts.pageSize, offset });
            subscriptions.push(...page);
            if (page.length < opts.pageSize) break;
        }
        const results = [];
        for (const sub of subscriptions) {
            try {
                results.push(await processSubscription(sub));
            } catch (error) {
                logger.error('recurring_pull.subscription_error', {
                    subscription_id: sub.id,
                    error: error.message,
                });
                results.push({ status: 'error', error: error.message });
            }
        }
        return results;
    };

    return { runOnce };
};

const startRecurringPullWorker = (worker, { intervalMs = DEFAULTS.intervalMs, logger = jsonLogger } = {}) => {
    let stopped = false;
    let timer = null;
    let current = null;

    const tick = async () => {
        current = worker.runOnce();
        try {
            await current;
        } catch (error) {
            logger.error('recurring_pull.worker_error', { error: error.message });
        } finally {
            current = null;
            if (!stopped) {
                timer = setTimeout(tick, intervalMs);
                if (typeof timer.unref === 'function') timer.unref();
            }
        }
    };
    tick();

    return {
        async stop() {
            stopped = true;
            clearTimeout(timer);
            await current;
        },
    };
};

module.exports = {
    DEFAULT_RETRY_DELAYS_MS,
    createRemoteMerchantSigner,
    createSupabaseStore,
    createRecurringPullWorker,
    startRecurringPullWorker,
    isTransientPullError,
    retryDelayMs,
    vaultIdFor,
};
