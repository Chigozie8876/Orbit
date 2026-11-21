import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RETRY_DELAYS_MS,
  createRecurringPullWorker,
  createRemoteMerchantSigner,
  isTransientPullError,
  vaultIdFor,
} from '../recurring-pulls.js';

const USER = 'G'.padEnd(56, 'A');
const MERCHANT = 'G'.padEnd(56, 'B');
const CONTRACT = 'C'.padEnd(56, 'A');
const DUE = '2026-11-19T12:00:00.000Z';

const subscription = {
  id: 'subscription-1',
  plan_id: 'plan-1',
  customer_wallet_address: USER,
  next_billing_date: DUE,
  plans: {
    merchant_id: 'merchant-1',
    interval_seconds: 3600,
    merchants: { id: 'merchant-1', wallet_address: MERCHANT },
  },
};

const createStore = (overrides = {}) => ({
  listDueSubscriptions: vi.fn(async () => [subscription]),
  claimCycle: vi.fn(async () => ({ claimed: true, attemptCount: 1, transactionHash: null })),
  saveTransactionHash: vi.fn(async () => {}),
  retryCycle: vi.fn(async () => {}),
  settleCycle: vi.fn(async () => {}),
  failCycle: vi.fn(async () => {}),
  ...overrides,
});

const createRelayer = (overrides = {}) => ({
  preparePullAuthorization: vi.fn(async () => ({ authEntryXdr: 'unsigned-entry', validUntilLedger: 900 })),
  verifyPullAuthorization: vi.fn(async () => 'verified-entry'),
  relayPull: vi.fn(async ({ onSubmitted, confirm }) => {
    const txHash = 'tx-hash';
    await onSubmitted?.({ txHash, attempts: 1 });
    const confirmation = await confirm({}, txHash);
    return { status: confirmation.status, txHash, attempts: 1 };
  }),
  ...overrides,
});

const buildWorker = (overrides = {}) => {
  const store = overrides.store ?? createStore();
  const relayer = overrides.relayer ?? createRelayer();
  const signer = overrides.signer ?? { signPullAuthorization: vi.fn(async () => 'signed-entry') };
  const settle = overrides.settle ?? vi.fn(async () => {});
  const fail = overrides.fail ?? vi.fn(async () => {});
  const worker = createRecurringPullWorker({
    store,
    relayer,
    signer,
    contractId: CONTRACT,
    networkPassphrase: 'test-network',
    waitForTransaction: overrides.waitForTransaction ?? vi.fn(async () => ({ status: 'SUCCESS', ledger: 42 })),
    settle,
    fail,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date(DUE),
    options: { transactionTimeoutMs: 1, transactionPollIntervalMs: 1 },
  });
  return { worker, store, relayer, signer, settle, fail };
};

