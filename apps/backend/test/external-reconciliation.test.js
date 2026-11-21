import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import {
    verifyShopifySignature,
    signShopifyPayload,
    ShopifySignatureError,
    mapStripeStatusToOrbit,
    mapShopifyStatusToOrbit,
    findMatchingSubscriber,
} from '../external-reconciliation.js';
import { signStripePayload } from '../stripe-billing.js';
import { createFakeSupabase } from './fakeSupabase.js';

const STRIPE_SECRET = 'whsec_test_stripe_secret_123';
const SHOPIFY_SECRET = 'shpss_test_shopify_secret_456';
const subId1 = 'a1111111-b222-c333-d444-e55555555555';
const subId2 = 'a2222222-b222-c333-d444-e55555555555';

let db;

beforeEach(() => {
    db = createFakeSupabase({
        subscriptions: [
            {
                id: subId1,
                plan_id: 'plan_1',
                customer_wallet_address: 'GUSER1111111111111111111111111111111111111111111111111111',
                status: 'active',
                metadata: {
                    email: 'alice@example.com',
                    external_id: 'ext_sub_alice',
                },
                created_at: new Date().toISOString(),
            },
            {
                id: subId2,
                plan_id: 'plan_2',
                customer_wallet_address: 'GUSER2222222222222222222222222222222222222222222222222222',
                status: 'past_due',
                metadata: {
                    email: 'bob@example.com',
                },
                created_at: new Date().toISOString(),
            },
        ],
        billing_reconciliations: [],
    }, {
        unique: {
            billing_reconciliations: [['platform', 'event_id']],
        },
    });

    app.locals.supabase = db;
    app.locals.stripeWebhookSecret = STRIPE_SECRET;
    app.locals.shopifyWebhookSecret = SHOPIFY_SECRET;
    app.locals.rateLimiters.ip.reset();
});

afterAll(() => {
    delete app.locals.stripeWebhookSecret;
    delete app.locals.shopifyWebhookSecret;
    delete app.locals.supabase;
});

describe('Shopify Signature Verification', () => {
    const payload = JSON.stringify({ id: 1001, email: 'bob@example.com', financial_status: 'paid' });

    it('accepts a valid HMAC-SHA256 signature', () => {
        const signature = signShopifyPayload(payload, SHOPIFY_SECRET);
        const parsed = verifyShopifySignature({
            payload,
            header: signature,
            secret: SHOPIFY_SECRET,
        });
        expect(parsed.id).toBe(1001);
    });

    it('rejects an invalid or tampered signature', () => {
        const signature = signShopifyPayload(payload, SHOPIFY_SECRET);
        expect(() =>
            verifyShopifySignature({
                payload: payload.replace('1001', '9999'),
                header: signature,
                secret: SHOPIFY_SECRET,
            })
        ).toThrow(ShopifySignatureError);
    });

    it('rejects when secret is missing or header is missing', () => {
        expect(() =>
            verifyShopifySignature({ payload, header: 'abc', secret: '' })
        ).toThrow(/not configured/);

        expect(() =>
            verifyShopifySignature({ payload, header: '', secret: SHOPIFY_SECRET })
        ).toThrow(/Missing/);
    });
});

describe('Unified Status State Machine & Mapping', () => {
    it('correctly maps Stripe subscription statuses', () => {
        expect(mapStripeStatusToOrbit('customer.subscription.updated', { status: 'active' })).toBe('active');
        expect(mapStripeStatusToOrbit('customer.subscription.updated', { status: 'past_due' })).toBe('past_due');
        expect(mapStripeStatusToOrbit('customer.subscription.deleted', { status: 'canceled' })).toBe('cancelled');
        expect(mapStripeStatusToOrbit('invoice.paid', {})).toBe('active');
        expect(mapStripeStatusToOrbit('invoice.payment_failed', {})).toBe('past_due');
    });

    it('correctly maps Shopify order financial statuses', () => {
        expect(mapShopifyStatusToOrbit('orders/paid', { financial_status: 'paid' })).toBe('active');
        expect(mapShopifyStatusToOrbit('orders/partially_paid', { financial_status: 'partially_paid' })).toBe('past_due');
        expect(mapShopifyStatusToOrbit('orders/cancelled', { cancelled_at: '2026-11-21T00:00:00Z' })).toBe('cancelled');
        expect(mapShopifyStatusToOrbit('orders/updated', { financial_status: 'refunded' })).toBe('cancelled');
    });

    it('maps subscriber records via email and external ID', async () => {
        const matchByEmail = await findMatchingSubscriber(db, { email: 'alice@example.com' });
        expect(matchByEmail?.subscriber.id).toBe(subId1);
        expect(matchByEmail?.matchedBy).toBe('email');

        const matchByExt = await findMatchingSubscriber(db, { externalId: 'ext_sub_alice' });
        expect(matchByExt?.subscriber.id).toBe(subId1);
        expect(matchByExt?.matchedBy).toBe('external_id');
    });
});

