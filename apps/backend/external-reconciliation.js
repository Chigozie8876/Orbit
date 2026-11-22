'use strict';

const crypto = require('node:crypto');
const { verifyStripeSignature, StripeSignatureError } = require('./stripe-billing');

class ShopifySignatureError extends Error {}

/**
 * Verifies Shopify HMAC-SHA256 signature from `x-shopify-hmac-sha256` header.
 * Shopify computes HMAC-SHA256 of the raw body keyed by the secret and encodes it in base64.
 */
function verifyShopifySignature({ payload, header, secret }) {
    if (!secret) {
        throw new ShopifySignatureError('Shopify webhook secret is not configured');
    }
    if (typeof header !== 'string' || !header) {
        throw new ShopifySignatureError('Missing x-shopify-hmac-sha256 header');
    }
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');

    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const headerBuf = Buffer.from(header.trim(), 'utf8');

    if (expectedBuf.length !== headerBuf.length || !crypto.timingSafeEqual(expectedBuf, headerBuf)) {
        throw new ShopifySignatureError('Invalid Shopify webhook signature');
    }

    let parsed;
    try {
        parsed = JSON.parse(body.toString('utf8'));
    } catch {
        throw new ShopifySignatureError('Shopify payload is not valid JSON');
    }
    return parsed;
}

/**
 * Creates a valid base64 Shopify signature for tests.
 */
function signShopifyPayload(payload, secret) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
    return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

/**
 * Unified Status State Machine: maps external platform status to unified Orbit subscription status.
 * Allowed statuses in Orbit: 'active', 'past_due', 'cancelled'.
 */
function mapStripeStatusToOrbit(eventType, object = {}) {
    if (eventType === 'customer.subscription.deleted') {
        return 'cancelled';
    }
    if (eventType === 'invoice.paid') {
        return 'active';
    }
    if (eventType === 'invoice.payment_failed') {
        return 'past_due';
    }

    const rawStatus = String(object.status || '').toLowerCase();
    switch (rawStatus) {
        case 'active':
        case 'trialing':
            return 'active';
        case 'past_due':
        case 'unpaid':
        case 'incomplete':
        case 'incomplete_expired':
            return 'past_due';
        case 'canceled':
        case 'cancelled':
        case 'uncollectible':
            return 'cancelled';
        default:
            return 'active';
    }
}

function mapShopifyStatusToOrbit(topic, order = {}) {
    const rawTopic = String(topic || '').toLowerCase();
    if (rawTopic.includes('cancel') || order.cancelled_at) {
        return 'cancelled';
    }

    const financialStatus = String(order.financial_status || '').toLowerCase();
    if (rawTopic === 'orders/paid' || rawTopic === 'orders/fulfilled' || financialStatus === 'paid') {
        return 'active';
    }
    if (financialStatus === 'refunded' || financialStatus === 'voided') {
        return 'cancelled';
    }
    if (financialStatus === 'pending' || financialStatus === 'partially_paid') {
        return 'past_due';
    }

    return 'active';
}

/**
 * Subscriber Mapping:
 * Links Stripe customer IDs and Shopify order IDs to Orbit subscriber records
 * via customer email or external metadata ID.
 */
async function findMatchingSubscriber(supabase, { externalId, email, stripeCustomerId, shopifyOrderId }) {
    const { data: allSubs, error } = await supabase
        .from('subscriptions')
        .select('id, plan_id, customer_wallet_address, status, metadata, created_at');

    if (error) throw error;
    if (!allSubs || allSubs.length === 0) return null;

    const normalizedEmail = email ? String(email).trim().toLowerCase() : null;

    // 1. Direct external metadata ID or subscription ID match
    if (externalId) {
        const direct = allSubs.find((s) => s.id === externalId || s.metadata?.external_id === externalId || s.metadata?.orbit_subscription_id === externalId);
        if (direct) return { subscriber: direct, matchedBy: 'external_id' };
    }

    // 2. Customer Email match
    if (normalizedEmail) {
        const byEmail = allSubs.find((s) => {
            const subEmail = s.metadata?.email || s.metadata?.customer_email;
            return subEmail && String(subEmail).trim().toLowerCase() === normalizedEmail;
        });
        if (byEmail) return { subscriber: byEmail, matchedBy: 'email' };
    }

    // 3. Platform-specific customer/order ID match
    if (stripeCustomerId) {
        const byStripe = allSubs.find((s) => s.metadata?.stripe_customer_id === stripeCustomerId);
        if (byStripe) return { subscriber: byStripe, matchedBy: 'stripe_customer_id' };
    }

    if (shopifyOrderId) {
        const byShopify = allSubs.find((s) => s.metadata?.shopify_order_id === String(shopifyOrderId));
        if (byShopify) return { subscriber: byShopify, matchedBy: 'shopify_order_id' };
    }

    return null;
}

