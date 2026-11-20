import { describe, expect, it, vi } from 'vitest';
import { createEmailDispatcher, renderReceiptHtml, sendSettlementReceipt } from '../receipt-email.js';

describe('receipt email delivery', () => {
  const base = {
    invoice: { invoice_number: 'ORB-123' },
    payment: { amount_usdc_units: '10000000', tx_hash: 'abc123', settled_at: '2026-11-20T12:00:00Z' },
    merchant: { name: 'Acme' },
    plan: { name: 'Pro' },
    subscription: { metadata: { email: 'buyer@example.com', tax: { label: 'VAT', amount: '0.5 USDC' } } },
    pdf: Buffer.from('%PDF-test'),
  };

  it('renders tax, transaction and explorer details', () => {
    const html = renderReceiptHtml({
      merchantName:'Acme', invoiceNumber:'ORB-123', planName:'Pro', amountUsdcUnits:'10000000',
      txHash:'abc123', settledAt:'2026-11-20T12:00:00Z', tax:{ label:'VAT', amount:'0.5 USDC' },
    });
    expect(html).toContain('1 USDC');
    expect(html).toContain('VAT');
    expect(html).toContain('abc123');
    expect(html).toContain('stellar.expert');
  });

  it('dispatches through Resend with a PDF attachment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const dispatcher = createEmailDispatcher({ env: { RESEND_API_KEY:'key', RECEIPT_FROM_EMAIL:'receipts@example.com' }, fetchImpl });
    const result = await sendSettlementReceipt({ ...base, dispatcher });
    expect(result.provider).toBe('resend');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.to).toEqual(['buyer@example.com']);
    expect(body.attachments[0].filename).toBe('ORB-123.pdf');
  });

  it('logs delivery failures instead of throwing into settlement', async () => {
    const logger = { error: vi.fn() };
    const dispatcher = { send: vi.fn().mockRejectedValue(new Error('mail down')) };
    const result = await sendSettlementReceipt({ ...base, dispatcher, logger });
    expect(result.error).toBeInstanceOf(Error);
    expect(logger.error).toHaveBeenCalled();
  });
});