describe('POST /api/integrations/stripe', () => {
    it('verifies signature and reconciles Stripe subscription update to Orbit status', async () => {
        const event = {
            id: 'evt_stripe_reconcile_1',
            type: 'customer.subscription.updated',
            data: {
                object: {
                    id: 'sub_stripe_1',
                    customer: 'cus_alice_stripe',
                    status: 'past_due',
                    metadata: {
                        email: 'alice@example.com',
                    },
                },
            },
        };
        const body = JSON.stringify(event);
        const header = signStripePayload(body, STRIPE_SECRET);

        const res = await request(app)
            .post('/api/integrations/stripe')
            .set('Content-Type', 'application/json')
            .set('stripe-signature', header)
            .send(body);

        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
        expect(res.body.status).toBe('reconciled');
        expect(res.body.subscription_id).toBe(subId1);
        expect(res.body.status_after).toBe('past_due');

        // Verify local subscriber record was updated
        const updatedSub = db.tables.subscriptions.find((s) => s.id === subId1);
        expect(updatedSub.status).toBe('past_due');
        expect(updatedSub.metadata.stripe_customer_id).toBe('cus_alice_stripe');

        // Verify audit table entry
        expect(db.tables.billing_reconciliations.length).toBe(1);
        const audit = db.tables.billing_reconciliations[0];
        expect(audit.platform).toBe('stripe');
        expect(audit.event_id).toBe('evt_stripe_reconcile_1');
        expect(audit.subscription_id).toBe(subId1);
        expect(audit.status_after).toBe('past_due');
    });

    it('processes duplicate Stripe webhooks idempotently without duplicate audit rows', async () => {
        const event = {
            id: 'evt_stripe_duplicate',
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    id: 'sub_stripe_2',
                    customer: 'cus_alice_stripe',
                    metadata: { email: 'alice@example.com' },
                },
            },
        };
        const body = JSON.stringify(event);
        const header = signStripePayload(body, STRIPE_SECRET);

        // First delivery
        const res1 = await request(app)
            .post('/api/integrations/stripe')
            .set('Content-Type', 'application/json')
            .set('stripe-signature', header)
            .send(body);
        expect(res1.status).toBe(200);
        expect(res1.body.status).toBe('reconciled');

        // Duplicate delivery
        const res2 = await request(app)
            .post('/api/integrations/stripe')
            .set('Content-Type', 'application/json')
            .set('stripe-signature', header)
            .send(body);
        expect(res2.status).toBe(200);
        expect(res2.body.status).toBe('duplicate');
        expect(db.tables.billing_reconciliations.length).toBe(1);
    });

    it('rejects Stripe webhook when cryptographic signature is invalid', async () => {
        const body = JSON.stringify({ id: 'evt_bad', type: 'invoice.paid' });
        const res = await request(app)
            .post('/api/integrations/stripe')
            .set('Content-Type', 'application/json')
            .set('stripe-signature', 't=123,v1=bad_signature')
            .send(body);

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });
});

describe('POST /api/integrations/shopify', () => {
    it('verifies Shopify HMAC signature and reconciles paid order to active status', async () => {
        const payload = {
            id: 888123456,
            email: 'bob@example.com',
            financial_status: 'paid',
            customer: { id: 777123, email: 'bob@example.com' },
            note_attributes: [],
        };
        const body = JSON.stringify(payload);
        const signature = signShopifyPayload(body, SHOPIFY_SECRET);

        const res = await request(app)
            .post('/api/integrations/shopify')
            .set('Content-Type', 'application/json')
            .set('x-shopify-hmac-sha256', signature)
            .set('x-shopify-topic', 'orders/paid')
            .set('x-shopify-webhook-id', 'wh_shopify_order_1')
            .send(body);

        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
        expect(res.body.status).toBe('reconciled');
        expect(res.body.subscription_id).toBe(subId2);
        expect(res.body.status_after).toBe('active');

        // Verify Bob's subscription updated from past_due to active
        const updatedSub = db.tables.subscriptions.find((s) => s.id === subId2);
        expect(updatedSub.status).toBe('active');
        expect(updatedSub.metadata.shopify_order_id).toBe('888123456');

        // Verify audit record
        const audit = db.tables.billing_reconciliations.find((r) => r.event_id === 'wh_shopify_order_1');
        expect(audit).toBeDefined();
        expect(audit.platform).toBe('shopify');
        expect(audit.external_order_id).toBe('888123456');
        expect(audit.status_after).toBe('active');
    });

    it('rejects Shopify webhook when cryptographic signature does not match', async () => {
        const body = JSON.stringify({ id: 999 });
        const res = await request(app)
            .post('/api/integrations/shopify')
            .set('Content-Type', 'application/json')
            .set('x-shopify-hmac-sha256', 'aW52YWxpZF9zaWduYXR1cmU=')
            .send(body);

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('signature');
    });
});
