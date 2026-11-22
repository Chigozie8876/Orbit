import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import app from '../index.js';

const require = createRequire(import.meta.url);
// Same CommonJS SDK copy as relayer.js, so XDR classes match its type checks
const {
  Keypair, StrKey, Account, Networks, Asset, Operation, TransactionBuilder, BASE_FEE, Contract,
  Address, nativeToScVal, FeeBumpTransaction, xdr,
} = require('@stellar/stellar-sdk');
const { createRelayer, createRelayerFromEnv } = require('../relayer.js');
const { createSponsorshipPolicy, validateSponsoredTransaction } = require('../sponsorship.js');

const ORBIT = StrKey.encodeContract(Buffer.alloc(32, 3));
const USDC = StrKey.encodeContract(Buffer.alloc(32, 9));
const OTHER_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 11));
const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 12));
const MERCHANT_ID = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';

const sponsor = Keypair.random();
const subscriber = Keypair.random();
const merchant = Keypair.random();
const stranger = Keypair.random();

const addr = (a) => new Address(a).toScVal();

const createVaultOp = ({ contract = ORBIT, fn = 'create_vault', user = subscriber.publicKey(), merchantKey = merchant.publicKey(), token = USDC } = {}) =>
  new Contract(contract).call(fn, addr(user), addr(merchantKey), addr(token),
    nativeToScVal(20_000_000n, { type: 'i128' }), nativeToScVal(2_592_000n, { type: 'u64' }));

const delegatedOp = ({ merchantKey = merchant.publicKey(), token = USDC } = {}) => {
  const authorization = xdr.ScVal.scvMap([
    ['amount', nativeToScVal(20_000_000n, { type: 'i128' })],
    ['expiry_ledger', nativeToScVal(900, { type: 'u32' })],
    ['interval_ledgers', nativeToScVal(17_280, { type: 'u32' })],
    ['merchant', addr(merchantKey)],
    ['nonce', nativeToScVal(0n, { type: 'u64' })],
    ['token', addr(token)],
    ['user', addr(subscriber.publicKey())],
  ].map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })));
  return new Contract(ORBIT).call('create_vault_delegated', authorization, xdr.ScVal.scvBytes(Buffer.alloc(64, 1)));
};

const approveOp = ({ token = USDC, spender = ORBIT, from = subscriber.publicKey() } = {}) =>
  new Contract(token).call('approve', addr(from), addr(spender),
    nativeToScVal(240_000_000n, { type: 'i128' }), nativeToScVal(700_000, { type: 'u32' }));

const buildTx = (ops, { source = subscriber, signer = source, networkPassphrase = Networks.TESTNET, fee = BASE_FEE } = {}) => {
  const builder = new TransactionBuilder(new Account(source.publicKey(), '41'), { fee, networkPassphrase });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(60).build();
  if (signer) tx.sign(signer);
  return tx;
};

const createMockServer = () => ({
  getAccount: vi.fn(async (publicKey) => new Account(publicKey, '100')),
  getLatestLedger: vi.fn().mockResolvedValue({ sequence: 500 }),
  prepareTransaction: vi.fn(async (tx) => tx),
  simulateTransaction: vi.fn().mockResolvedValue({ latestLedger: 500 }),
  sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'a'.repeat(64) })),
  getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', resultXdr: { feeCharged: 160n } }),
});

const createMemoryBudget = (dailyLimitStroops = 10_000_000) => {
  const budget = {
    dailyLimitStroops,
    used: 0,
    txCount: 0,
    reserve: vi.fn(async (_merchantId, amount) => {
      if (budget.used + amount > dailyLimitStroops) return null;
      budget.used += amount;
      return '2026-11-20';
    }),
    adjust: vi.fn(async (_merchantId, _date, feeDelta, txDelta) => {
      budget.used = Math.max(0, budget.used + feeDelta);
      budget.txCount += txDelta;
    }),
    usage: vi.fn(async () => ({ usageDate: '2026-11-20', feeStroops: budget.used, txCount: budget.txCount })),
  };
  return budget;
};

const policy = (overrides = {}) => createSponsorshipPolicy({
  orbitContractId: ORBIT,
  allowedTokenContracts: [USDC],
  allowedTrustlineAssets: [`USDC:${merchant.publicKey()}`],
  relayerAccounts: [sponsor.publicKey()],
  networkPassphrase: Networks.TESTNET,
  ...overrides,
});

// Supabase stub: merchants.wallet_address -> id for the one registered merchant
const merchantsSupabase = () => {
  let wallet;
  const query = {
    from: vi.fn(() => query),
    select: vi.fn(() => query),
    eq: vi.fn((column, value) => { if (column === 'wallet_address') wallet = value; return query; }),
    maybeSingle: vi.fn(async () => ({ data: wallet === merchant.publicKey() ? { id: MERCHANT_ID } : null, error: null })),
  };
  return query;
};

