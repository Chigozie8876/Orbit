import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    createDisputeAlertProcessor,
    formatDisputeAlertEmail,
    DISPUTE_CONFIRMATION_MAX_LATENCY_MS,
} from '../dispute-alert-processor.js';
import { verifyTimestampedSignature } from '../webhooks.js';

describe('Dispute Alert Processor & Notification Engine', () => {
    let mockSupabase;
    let mockDisputeRows;
    let mockWebhooks;
    let deliveredWebhooks;
    let sentEmails;

    beforeEach(() => {
        mockDisputeRows = [];
        mockWebhooks = [
            {
                id: 'wh_test_1',
                merchant_id: 'merchant_123',
                url: 'https://merchant.example.com/webhooks',
                signing_secret: 'whsec_test_secret_key_1234567890abcdef',
                events: ['*'],
                active: true,
            },
        ];
        deliveredWebhooks = [];
        sentEmails = [];

        mockSupabase = {
            from: vi.fn((table) => {
                if (table === 'webhooks') {
                    return {
                        select: vi.fn(() => ({
                            eq: vi.fn((col, val) => ({
                                eq: vi.fn(() => ({
                                    data: mockWebhooks.filter(w => w.merchant_id === val && w.active),
                                    error: null,
                                })),
                            })),
                        })),
                    };
                }
                if (table === 'webhook_deliveries') {
                    return {
                        insert: vi.fn((records) => ({
                            select: vi.fn(() => ({
                                single: vi.fn(() => ({
                                    data: records[0],
                                    error: null,
                                })),
                            })),
                        })),
                    };
                }
                if (table === 'escrow_disputes') {
                    return {
                        select: vi.fn(() => ({
                            eq: vi.fn((col1, val1) => ({
                                eq: vi.fn((col2, val2) => ({
                                    maybeSingle: vi.fn(async () => {
                                        const match = mockDisputeRows.find(
                                            (r) => r.contract_id === val1 && r.escrow_id === val2
                                        );
                                        return { data: match || null, error: null };
                                    }),
                                })),
                            })),
                        })),
                        insert: vi.fn((rows) => {
                            const row = { id: `disp_${mockDisputeRows.length + 1}`, ...rows[0] };
                            mockDisputeRows.push(row);
                            return {
                                select: vi.fn(() => ({
                                    single: vi.fn(async () => ({ data: row, error: null })),
                                })),
                            };
                        }),
                        update: vi.fn((updates) => ({
                            eq: vi.fn((col, val) => {
                                const index = mockDisputeRows.findIndex((r) => r.id === val);
                                if (index >= 0) {
                                    mockDisputeRows[index] = { ...mockDisputeRows[index], ...updates };
                                }
                                return {
                                    select: vi.fn(() => ({
                                        single: vi.fn(async () => ({ data: mockDisputeRows[index], error: null })),
                                    })),
                                };
                            }),
                        })),
                    };
                }
                return {
                    select: vi.fn(() => ({ eq: vi.fn(() => ({ data: [], error: null })) })),
                };
            }),
        };
    });

    it('formats dispute alert email containing contract ID, disputed balance, and direct resolution URL', () => {
        const email = formatDisputeAlertEmail({
            eventType: 'esc_disp',
            contractId: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
            escrowId: '42',
            disputedBalance: '1500.00',
            actorAddress: 'GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A',
            resolutionUrl: 'https://useorbit.xyz/dashboard?view=payroll&dispute=42&contract=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
            role: 'Assigned Arbiter',
            recipientAddress: 'GAJ7J66Q66THHJ22WTBBEJUHHLVD7RZZW6KTVQDBBQYXRPVC4UFFQFDR',
        });

        expect(email.subject).toContain('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75');
        expect(email.subject).toContain('#42');
        expect(email.markdown).toContain('**1500.00 USDC**');
        expect(email.markdown).toContain('`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`');
        expect(email.markdown).toContain('https://useorbit.xyz/dashboard?view=payroll&dispute=42&contract=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75');
        expect(email.html).toContain('1500.00 USDC');
        expect(email.html).toContain('Access Dispute Resolution Interface');
    });

    it('ingests esc_disp event, logs to escrow_disputes, dispatches dispute.opened webhook and sends 3 party emails', async () => {
        const customFetch = vi.fn(async (url, opts) => {
            deliveredWebhooks.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
            return {
                ok: true,
                status: 200,
                text: async () => '{"received":true}',
            };
        });

        const customEmailSender = vi.fn(async (data) => {
            sentEmails.push(data);
            return `msg_${sentEmails.length}`;
        });

        const processor = createDisputeAlertProcessor({
            supabase: mockSupabase,
            sendEmail: customEmailSender,
            fetchImpl: customFetch,
            frontendUrl: 'https://useorbit.xyz',
        });

        const onChainDisputeEvent = {
            id: 'evt_disp_01',
            topics: [
                'esc_disp',
                '42',
                'GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG',
            ],
            value: 15_000_000_000n, // 1,500 USDC (7 decimals)
            contract_id: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
            ledger_sequence: 1234567,
            transaction_hash: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
            closed_at: new Date().toISOString(),
        };

        const result = await processor.ingestDisputeEvent(onChainDisputeEvent, {
            merchantId: 'merchant_123',
            employer: {
                address: 'GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG',
                email: 'employer@dao.xyz',
            },
            contractor: {
                address: 'GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A',
                email: 'contractor@freelance.org',
            },
            arbiter: {
                address: 'GAJ7J66Q66THHJ22WTBBEJUHHLVD7RZZW6KTVQDBBQYXRPVC4UFFQFDR',
                email: 'arbiter@lexpunx.eth',
            },
        });

        expect(result.processed).toBe(true);
        expect(result.webhookEventType).toBe('dispute.opened');
        expect(result.status).toBe('opened');
        expect(result.disputedBalance).toBe('1500.00');
        expect(result.withinConfirmationWindow).toBe(true);
        expect(result.totalElapsedMs).toBeLessThan(DISPUTE_CONFIRMATION_MAX_LATENCY_MS);

        // Verify audit log entry in escrow_disputes
        expect(mockDisputeRows).toHaveLength(1);
        const dispute = mockDisputeRows[0];
        expect(dispute.contract_id).toBe('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75');
        expect(dispute.escrow_id).toBe('42');
        expect(dispute.status).toBe('opened');
        expect(dispute.event_type).toBe('esc_disp');
        expect(dispute.actor_address).toBe('GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG');
        expect(dispute.timeline).toHaveLength(1);
        expect(dispute.timeline[0].action).toBe('dispute_opened');
        expect(dispute.timeline[0].ledger_sequence).toBe(1234567);

        // Verify Webhook Delivery & HMAC signature
        expect(deliveredWebhooks).toHaveLength(1);
        const delivery = deliveredWebhooks[0];
        expect(delivery.body.event).toBe('dispute.opened');
        expect(delivery.body.contract_id).toBe('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75');
        expect(delivery.body.disputed_balance).toBe('1500.00');
        expect(delivery.headers['X-Orbit-Event']).toBe('dispute.opened');
        expect(delivery.headers['X-Orbit-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

        // Verify HMAC signature validity using the webhook secret
        const isValidSignature = verifyTimestampedSignature(
            delivery.headers['X-Orbit-Signature'],
            JSON.stringify(delivery.body),
            mockWebhooks[0].signing_secret
        );
        expect(isValidSignature).toBe(true);

        // Verify 3 emails dispatched to employer, contractor, arbiter
        expect(sentEmails).toHaveLength(3);
        const roles = sentEmails.map((e) => e.role);
        expect(roles).toContain('Employer');
        expect(roles).toContain('Contractor');
        expect(roles).toContain('Assigned Arbiter');
        for (const sent of sentEmails) {
            expect(sent.contractId).toBe('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75');
            expect(sent.disputedBalance).toBe('1500.00');
            expect(sent.resolutionUrl).toContain('dispute=42');
        }
    });

    it('ingests esc_tout event and updates timeline to resolved with dispute.resolved webhook', async () => {
        const customFetch = vi.fn(async (url, opts) => {
            deliveredWebhooks.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
            return { ok: true, status: 200, text: async () => '{"ok":true}' };
        });

        const customEmailSender = vi.fn(async (data) => {
            sentEmails.push(data);
            return 'msg_resolved';
        });

        const processor = createDisputeAlertProcessor({
            supabase: mockSupabase,
            sendEmail: customEmailSender,
            fetchImpl: customFetch,
        });

        // 1. Initial Dispute Opened
        await processor.ingestDisputeEvent({
            topics: ['esc_disp', '99', 'G_CLAIMANT'],
            value: 20_000_000_000n,
            contract_id: 'C_CONTRACT_1',
            ledger_sequence: 100,
        }, {
            merchantId: 'merchant_123',
            employer: { email: 'boss@corp.com' },
        });

        expect(mockDisputeRows[0].status).toBe('opened');

        // 2. Timeout triggered (esc_tout)
        const timeoutEvent = {
            topics: ['esc_tout', '99', 'G_CLAIMANT'],
            value: 20_000_000_000n,
            contract_id: 'C_CONTRACT_1',
            ledger_sequence: 180,
            transaction_hash: 'tx_timeout_hash',
        };

        const result = await processor.ingestDisputeEvent(timeoutEvent, {
            merchantId: 'merchant_123',
            employer: { email: 'boss@corp.com' },
            contractor: { email: 'worker@corp.com' },
        });

        expect(result.processed).toBe(true);
        expect(result.webhookEventType).toBe('dispute.resolved');
        expect(result.status).toBe('resolved');

        // Timeline updated
        const updatedDispute = mockDisputeRows[0];
        expect(updatedDispute.status).toBe('resolved');
        expect(updatedDispute.timeline).toHaveLength(2);
        expect(updatedDispute.timeline[1].action).toBe('dispute_resolved');
        expect(updatedDispute.timeline[1].ledger_sequence).toBe(180);

        // Webhook dispatched with dispute.resolved
        const lastWebhook = deliveredWebhooks[deliveredWebhooks.length - 1];
        expect(lastWebhook.body.event).toBe('dispute.resolved');
    });

    it('ignores non-dispute events gracefully', async () => {
        const processor = createDisputeAlertProcessor({ supabase: mockSupabase });
        const result = await processor.ingestDisputeEvent({
            topics: ['batch_disbursed', '123'],
        });
        expect(result).toBeNull();
    });
});