describe('automated recurring pull worker', () => {
  it('claims a vault billing cycle and settles only after SUCCESS confirmation', async () => {
    const { worker, store, relayer, signer, settle } = buildWorker();
    const result = await worker.runOnce();

    expect(store.claimCycle).toHaveBeenCalledWith(expect.objectContaining({
      vaultId: vaultIdFor(USER, MERCHANT),
      billingCycle: DUE,
      subscriptionId: subscription.id,
    }));
    expect(signer.signPullAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      authEntryXdr: 'unsigned-entry',
      contractId: CONTRACT,
      validUntilLedger: 900,
    }));
    expect(relayer.verifyPullAuthorization).toHaveBeenCalledWith({
      entryXdr: 'signed-entry',
      user: USER,
      merchant: MERCHANT,
    });
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash: 'tx-hash',
      confirmation: expect.objectContaining({ status: 'SUCCESS' }),
    }));
    expect(store.settleCycle).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: expect.any(String) }),
      expect.objectContaining({ transactionHash: 'tx-hash' }),
    );
    expect(result[0].status).toBe('settled');
  });

  it('does not attempt duplicate work when the atomic billing-cycle claim is held', async () => {
    const store = createStore({
      claimCycle: vi.fn(async () => ({ claimed: false, attemptCount: 0, transactionHash: null })),
    });
    const { worker, relayer, settle } = buildWorker({ store });

    const result = await worker.runOnce();

    expect(result[0].status).toBe('locked');
    expect(relayer.preparePullAuthorization).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('schedules transient failures using the configured exponential retry sequence', async () => {
    const store = createStore();
    const relayer = createRelayer({
      preparePullAuthorization: vi.fn(async () => {
        throw Object.assign(new Error('RPC gateway timeout'), { status: 504 });
      }),
    });
    const { worker } = buildWorker({ store, relayer });

    const result = await worker.runOnce();

    expect(result[0].status).toBe('retry');
    expect(store.retryCycle).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        nextRetryAt: new Date(new Date(DUE).getTime() + DEFAULT_RETRY_DELAYS_MS[0]),
        transactionHash: null,
      }),
    );
    expect(store.failCycle).not.toHaveBeenCalled();
  });

  it('does not exceed the configured submission-attempt limit after a worker crash', async () => {
    const store = createStore({
      claimCycle: vi.fn(async () => ({ claimed: true, attemptCount: 5, transactionHash: null })),
    });
    const { worker, relayer } = buildWorker({ store });

    const result = await worker.runOnce();

    expect(result[0].status).toBe('failed');
    expect(relayer.preparePullAuthorization).not.toHaveBeenCalled();
    expect(store.failCycle).toHaveBeenCalled();
  });

  it('keeps an unconfirmed transaction hash and polls it on the next attempt', async () => {
    const store = createStore();
    const relayer = createRelayer({
      relayPull: vi.fn(async ({ onSubmitted, confirm }) => {
        await onSubmitted({ txHash: 'pending-hash' });
        const confirmation = await confirm({}, 'pending-hash');
        return { status: confirmation.status, txHash: 'pending-hash' };
      }),
    });
    const waitForTransaction = vi.fn(async () => ({ status: 'NOT_FOUND' }));
    const { worker } = buildWorker({ store, relayer, waitForTransaction });

    const result = await worker.runOnce();

    expect(result[0].status).toBe('retry');
    expect(store.saveTransactionHash).toHaveBeenCalledWith(expect.any(Object), 'pending-hash');
    expect(store.retryCycle).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ transactionHash: 'pending-hash' }),
    );
  });

  it('resumes confirmation polling without signing or submitting a second transaction', async () => {
    const store = createStore({
      claimCycle: vi.fn(async () => ({ claimed: true, attemptCount: 1, transactionHash: 'pending-hash' })),
    });
    const waitForTransaction = vi.fn(async () => ({ status: 'SUCCESS', ledger: 43 }));
    const { worker, relayer, settle } = buildWorker({ store, waitForTransaction });

    await worker.runOnce();

    expect(waitForTransaction).toHaveBeenCalledWith('pending-hash', expect.any(Object));
    expect(relayer.preparePullAuthorization).not.toHaveBeenCalled();
    expect(relayer.relayPull).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: 'pending-hash' }));
  });

  it('fails a cycle without marking it settled when the chain reports FAILED', async () => {
    const { worker, store, settle, fail } = buildWorker({
      waitForTransaction: vi.fn(async () => ({ status: 'FAILED' })),
    });

    await worker.runOnce();

    expect(store.failCycle).toHaveBeenCalled();
    expect(store.settleCycle).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalled();
  });
});

describe('recurring pull signer configuration', () => {
  it('requires an authenticated HTTPS signer endpoint', () => {
    expect(() => createRemoteMerchantSigner({ url: 'http://example.com/sign', token: 'secret' }))
      .toThrow('must use HTTPS');
  });

  it('sends only scoped authorization data and returns the signed entry', async () => {
    const fetchImpl = vi.fn(async (_url, request) => ({
      ok: true,
      json: async () => ({ signed_auth_entry_xdr: 'signed-xdr' }),
      request,
    }));
    const signer = createRemoteMerchantSigner({
      url: 'https://signer.example/sign',
      token: 'secret',
      fetchImpl,
    });

    const signed = await signer.signPullAuthorization({
      authEntryXdr: 'unsigned-xdr',
      user: USER,
      merchant: MERCHANT,
      contractId: CONTRACT,
      networkPassphrase: 'test-network',
      validUntilLedger: 900,
    });

    expect(signed).toBe('signed-xdr');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      action: 'sign_soroban_pull_authorization',
      auth_entry_xdr: 'unsigned-xdr',
      subscriber_address: USER,
      merchant_address: MERCHANT,
      contract_id: CONTRACT,
    });
  });

  it('recognizes transient RPC errors but not authorization failures', () => {
    expect(isTransientPullError({ status: 504 })).toBe(true);
    expect(isTransientPullError({ code: 'txBadSeq' })).toBe(true);
    expect(isTransientPullError({ status: 401 })).toBe(false);
  });
});
