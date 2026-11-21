'use strict';

const crypto = require('crypto');
const { dispatchWebhookEvent } = require('./webhooks');
const { sendWithResend, renderMarkdown } = require('./notification-templates');

const DISPUTE_CONFIRMATION_MAX_LATENCY_MS = 5000;

function formatDisputeAlertEmail({
    eventType,
    contractId,
    escrowId,
    disputedBalance,
    actorAddress,
    resolutionUrl,
    role,
    recipientAddress,
}) {
    const isOpened = eventType === 'esc_disp' || eventType === 'dispute.opened';
    const actionTitle = isOpened ? 'Dispute Opened' : 'Dispute Resolved';
    const statusColor = isOpened ? '#dc2626' : '#16a34a';

    const subject = `[Orbit Alert] Escrow ${actionTitle}: Contract ${contractId} (#${escrowId})`;

    const markdown = [
        `### Escrow ${actionTitle}`,
        ``,
        `Hello **${role}** (${recipientAddress || 'Authorized Party'}),`,
        ``,
        isOpened
            ? `An on-chain dispute has been officially registered for milestone escrow **#${escrowId}**.`
            : `The milestone escrow dispute for **#${escrowId}** has reached resolution / auto-release timeout.`,
        ``,
        `**Dispute Details:**`,
        `- **Contract ID:** \`${contractId}\``,
        `- **Escrow ID:** \`${escrowId}\``,
        `- **Disputed Balance:** **${disputedBalance} USDC**`,
        `- **Initiating Actor:** \`${actorAddress}\``,
        `- **Status:** **${isOpened ? 'OPENED' : 'RESOLVED'}**`,
        ``,
        `Please review the case details and submit evidence or complete settlement via the direct resolution interface below:`,
        ``,
        `[Go to Dispute Resolution](${resolutionUrl})`,
        ``,
        `Direct Link: ${resolutionUrl}`,
    ].join('\n');

    const html = `
<div style="font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;color:#18181b;">
  <div style="display:flex;align-items:center;margin-bottom:16px;">
    <span style="display:inline-block;padding:4px 10px;border-radius:9999px;font-size:12px;font-weight:700;background:${isOpened ? '#fee2e2' : '#dcfce7'};color:${statusColor};">
      ${isOpened ? 'ACTION REQUIRED' : 'RESOLVED'}
    </span>
  </div>
  <h2 style="margin:0 0 12px 0;font-size:20px;font-weight:700;color:#09090b;">
    ${actionTitle}: Escrow #${escrowId}
  </h2>
  <p style="margin:0 0 16px 0;font-size:14px;line-height:1.5;color:#52525b;">
    Notice for <strong>${role}</strong>: An on-chain milestone escrow milestone event was confirmed by Stellar Soroban ledger stream.
  </p>
  <div style="background:#f4f4f5;border-radius:8px;padding:16px;margin-bottom:20px;">
    <table style="width:100%;font-size:13px;border-collapse:collapse;">
      <tr>
        <td style="padding:4px 0;color:#71717a;">Contract ID:</td>
        <td style="padding:4px 0;font-family:monospace;font-weight:600;color:#09090b;text-align:right;">${contractId}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#71717a;">Disputed Balance:</td>
        <td style="padding:4px 0;font-weight:700;color:#09090b;text-align:right;">${disputedBalance} USDC</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#71717a;">Actor Address:</td>
        <td style="padding:4px 0;font-family:monospace;font-size:12px;color:#09090b;text-align:right;">${actorAddress}</td>
      </tr>
    </table>
  </div>
  <div style="text-align:center;margin-top:24px;">
    <a href="${resolutionUrl}" style="display:inline-block;background:#09090b;color:#ffffff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;text-decoration:none;">
      Access Dispute Resolution Interface
    </a>
  </div>
  <p style="margin-top:20px;font-size:11px;color:#a1a1aa;text-align:center;word-break:break-all;">
    Direct link: <a href="${resolutionUrl}" style="color:#71717a;">${resolutionUrl}</a>
  </p>
</div>
`;

    return { subject, markdown, html };
}