describe('POST /api/relayer/sponsor (#297)', () => {
  let server;
  let budget;

  const makeRelayer = ({ options = {}, feeEstimator = null, sponsorshipPolicy = policy() } = {}) => createRelayer({
    server,
    sponsor,
    contractId: ORBIT,
    networkPassphrase: Networks.TESTNET,
    budget,
    feeEstimator,
    sponsorshipPolicy,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    options: { retryDelayMs: 0, ...options },
  });

  beforeEach(() => {
    server = createMockServer();
    budget = createMemoryBudget();
    app.locals.supabase = merchantsSupabase();
    app.locals.relayer = makeRelayer();
    app.locals.txPollIntervalMs = 1;
    app.locals.txPollTimeoutMs = 20;
    for (const limiter of Object.values(app.locals.rateLimiters)) limiter.reset();
  });

  afterEach(() => {
    delete app.locals.relayer;
    delete app.locals.supabase;
    delete app.locals.txPollIntervalMs;
    delete app.locals.txPollTimeoutMs;
  });

  const sponsorTx = (tx, path = '/api/relayer/sponsor') =>
    request(app).post(path).send({ signed_tx_xdr: typeof tx === 'string' ? tx : tx.toXDR() });

  const expectNothingSpent = () => {
    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  };

  describe('sponsoring', () => {
    it('wraps the subscriber-signed transaction in a fee bump paid by the relayer and returns the hash', async () => {
      const inner = buildTx([createVaultOp()]);
      const res = await sponsorTx(inner);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'SUCCESS',
        tx_hash: 'a'.repeat(64),
        sponsored: true,
        sponsor_address: sponsor.publicKey(),
        fee_charged_stroops: 160,
      });

      const submitted = server.sendTransaction.mock.calls[0][0];
      expect(submitted).toBeInstanceOf(FeeBumpTransaction);
      expect(submitted.feeSource).toBe(sponsor.publicKey());
      // The subscriber's signed transaction is carried unchanged
      expect(Buffer.from(submitted.innerTransaction.hash()).equals(Buffer.from(inner.hash()))).toBe(true);
      expect(submitted.innerTransaction.source).toBe(subscriber.publicKey());
      const sponsorSig = submitted.signatures[0].signature;
      expect(sponsor.verify(submitted.hash(), typeof sponsorSig === 'function' ? sponsorSig() : sponsorSig)).toBe(true);
    });

    it('books the fee against the merchant, then settles it to the fee charged', async () => {
      await sponsorTx(buildTx([createVaultOp()]));
      expect(budget.reserve).toHaveBeenCalledWith(MERCHANT_ID, expect.any(Number));
      expect(budget.used).toBe(160);
      expect(budget.txCount).toBe(1);
    });

    it('sponsors a delegated authorization (create_vault_delegated, #296)', async () => {
      const res = await sponsorTx(buildTx([delegatedOp()]));
      expect(res.status).toBe(200);
    });

    it("sponsors the checkout widget's trustline + approve + create_vault batch", async () => {
      const ops = [
        Operation.changeTrust({ asset: new Asset('USDC', merchant.publicKey()) }),
        approveOp(),
        createVaultOp(),
      ];
      const res = await sponsorTx(buildTx(ops));
      expect(res.status).toBe(200);
    });

    it('accepts the legacy tx_xdr field', async () => {
      const res = await request(app).post('/api/relayer/sponsor').send({ tx_xdr: buildTx([createVaultOp()]).toXDR() });
      expect(res.status).toBe(200);
    });

    it('reports a transaction that failed on-chain', async () => {
      server.getTransaction.mockResolvedValue({ status: 'FAILED', resultXdr: { feeCharged: 150n } });
      const res = await sponsorTx(buildTx([createVaultOp()]));
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ status: 'FAILED', code: 'transaction_failed', tx_hash: 'a'.repeat(64) });
    });

    it('returns 202 PENDING when confirmation does not arrive in time', async () => {
      server.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });
      const res = await sponsorTx(buildTx([createVaultOp()]));
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: 'PENDING', tx_hash: 'a'.repeat(64) });
    });
  });

  describe('fee limits (relayer draining protection)', () => {
    it('refuses when the fee bump would exceed the per-transaction fee cap', async () => {
      app.locals.relayer = makeRelayer({ options: { maxFeeStroops: 150 } });
      const res = await sponsorTx(buildTx([createVaultOp()]));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('fee_cap_exceeded');
      expectNothingSpent();
    });

    it('never offers more than the base fee cap, however high the estimate', async () => {
      const feeEstimator = { estimate: vi.fn().mockResolvedValue(9_999_999) };
      app.locals.relayer = makeRelayer({ feeEstimator, options: { maxBaseFeeStroops: 500 } });
      const res = await sponsorTx(buildTx([createVaultOp()]));
      expect(res.status).toBe(200);
      const feeBump = server.sendTransaction.mock.calls[0][0];
      // One inner operation plus the fee bump itself, at the capped base fee
      expect(Number(feeBump.fee)).toBe(500 * 2);
    });

    it('ignores any fee the caller set on the inner transaction', async () => {
      const res = await sponsorTx(buildTx([createVaultOp()], { fee: '100' }));
      expect(res.status).toBe(200);
      expect(Number(server.sendTransaction.mock.calls[0][0].fee)).toBe(Number(BASE_FEE) * 2);
    });

    it("returns 429 with Retry-After once the merchant's daily budget is used up", async () => {
      budget = createMemoryBudget(10);
      app.locals.relayer = makeRelayer();
      const res = await sponsorTx(buildTx([createVaultOp()]));
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('daily_budget_exceeded');
      expect(res.headers['retry-after']).toBe('3600');
      expect(server.sendTransaction).not.toHaveBeenCalled();
    });

    it('never pays for a transaction that fails simulation', async () => {
      server.simulateTransaction.mockResolvedValue({ error: 'HostError: Error(Contract, #2)', latestLedger: 500 });
      const res = await sponsorTx(buildTx([createVaultOp()]));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('simulation_failed');
      expectNothingSpent();
    });

    it('refunds the booking when the network asks to retry later', async () => {
      server.sendTransaction.mockResolvedValue({ status: 'TRY_AGAIN_LATER', hash: 'b'.repeat(64) });
      const res = await sponsorTx(buildTx([createVaultOp()]));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('relayer_busy');
      expect(budget.used).toBe(0);
    });
  });

  describe('pre-flight policy', () => {
    const refused = async (tx, status, code) => {
      const res = await sponsorTx(tx);
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expectNothingSpent();
      return res;
    };

    it('refuses calls to contracts other than Orbit and the allowed tokens', () =>
      refused(buildTx([createVaultOp({ contract: OTHER_CONTRACT })]), 403, 'contract_not_allowed'));

    it('refuses Orbit functions that do not create a vault', () =>
      refused(buildTx([new Contract(ORBIT).call('withdraw_gas_subsidy', addr(merchant.publicKey()), nativeToScVal(1n, { type: 'i128' }))]),
        403, 'function_not_allowed'));

    it('refuses vaults in a token that is not allowed', () =>
      refused(buildTx([createVaultOp({ token: OTHER_TOKEN })]), 403, 'token_not_allowed'));

    it('refuses vaults for a merchant that is not registered with Orbit', () =>
      refused(buildTx([createVaultOp({ merchantKey: stranger.publicKey() })]), 403, 'recipient_not_allowed'));

    it('refuses token approvals that name a spender other than Orbit', () =>
      refused(buildTx([approveOp({ spender: stranger.publicKey() }), createVaultOp()]), 403, 'recipient_not_allowed'));

    it('refuses token calls other than approve', () =>
      refused(buildTx([new Contract(USDC).call('transfer', addr(subscriber.publicKey()), addr(stranger.publicKey()), nativeToScVal(5n, { type: 'i128' })), createVaultOp()]),
        403, 'function_not_allowed'));

    it('refuses plain payments, which would let anyone spend sponsored fees (#169 regression)', () =>
      refused(buildTx([Operation.payment({ destination: stranger.publicKey(), asset: Asset.native(), amount: '1' })]),
        403, 'operation_not_allowed'));

    it('refuses trustlines for assets that are not allowed', () =>
      refused(buildTx([Operation.changeTrust({ asset: new Asset('SCAM', stranger.publicKey()) }), createVaultOp()]),
        403, 'operation_not_allowed'));

    it('refuses transactions that do not create a vault at all', () =>
      refused(buildTx([approveOp()]), 403, 'operation_not_allowed'));

    it('refuses vaults for two different merchants in one transaction', async () => {
      app.locals.supabase = merchantsSupabase();
      await refused(buildTx([createVaultOp(), createVaultOp({ merchantKey: stranger.publicKey() })]), 403, 'recipient_not_allowed');
    });

    it('refuses an unsigned transaction', () =>
      refused(buildTx([createVaultOp()], { signer: null }), 401, 'unsigned_transaction'));

    it('refuses a transaction signed by someone other than its source', () =>
      refused(buildTx([createVaultOp()], { signer: stranger }), 401, 'unsigned_transaction'));

    it('refuses a transaction signed for another network', () =>
      refused(buildTx([createVaultOp()], { networkPassphrase: Networks.PUBLIC }), 401, 'unsigned_transaction'));

    it('refuses a transaction sourced from the relayer itself', () =>
      refused(buildTx([createVaultOp({ user: sponsor.publicKey() })], { source: sponsor }), 403, 'source_not_allowed'));

    it('refuses operations that override the source account', () => {
      const op = Operation.payment({ destination: stranger.publicKey(), asset: Asset.native(), amount: '1', source: sponsor.publicKey() });
      return refused(buildTx([createVaultOp(), op]), 403, 'source_not_allowed');
    });

    it('refuses a fee bump envelope', () => {
      const inner = buildTx([createVaultOp()]);
      const bump = TransactionBuilder.buildFeeBumpTransaction(stranger, BASE_FEE, inner, Networks.TESTNET);
      bump.sign(stranger);
      return refused(bump, 400, 'fee_bump_not_allowed');
    });

    it('refuses input that is not a transaction', () => refused('not-xdr', 400, 'invalid_transaction'));

    it('requires signed_tx_xdr', async () => {
      const res = await request(app).post('/api/relayer/sponsor').send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('refuses a declared network other than the relayer\'s', async () => {
      const res = await request(app).post('/api/relayer/sponsor')
        .send({ signed_tx_xdr: buildTx([createVaultOp()]).toXDR(), network_passphrase: Networks.PUBLIC });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('wrong_network');
      expectNothingSpent();
    });
  });

  describe('legacy /relay/sponsor-transaction (#169)', () => {
    it('now enforces the same policy instead of sponsoring anything', async () => {
      const payment = buildTx([Operation.payment({ destination: stranger.publicKey(), asset: Asset.native(), amount: '1' })]);
      const res = await request(app).post('/relay/sponsor-transaction')
        .send({ tx_xdr: payment.toXDR(), network_passphrase: Networks.TESTNET });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operation_not_allowed');
      expectNothingSpent();
    });

    it('still sponsors a valid checkout transaction', async () => {
      const res = await request(app).post('/relay/sponsor-transaction')
        .send({ tx_xdr: buildTx([approveOp(), createVaultOp()]).toXDR(), network_passphrase: Networks.TESTNET });
      expect(res.status).toBe(200);
      expect(res.body.tx_hash).toBe('a'.repeat(64));
    });
  });

  describe('availability and abuse limits', () => {
    it('returns 503 when no relayer is configured', async () => {
      delete app.locals.relayer;
      const saved = process.env.RELAYER_SECRET_KEY;
      delete process.env.RELAYER_SECRET_KEY;
      const res = await sponsorTx(buildTx([createVaultOp()]));
      if (saved !== undefined) process.env.RELAYER_SECRET_KEY = saved;
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('relayer_unavailable');
    });

    it('returns 503 when the relayer has no sponsorship policy', async () => {
      app.locals.relayer = makeRelayer({ sponsorshipPolicy: null });
      const res = await sponsorTx(buildTx([createVaultOp()]));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('sponsorship_unavailable');
    });

    it('throttles sponsorship requests per client IP', async () => {
      const statuses = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await sponsorTx(buildTx([createVaultOp()]))).status);
      }
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses[5]).toBe(429);
    });
  });
});