/**
 * Executes idempotent reconciliation for an external event.
 */
async function reconcileExternalBilling(supabase, {
    platform,
    eventId,
    eventType,
    externalCustomerId,
    externalOrderId,
    customerEmail,
    externalMetadataId,
    targetStatus,
    payload,
}) {
    // 1. Idempotency check via billing_reconciliations audit table
    const { data: existing, error: checkError } = await supabase
        .from('billing_reconciliations')
        .select('*')
        .eq('platform', platform)
        .eq('event_id', eventId)
        .maybeSingle();

    if (checkError) throw checkError;
    if (existing) {
        return {
            status: 'duplicate',
            event_id: eventId,
            platform,
            message: 'Event was already reconciled',
        };
    }

    // 2. Find matching Orbit subscriber
    const match = await findMatchingSubscriber(supabase, {
        externalId: externalMetadataId,
        email: customerEmail,
        stripeCustomerId: externalCustomerId,
        shopifyOrderId: externalOrderId,
    });

    let statusBefore = null;
    let subscriptionId = null;

    if (match?.subscriber) {
        const sub = match.subscriber;
        subscriptionId = sub.id;
        statusBefore = sub.status;

        const updatedMetadata = {
            ...(sub.metadata || {}),
            last_reconciled_at: new Date().toISOString(),
            last_reconciled_platform: platform,
            last_reconciled_event_id: eventId,
        };

        if (platform === 'stripe' && externalCustomerId) {
            updatedMetadata.stripe_customer_id = externalCustomerId;
        }
        if (platform === 'shopify' && externalOrderId) {
            updatedMetadata.shopify_order_id = String(externalOrderId);
        }

        // Apply state transition idempotently
        const { error: updateError } = await supabase
            .from('subscriptions')
            .update({
                status: targetStatus,
                metadata: updatedMetadata,
            })
            .eq('id', sub.id);

        if (updateError) throw updateError;
    }

    // 3. Record unified billing event in billing_reconciliations table
    const auditRecord = {
        id: crypto.randomUUID(),
        subscription_id: subscriptionId,
        platform,
        event_id: eventId,
        event_type: eventType,
        external_customer_id: externalCustomerId || null,
        external_order_id: externalOrderId || null,
        customer_email: customerEmail || null,
        status_before: statusBefore,
        status_after: targetStatus,
        reconciled_at: new Date().toISOString(),
        payload: payload || {},
        metadata: {
            matched_by: match?.matchedBy || 'unmatched',
        },
    };

    const { error: insertError } = await supabase
        .from('billing_reconciliations')
        .insert([auditRecord]);

    if (insertError && insertError.code !== '23505') throw insertError;

    return {
        status: 'reconciled',
        event_id: eventId,
        platform,
        subscription_id: subscriptionId,
        status_before: statusBefore,
        status_after: targetStatus,
        matched: Boolean(subscriptionId),
    };
}

/**
 * Registers external integration webhook endpoints:
 * POST /api/integrations/stripe
 * POST /api/integrations/shopify
 */