function createDisputeAlertProcessor({
    supabase,
    dispatchWebhook = dispatchWebhookEvent,
    sendEmail = null,
    fetchImpl = globalThis.fetch,
    frontendUrl = process.env.FRONTEND_URL || 'https://useorbit.xyz',
    logger = console,
    maxConfirmationLatencyMs = DISPUTE_CONFIRMATION_MAX_LATENCY_MS,
} = {}) {
    async function dispatchAlertEmail({
        recipient,
        role,
        contractId,
        escrowId,
        disputedBalance,
        actorAddress,
        resolutionUrl,
        eventType,
    }) {
        if (!recipient || !recipient.email) return null;

        const emailContent = formatDisputeAlertEmail({
            eventType,
            contractId,
            escrowId,
            disputedBalance,
            actorAddress,
            resolutionUrl,
            role,
            recipientAddress: recipient.walletAddress || recipient.name || '',
        });

        if (sendEmail) {
            return await sendEmail({
                to: recipient.email,
                role,
                ...emailContent,
                contractId,
                escrowId,
                disputedBalance,
                resolutionUrl,
            });
        }

        if (process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM_EMAIL) {
            return await sendWithResend({
                fetchImpl,
                apiKey: process.env.RESEND_API_KEY,
                from: process.env.NOTIFICATION_FROM_EMAIL,
                to: recipient.email,
                subject: emailContent.subject,
                html: emailContent.html,
            });
        }

        logger.info?.(`[Dispute Alert Email Mock] Sent to ${recipient.email} (${role}): ${emailContent.subject}`);
        return `mock_email_${crypto.randomUUID()}`;
    }

    async function recordDisputeAudit({
        contractId,
        escrowId,
        merchantId,
        employerAddress,
        contractorAddress,
        arbiterAddress,
        actorAddress,
        eventType,
        status,
        disputedBalance,
        disputedBalanceUnits,
        ledgerSequence,
        transactionHash,
        resolutionUrl,
    }) {
        if (!supabase) return null;

        const timestamp = new Date().toISOString();
        const action = eventType === 'esc_disp' ? 'dispute_opened' : 'dispute_resolved';
        const timelineItem = {
            action,
            actor_address: actorAddress,
            ledger_sequence: ledgerSequence,
            transaction_hash: transactionHash,
            status,
            timestamp,
        };

        const { data: existing, error: selectErr } = await supabase
            .from('escrow_disputes')
            .select('*')
            .eq('contract_id', contractId)
            .eq('escrow_id', escrowId)
            .maybeSingle();

        if (selectErr) {
            logger.error?.('Error fetching existing dispute:', selectErr);
        }

        if (existing) {
            const updatedTimeline = Array.isArray(existing.timeline)
                ? [...existing.timeline, timelineItem]
                : [timelineItem];

            const { data: updated, error: updateErr } = await supabase
                .from('escrow_disputes')
                .update({
                    status,
                    event_type: eventType,
                    actor_address: actorAddress,
                    disputed_balance: disputedBalance,
                    disputed_balance_units: disputedBalanceUnits,
                    ledger_sequence: ledgerSequence,
                    transaction_hash: transactionHash,
                    resolution_url: resolutionUrl,
                    timeline: updatedTimeline,
                    updated_at: timestamp,
                })
                .eq('id', existing.id)
                .select()
                .single();

            if (updateErr) throw updateErr;
            return updated;
        }

        const { data: inserted, error: insertErr } = await supabase
            .from('escrow_disputes')
            .insert([
                {
                    contract_id: contractId,
                    escrow_id: escrowId,
                    merchant_id: merchantId,
                    employer_address: employerAddress,
                    contractor_address: contractorAddress,
                    arbiter_address: arbiterAddress,
                    actor_address: actorAddress,
                    event_type: eventType,
                    status,
                    disputed_balance: disputedBalance,
                    disputed_balance_units: disputedBalanceUnits,
                    ledger_sequence: ledgerSequence,
                    transaction_hash: transactionHash,
                    resolution_url: resolutionUrl,
                    timeline: [timelineItem],
                },
            ])
            .select()
            .single();

        if (insertErr) throw insertErr;
        return inserted;
    }

    async function ingestDisputeEvent(event, context = {}) {
        const startTime = Date.now();

        // Topic extraction supporting both Soroban raw and normalized events
        const topics = Array.isArray(event.topics) ? event.topics : Array.isArray(event.topic) ? event.topic : [];
        const rawEventName = String(topics[0] || event.event_name || event.name || '');

        if (!['esc_disp', 'esc_tout'].includes(rawEventName)) {
            return null; // Not a dispute milestone event
        }

        const contractId = String(event.contract_id || event.contractId || context.contractId || '');
        const escrowId = String(topics[1] ?? event.escrow_id ?? event.escrowId ?? context.escrowId ?? '0');
        const actorAddress = String(topics[2] ?? event.actor_address ?? event.caller ?? context.actorAddress ?? '');
        const ledgerSequence = Number(event.ledger_sequence || event.ledger || context.ledgerSequence || 0);
        const transactionHash = String(event.transaction_hash || event.txHash || context.txHash || '');
        const closedAtStr = event.closed_at || event.ledgerClosedAt || context.closedAt;

        // Disputed balance parsing
        let rawUnits = 0n;
        try {
            if (event.value !== undefined && event.value !== null) {
                rawUnits = typeof event.value === 'bigint' ? event.value : BigInt(String(event.value).replace(/n$/, ''));
            } else if (context.amountUnits) {
                rawUnits = BigInt(context.amountUnits);
            }
        } catch {
            rawUnits = 0n;
        }

        const disputedBalance = context.amountUsdc !== undefined
            ? String(context.amountUsdc)
            : (Number(rawUnits) / 10_000_000).toFixed(2);

        const isOpened = rawEventName === 'esc_disp';
        const webhookEventType = isOpened ? 'dispute.opened' : 'dispute.resolved';
        const disputeStatus = isOpened ? 'opened' : 'resolved';

        // Check 5-second ledger confirmation acceptance criteria
        const closedTimestamp = closedAtStr ? Date.parse(closedAtStr) : Date.now();
        const confirmationDelayMs = Math.max(0, Date.now() - closedTimestamp);
        const withinConfirmationWindow = confirmationDelayMs <= maxConfirmationLatencyMs;

        // Direct resolution URL
        const cleanBaseUrl = (context.frontendUrl || frontendUrl).replace(/\/$/, '');
        const resolutionUrl = `${cleanBaseUrl}/dashboard?view=payroll&dispute=${encodeURIComponent(escrowId)}&contract=${encodeURIComponent(contractId)}`;

        // Parties identification
        const employer = context.employer || {
            address: context.employerAddress,
            email: context.employerEmail,
        };
        const contractor = context.contractor || {
            address: context.contractorAddress,
            email: context.contractorEmail,
        };
        const arbiter = context.arbiter || {
            address: context.arbiterAddress,
            email: context.arbiterEmail,
        };

        // 1. Audit log into escrow_disputes table
        let disputeRecord = null;
        try {
            disputeRecord = await recordDisputeAudit({
                contractId,
                escrowId,
                merchantId: context.merchantId || null,
                employerAddress: employer.address || null,
                contractorAddress: contractor.address || null,
                arbiterAddress: arbiter.address || null,
                actorAddress,
                eventType: rawEventName,
                status: disputeStatus,
                disputedBalance: Number(disputedBalance),
                disputedBalanceUnits: Number(rawUnits),
                ledgerSequence,
                transactionHash,
                resolutionUrl,
            });
        } catch (auditErr) {
            logger.error?.('Failed to record dispute audit log:', auditErr);
        }

        // 2. Webhook Event Dispatch (dispute.opened or dispute.resolved)
        const webhookPayload = {
            event: webhookEventType,
            contract_id: contractId,
            escrow_id: escrowId,
            disputed_balance: disputedBalance,
            disputed_balance_units: rawUnits.toString(),
            actor_address: actorAddress,
            employer_address: employer.address,
            contractor_address: contractor.address,
            arbiter_address: arbiter.address,
            ledger_sequence: ledgerSequence,
            transaction_hash: transactionHash,
            status: disputeStatus,
            resolution_url: resolutionUrl,
            confirmed_at: closedAtStr || new Date().toISOString(),
        };

        let webhookDeliveries = [];
        if (context.merchantId && supabase) {
            try {
                webhookDeliveries = await dispatchWebhook(supabase, {
                    merchantId: context.merchantId,
                    eventType: webhookEventType,
                    payload: webhookPayload,
                    fetchImpl,
                });
            } catch (whErr) {
                logger.error?.('Error dispatching dispute webhook:', whErr);
            }
        }

        // 3. Email Notification Engine to Employer, Contractor, Arbiter
        const emailRecipients = [
            { recipient: employer, role: 'Employer' },
            { recipient: contractor, role: 'Contractor' },
            { recipient: arbiter, role: 'Assigned Arbiter' },
        ].filter((item) => item.recipient && item.recipient.email);

        const emailPromises = emailRecipients.map(({ recipient, role }) =>
            dispatchAlertEmail({
                recipient,
                role,
                contractId,
                escrowId,
                disputedBalance,
                actorAddress,
                resolutionUrl,
                eventType: rawEventName,
            })
        );

        const emailResults = await Promise.allSettled(emailPromises);
        const emailDispatches = emailResults.map((r, i) => ({
            recipient: emailRecipients[i].recipient.email,
            role: emailRecipients[i].role,
            status: r.status === 'fulfilled' ? 'sent' : 'failed',
            id: r.status === 'fulfilled' ? r.value : null,
            error: r.status === 'rejected' ? r.reason?.message : null,
        }));

        const totalElapsedMs = Date.now() - startTime;

        return {
            processed: true,
            eventType: rawEventName,
            webhookEventType,
            status: disputeStatus,
            contractId,
            escrowId,
            disputedBalance,
            resolutionUrl,
            withinConfirmationWindow,
            confirmationDelayMs,
            totalElapsedMs,
            disputeRecord,
            webhookDeliveries,
            emailDispatches,
        };
    }

    return {
        ingestDisputeEvent,
        recordDisputeAudit,
        formatDisputeAlertEmail,
    };
}

module.exports = {
    DISPUTE_CONFIRMATION_MAX_LATENCY_MS,
    createDisputeAlertProcessor,
    formatDisputeAlertEmail,
};
