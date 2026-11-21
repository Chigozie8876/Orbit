import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function verifyOrbitWebhookSignature(
  body: string,
  headers: Record<string, string | undefined>,
  secret: string,
  options: { toleranceSeconds?: number; nowSeconds?: number; seenNonce?: (nonce: string) => boolean } = {},
) {
  const timestamp = Number(headers['x-orbit-timestamp'] || headers['X-Orbit-Timestamp']);
  const nonce = headers['x-orbit-nonce'] || headers['X-Orbit-Nonce'] || '';
  const signature = headers['x-orbit-signature'] || headers['X-Orbit-Signature'] || '';
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) throw new Error('Webhook timestamp is outside the allowed tolerance');
  if (!/^[0-9a-f-]{36}$/i.test(nonce)) throw new Error('Webhook nonce is invalid');
  if (options.seenNonce?.(nonce)) throw new Error('Webhook nonce has already been processed');

  const expected = createHmac('sha256', secret)
    .update(String(timestamp) + '.' + nonce + '.' + body)
    .digest('hex');
  const actual = signature.replace(/^sha256=/, '').replace(/^.*v1=/, '');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Webhook signature is invalid');
  return { timestamp, nonce };
}

[executed on device: ayobami-Latitude-7490 (72e3809b-99f3-4e5b-bf19-7150a4cf8ab3)]