'use strict';

// One-click "Send Balance Reminder" for at-risk subscribers (#298).
//
// POST /subscriptions/:id/balance-reminder emails the subscriber, at the address they gave
// at checkout (metadata.customer_email), a link to top up their wallet or renew their
// allowance before the next pull fails. The merchant must own the subscription. Reminders
// are limited to one per subscription per cooldown window so a dashboard cannot be used to
// spam a customer.
const { z } = require('zod');
const { renderMarkdown, sendWithResend } = require('./notification-templates');
const { generateRecoveryLink } = require('./dunning');

const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const SUBJECT = 'Action needed: keep your {{plan_name}} subscription active';
const MARKDOWN = [
    'Hello,',
    '',
    'Your next **{{plan_name}}** payment of **{{amount}}** is coming up, and the wallet',
    '`{{customer_wallet}}` may not have enough USDC, or enough approved allowance, to cover it.',
    '',
    'Top up your wallet or renew your allowance so the payment goes through:',
    '[Review my subscription]({{portal_link}})',
    '',
    'If you have already topped up, you can ignore this message.',
].join('\n');

const idSchema = z.string().uuid();
const emailSchema = z.string().trim().email().max(254);

const formatUsdc = (raw) => `${(Number(raw ?? 0) / 10_000_000).toFixed(2)} USDC`;

/** `jane@example.com` -> `j***@example.com`, so the response never echoes the full address. */
const maskEmail = (email) => {
    const [local, domain] = email.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
};

const fill = (template, variables) => template.replace(/\{\{([a-z_]+)\}\}/g, (_, name) => String(variables[name] ?? ''));

function registerBalanceReminderRoutes(app, { getSupabase, authenticateMerchant, cooldownMs = REMINDER_COOLDOWN_MS }) {
    app.post('/subscriptions/:id/balance-reminder', authenticateMerchant, async (req, res) => {
        if (!idSchema.safeParse(req.params.id).success) {
            return res.status(400).json({ error: 'subscription id must be a valid UUID', code: 'invalid_request' });
        }
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

        try {
            const { data: sub, error } = await supabase
                .from('subscriptions')
                .select('id, plan_id, status, customer_wallet_address, metadata, plans!inner(merchant_id, name, usdc_amount)')
                .eq('id', req.params.id)
                .maybeSingle();
            if (error) throw error;
            // A subscription of another merchant is reported as missing, not forbidden
            if (!sub || sub.plans?.merchant_id !== req.merchant.id) {
                return res.status(404).json({ error: 'Subscription not found', code: 'not_found' });
            }
            if (sub.status === 'cancelled') {
                return res.status(409).json({ error: 'The subscription is cancelled', code: 'subscription_cancelled' });
            }

            const metadata = sub.metadata || {};
            const email = emailSchema.safeParse(metadata.customer_email);
            if (!email.success) {
                return res.status(409).json({ error: 'No customer email is on file for this subscription', code: 'no_contact_email' });
            }

            const now = Date.now();
            const lastSent = Date.parse(metadata.last_balance_reminder_at ?? '');
            if (!Number.isNaN(lastSent) && now - lastSent < cooldownMs) {
                const retryAfterSeconds = Math.ceil((lastSent + cooldownMs - now) / 1000);
                res.set('Retry-After', String(retryAfterSeconds));
                return res.status(429).json({
                    error: 'A balance reminder was already sent recently',
                    code: 'reminder_cooldown',
                    next_allowed_at: new Date(lastSent + cooldownMs).toISOString(),
                });
            }

            if (!process.env.RESEND_API_KEY || !process.env.NOTIFICATION_FROM_EMAIL) {
                return res.status(503).json({ error: 'Email delivery is not configured', code: 'email_unavailable' });
            }

            const recovery = generateRecoveryLink(sub.id, { planId: sub.plan_id });
            const variables = {
                plan_name: sub.plans?.name || 'subscription',
                amount: formatUsdc(sub.plans?.usdc_amount),
                customer_wallet: sub.customer_wallet_address,
                portal_link: `${recovery.recovery_url}&action=topup`,
            };
            const providerMessageId = await sendWithResend({
                fetchImpl: app.locals.fetchImpl || globalThis.fetch,
                apiKey: process.env.RESEND_API_KEY,
                from: process.env.NOTIFICATION_FROM_EMAIL,
                to: email.data,
                subject: fill(SUBJECT, variables),
                html: renderMarkdown(MARKDOWN, variables),
            });

            const sentAt = new Date(now).toISOString();
            const { error: updateError } = await supabase
                .from('subscriptions')
                .update({ metadata: { ...metadata, last_balance_reminder_at: sentAt } })
                .eq('id', sub.id);
            if (updateError) console.warn(`Could not record balance reminder for ${sub.id}:`, updateError.message);

            return res.status(202).json({
                sent: true,
                recipient: maskEmail(email.data),
                provider_message_id: providerMessageId,
                sent_at: sentAt,
                next_allowed_at: new Date(now + cooldownMs).toISOString(),
            });
        } catch (err) {
            console.error('Error sending balance reminder:', err);
            return res.status(502).json({ error: 'The reminder email could not be sent', code: 'email_failed' });
        }
    });
}

module.exports = { REMINDER_COOLDOWN_MS, maskEmail, registerBalanceReminderRoutes };