describe('sponsorship policy configuration', () => {
  it('requires a valid Orbit contract id and token contracts', () => {
    expect(() => createSponsorshipPolicy({ orbitContractId: 'nope' })).toThrow(/Orbit contract/);
    expect(() => createSponsorshipPolicy({ orbitContractId: ORBIT, allowedTokenContracts: ['GBAD'] })).toThrow(/token contract/);
  });

  it('refuses every vault when no token is allowed (fails closed)', () => {
    const tx = buildTx([createVaultOp()]);
    expect(() => validateSponsoredTransaction(tx, policy({ allowedTokenContracts: [] }))).toThrow(/not eligible/);
  });

  it('builds the policy from env, excluding the sponsor and channel accounts', () => {
    const channel = Keypair.random();
    const relayer = createRelayerFromEnv({
      server: createMockServer(),
      getSupabase: () => null,
      env: {
        RELAYER_SECRET_KEY: sponsor.secret(),
        RELAYER_CHANNEL_SECRET_KEYS: channel.secret(),
        ORBIT_CONTRACT_ID: ORBIT,
        USDC_CONTRACT_ID: USDC,
        RELAYER_MAX_BASE_FEE_STROOPS: '400',
      },
    });
    expect(relayer).not.toBeNull();
    const fromChannel = buildTx([createVaultOp({ user: channel.publicKey() })], { source: channel });
    const p = createSponsorshipPolicy({ orbitContractId: ORBIT, allowedTokenContracts: [USDC], relayerAccounts: [sponsor.publicKey(), channel.publicKey()] });
    expect(() => validateSponsoredTransaction(fromChannel, p)).toThrow(/relayer account/);
  });
});