function registerExternalReconciliationRoutes(app, getSupabase) {
    const getStripeSecret = () =>
        app.locals.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;

    const getShopifySecret = () =>
        app.locals.shopifyWebhookSecret ?? process.env.SHOPIFY_WEBHOOK_SECRET;

    // 1. Stripe integration endpoint
    app.post('/api/integrations/stripe', async (req, res) => {
        const secret = getStripeSecret();
        if (!secret) {
            return res.status(503).json({ error: 'Stripe webhook secret is not configured' });
        }

        let event;
        try {
            event = verifyStripeSignature({
                payload: req.rawBody ?? Buffer.from(JSON.stringify(req.body || {})),
                header: req.get('stripe-signature'),
                secrets: secret,
            });
        } catch (err) {
            if (err instanceof StripeSignatureError) {
                return res.status(400).json({ error: err.message });
            }
            return res.status(400).json({ error: 'Invalid Stripe signature' });
        }

        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Database not initialized' });

        try {
            const object = event.data?.object || {};
            const isInvoice = event.type.startsWith('invoice.');
            const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id;
            const customerEmail = object.customer_email || object.billing_details?.email || object.metadata?.email;
            const externalMetadataId = object.metadata?.orbit_subscription_id || object.metadata?.external_id || object.metadata?.orbit_merchant_id;
            const targetStatus = mapStripeStatusToOrbit(event.type, object);

            const result = await reconcileExternalBilling(supabase, {
                platform: 'stripe',
                eventId: event.id,
                eventType: event.type,
                externalCustomerId: customerId,
                externalOrderId: isInvoice ? object.id : null,
                customerEmail,
                externalMetadataId,
                targetStatus,
                payload: event,
            });

            return res.status(200).json({ received: true, ...result });
        } catch (err) {
            console.error('Error reconciling Stripe webhook:', err);
            return res.status(500).json({ error: 'Failed to reconcile Stripe event' });
        }
    });

    // 2. Shopify integration endpoint
    app.post('/api/integrations/shopify', async (req, res) => {
        const secret = getShopifySecret();
        if (!secret) {
            return res.status(503).json({ error: 'Shopify webhook secret is not configured' });
        }

        let payload;
        try {
            payload = verifyShopifySignature({
                payload: req.rawBody ?? Buffer.from(JSON.stringify(req.body || {})),
                header: req.get('x-shopify-hmac-sha256'),
                secret,
            });
        } catch (err) {
            if (err instanceof ShopifySignatureError) {
                return res.status(400).json({ error: err.message });
            }
            return res.status(400).json({ error: 'Invalid Shopify signature' });
        }

        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Database not initialized' });

        try {
            const topic = req.get('x-shopify-topic') || payload.topic || 'orders/paid';
            const eventId = req.get('x-shopify-webhook-id') || `shopify_${payload.id || Date.now()}`;
            const customerId = payload.customer?.id ? String(payload.customer.id) : null;
            const customerEmail = payload.email || payload.customer?.email || payload.contact_email;
            const orderId = payload.id ? String(payload.id) : null;

            // Search attributes for external metadata ID
            const noteAttributes = payload.note_attributes || [];
            const metaAttr = noteAttributes.find((a) => a.name === 'orbit_subscription_id' || a.name === 'external_id');
            const externalMetadataId = metaAttr?.value || null;

            const targetStatus = mapShopifyStatusToOrbit(topic, payload);

            const result = await reconcileExternalBilling(supabase, {
                platform: 'shopify',
                eventId,
                eventType: topic,
                externalCustomerId: customerId,
                externalOrderId: orderId,
                customerEmail,
                externalMetadataId,
                targetStatus,
                payload,
            });

            return res.status(200).json({ received: true, ...result });
        } catch (err) {
            console.error('Error reconciling Shopify webhook:', err);
            return res.status(500).json({ error: 'Failed to reconcile Shopify event' });
        }
    });
}

module.exports = {
    ShopifySignatureError,
    verifyShopifySignature,
    signShopifyPayload,
    mapStripeStatusToOrbit,
    mapShopifyStatusToOrbit,
    findMatchingSubscriber,
    reconcileExternalBilling,
    registerExternalReconciliationRoutes,
};
