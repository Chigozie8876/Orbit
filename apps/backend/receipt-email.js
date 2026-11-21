const { explorerUrl, formatUsdc } = require('./invoices');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[ch]));

function renderReceiptHtml({ merchantName, invoiceNumber, planName, amountUsdcUnits, txHash, settledAt, tax = {} }) {
  const verify = explorerUrl(txHash);
  return '<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#171717">' +
    '<table role="presentation" width="100%"><tr><td align="center" style="padding:32px 16px">' +
    '<table role="presentation" width="600" style="max-width:600px;background:white;border:1px solid #e5e5e5;border-radius:12px"><tr><td style="padding:28px">' +
    '<div style="font-size:24px;font-weight:700">Orbit receipt</div>' +
    '<p style="color:#666">Payment received by ' + escapeHtml(merchantName) + '</p>' +
    '<table width="100%" cellpadding="8" style="border-collapse:collapse">' +
    '<tr><td>Invoice</td><td align="right"><b>' + escapeHtml(invoiceNumber) + '</b></td></tr>' +
    '<tr><td>Plan</td><td align="right">' + escapeHtml(planName) + '</td></tr>' +
    '<tr><td>Subtotal</td><td align="right">' + escapeHtml(formatUsdc(amountUsdcUnits)) + '</td></tr>' +
    '<tr><td>' + escapeHtml(tax.label || 'Tax') + '</td><td align="right">' + escapeHtml(tax.amount || '0 USDC') + '</td></tr>' +
    '<tr><td>Settled</td><td align="right">' + escapeHtml(new Date(settledAt).toISOString()) + '</td></tr></table>' +
    '<p style="word-break:break-all;font-size:12px;color:#666">Transaction: ' + escapeHtml(txHash) + '</p>' +
    '<p><a href="' + escapeHtml(verify) + '" style="color:#2563eb">Verify on Stellar Expert</a></p>' +
    '</td></tr></table></td></tr></table></body></html>';
}

function createEmailDispatcher({ env = process.env, fetchImpl = globalThis.fetch, smtpTransport, logger = console } = {}) {
  async function send({ to, subject, html, pdf, filename = 'orbit-invoice.pdf' }) {
    if (!to) return { skipped: true, reason: 'missing recipient email' };
    const base64 = pdf ? Buffer.from(pdf).toString('base64') : null;

    if (env.RESEND_API_KEY) {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.RECEIPT_FROM_EMAIL || env.NOTIFICATION_FROM_EMAIL || 'Orbit <receipts@orbit.invalid>',
          to: [to], subject, html,
          attachments: base64 ? [{ filename, content: base64 }] : [],
        }),
      });
      if (!response.ok) throw new Error('Resend delivery failed (' + response.status + ')');
      return { provider: 'resend' };
    }

    if (env.SENDGRID_API_KEY) {
      const response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: env.RECEIPT_FROM_EMAIL || 'receipts@orbit.invalid' },
          subject,
          content: [{ type: 'text/html', value: html }],
          attachments: base64 ? [{ content: base64, filename, type: 'application/pdf', disposition: 'attachment' }] : [],
        }),
      });
      if (!response.ok) throw new Error('SendGrid delivery failed (' + response.status + ')');
      return { provider: 'sendgrid' };
    }

    if (smtpTransport && typeof smtpTransport.sendMail === 'function') {
      await smtpTransport.sendMail({
        from: env.RECEIPT_FROM_EMAIL || env.NOTIFICATION_FROM_EMAIL,
        to, subject, html,
        attachments: pdf ? [{ filename, content: pdf, contentType: 'application/pdf' }] : [],
      });
      return { provider: 'smtp' };
    }

    logger.warn?.('Receipt email skipped: no provider configured');
    return { skipped: true, reason: 'no provider configured' };
  }
  return { send };
}

async function sendSettlementReceipt({ dispatcher, invoice, payment, merchant, plan, subscription, pdf, logger = console }) {
  const to = subscription?.metadata?.email || subscription?.customer_email || payment?.customer_email;
  if (!to) return { skipped: true, reason: 'missing recipient email' };
  const html = renderReceiptHtml({
    merchantName: merchant?.name || 'Merchant',
    invoiceNumber: invoice.invoice_number,
    planName: plan?.name || 'Subscription',
    amountUsdcUnits: payment.amount_usdc_units,
    txHash: payment.tx_hash,
    settledAt: payment.settled_at,
    tax: subscription?.metadata?.tax || {},
  });
  try {
    return await dispatcher.send({
      to,
      subject: 'Receipt ' + invoice.invoice_number + ' from ' + (merchant?.name || 'Orbit merchant'),
      html, pdf, filename: invoice.invoice_number + '.pdf',
    });
  } catch (error) {
    logger.error?.('Receipt email delivery failed:', error);
    return { error };
  }
}

module.exports = { renderReceiptHtml, createEmailDispatcher, sendSettlementReceipt };