import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { createFakeSupabase } from './fakeSupabase.js';
import { makeApiKey } from './helpers.js';
import { REMINDER_COOLDOWN_MS, maskEmail } from '../balance-reminders.js';

const MERCHANT_ID = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
const OTHER_MERCHANT_ID = '1a2b3c4d-1111-4222-8333-444455556666';
const SUB_ID = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';
const WALLET = 'GBOBZ7M5W8Y2K6T1R9P0V4N8D2L7C3F9A1H5J8K2';

const subscription = (overrides = {}) => ({
  id: SUB_ID,
  plan_id: 'b1c2d3e4-0000-4000-8000-000000000001',
  status: 'active',
  customer_wallet_address: WALLET,
  metadata: { customer_email: 'jane@example.com' },
  plans: { merchant_id: MERCHANT_ID, name: 'MailKit Pro', usdc_amount: 290_000_000 },
  ...overrides,
});

describe('POST /subscriptions/:id/balance-reminder (#298)', () => {
  let apiKey;
  let db;
  let fetchImpl;

  const send = (id = SUB_ID) =>
    request(app).post(`/subscriptions/${id}/balance-reminder`).set('Authorization', apiKey.header).send({});

  const seed = (sub = subscription()) => {
    db = createFakeSupabase({ api_keys: [apiKey.row], subscriptions: [sub] });
    app.locals.supabase = db;
  };

  beforeEach(() => {
    apiKey = makeApiKey({ merchantId: MERCHANT_ID, walletAddress: 'GMERCHANT' });
    seed();
    fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'msg_123' }) }));
    app.locals.fetchImpl = fetchImpl;
    process.env.RESEND_API_KEY = 're_test';
    process.env.NOTIFICATION_FROM_EMAIL = 'billing@orbit.test';
    for (const limiter of Object.values(app.locals.rateLimiters)) limiter.reset();
  });

  afterEach(() => {
    delete app.locals.supabase;
    delete app.locals.fetchImpl;
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFICATION_FROM_EMAIL;
  });

  it('emails the subscriber a top-up link and records when it was sent', async () => {
    const res = await send();

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ sent: true, recipient: 'j***@example.com', provider_message_id: 'msg_123' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(['jane@example.com']);
    expect(body.from).toBe('billing@orbit.test');
    expect(body.subject).toBe('Action needed: keep your MailKit Pro subscription active');
    expect(body.html).toContain('29.00 USDC');
    expect(body.html).toContain(WALLET);
    expect(body.html).toContain('action=topup');

    const stored = db.tables.subscriptions[0].metadata;
    expect(stored.customer_email).toBe('jane@example.com');
    expect(Date.parse(stored.last_balance_reminder_at)).not.toBeNaN();
  });

  it('refuses a second reminder inside the cooldown window', async () => {
    seed(subscription({ metadata: { customer_email: 'jane@example.com', last_balance_reminder_at: new Date().toISOString() } }));
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('reminder_cooldown');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows another reminder once the cooldown has passed', async () => {
    const old = new Date(Date.now() - REMINDER_COOLDOWN_MS - 1000).toISOString();
    seed(subscription({ metadata: { customer_email: 'jane@example.com', last_balance_reminder_at: old } }));
    expect((await send()).status).toBe(202);
  });

  it('reports a subscription with no customer email on file', async () => {
    seed(subscription({ metadata: {} }));
    const res = await send();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_contact_email');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not send to a malformed stored address', async () => {
    seed(subscription({ metadata: { customer_email: 'not-an-email' } }));
    expect((await send()).body.code).toBe('no_contact_email');
  });

  it("hides another merchant's subscription", async () => {
    seed(subscription({ plans: { merchant_id: OTHER_MERCHANT_ID, name: 'X', usdc_amount: 1 } }));
    const res = await send();
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses cancelled subscriptions', async () => {
    seed(subscription({ status: 'cancelled' }));
    expect((await send()).body.code).toBe('subscription_cancelled');
  });

  it('returns 503 when email delivery is not configured', async () => {
    delete process.env.RESEND_API_KEY;
    const res = await send();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('email_unavailable');
  });

  it('returns 502 and records nothing when the mail provider fails', async () => {
    fetchImpl.mockResolvedValue({ ok: false, status: 500, json: async () => ({ message: 'down' }) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await send();
    error.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('email_failed');
    expect(db.tables.subscriptions[0].metadata.last_balance_reminder_at).toBeUndefined();
  });

  it('validates the subscription id and requires an API key', async () => {
    expect((await send('not-a-uuid')).status).toBe(400);
    expect((await request(app).post(`/subscriptions/${SUB_ID}/balance-reminder`).send({})).status).toBe(401);
  });

  it('masks addresses in responses', () => {
    expect(maskEmail('jane@example.com')).toBe('j***@example.com');
  });
});
