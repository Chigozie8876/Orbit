import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const { WebhookCircuitBreaker, STATUS } = createRequire(import.meta.url)('../webhook-circuit-breaker.js');

const URL = 'https://merchant.example/hooks';
const ok = async () => ({ ok: true, statusCode: 200, body: '' });
const fail = async () => ({ ok: false, statusCode: 503, body: 'upstream down' });

describe('WebhookCircuitBreaker (#289)', () => {
  it('stays ACTIVE while deliveries succeed', async () => {
    const breaker = new WebhookCircuitBreaker();
    for (let i = 0; i < 20; i++) {
      await breaker.submit(URL, { id: i }, ok);
    }
    expect(breaker.status(URL)).toBe(STATUS.ACTIVE);
  });

  it('does not trip before the minimum number of attempts', async () => {
    const notify = vi.fn();
    const breaker = new WebhookCircuitBreaker({ minAttempts: 10, notify });
    for (let i = 0; i < 9; i++) {
      await breaker.submit(URL, { id: i }, fail);
    }
    expect(breaker.status(URL)).not.toBe(STATUS.PAUSED);
    expect(notify).not.toHaveBeenCalled();
  });

  it('marks the endpoint DEGRADED at a 50% failure ratio', async () => {
    const breaker = new WebhookCircuitBreaker({ minAttempts: 10 });
    for (let i = 0; i < 10; i++) {
      await breaker.submit(URL, { id: i }, i % 2 === 0 ? fail : ok);
    }
    expect(breaker.status(URL)).toBe(STATUS.DEGRADED);
  });

  it('pauses when the failure ratio goes above 90% and notifies once', async () => {
    const notify = vi.fn();
    const breaker = new WebhookCircuitBreaker({ minAttempts: 10, notify });
    for (let i = 0; i < 10; i++) {
      await breaker.submit(URL, { id: i }, fail);
    }

    expect(breaker.status(URL)).toBe(STATUS.PAUSED);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        url: URL,
        status: STATUS.PAUSED,
        lastStatusCode: 503,
        lastResponseBody: 'upstream down',
      }),
    );
  });

  it('keeps the failing event in the pending queue rather than dropping it', async () => {
    const breaker = new WebhookCircuitBreaker({ minAttempts: 10 });
    let last;
    for (let i = 0; i < 10; i++) {
      last = await breaker.submit(URL, { id: i }, fail);
    }
    expect(last).toEqual({ queued: true, ok: false, status: STATUS.PAUSED });
    expect(breaker.pendingCount(URL)).toBe(1);
  });

  it('queues events without calling the endpoint while paused', async () => {
    const breaker = new WebhookCircuitBreaker({ minAttempts: 10 });
    for (let i = 0; i < 10; i++) {
      await breaker.submit(URL, { id: i }, fail);
    }
    const deliver = vi.fn(ok);

    const result = await breaker.submit(URL, { id: 'paused' }, deliver);

    expect(result.queued).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(breaker.pendingCount(URL)).toBe(2);
  });

  it('uses a sliding window so old failures stop counting', async () => {
    const breaker = new WebhookCircuitBreaker({ windowSize: 50, minAttempts: 10 });
    for (let i = 0; i < 10; i++) {
      await breaker.submit(URL, { id: i }, fail);
    }
    // Ten failures are paused. Verify, then recover with successes.
    await breaker.verify(URL, ok);
    for (let i = 0; i < 50; i++) {
      await breaker.submit(URL, { id: `ok-${i}` }, ok);
    }
    expect(breaker.status(URL)).toBe(STATUS.ACTIVE);
    expect(breaker.endpoints.get(URL).outcomes.length).toBe(50);
  });

  it('verify() re-activates the endpoint and returns queued events for replay', async () => {
    const breaker = new WebhookCircuitBreaker({ minAttempts: 10 });
    for (let i = 0; i < 10; i++) {
      await breaker.submit(URL, { id: i }, fail);
    }
    await breaker.submit(URL, { id: 'queued-1' }, ok);

    const result = await breaker.verify(URL, ok);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(STATUS.ACTIVE);
    expect(result.pending.map((e) => e.id)).toEqual([9, 'queued-1']);
    expect(breaker.pendingCount(URL)).toBe(0);
  });

  it('verify() keeps the endpoint paused when the ping fails', async () => {
    const breaker = new WebhookCircuitBreaker({ minAttempts: 10 });
    for (let i = 0; i < 10; i++) {
      await breaker.submit(URL, { id: i }, fail);
    }

    const result = await breaker.verify(URL, fail);

    expect(result).toEqual({ ok: false, status: STATUS.PAUSED, pending: [] });
    expect(breaker.status(URL)).toBe(STATUS.PAUSED);
  });

  it('verify() treats a thrown ping as a failed check', async () => {
    const breaker = new WebhookCircuitBreaker({ minAttempts: 10 });
    for (let i = 0; i < 10; i++) {
      await breaker.submit(URL, { id: i }, fail);
    }

    const result = await breaker.verify(URL, async () => {
      throw new Error('ECONNREFUSED');
    });

    expect(result.ok).toBe(false);
    expect(breaker.status(URL)).toBe(STATUS.PAUSED);
  });

  it('tracks each endpoint independently', async () => {
    const breaker = new WebhookCircuitBreaker({ minAttempts: 10 });
    for (let i = 0; i < 10; i++) {
      await breaker.submit(URL, { id: i }, fail);
    }
    await breaker.submit('https://other.example/hook', { id: 1 }, ok);

    expect(breaker.status(URL)).toBe(STATUS.PAUSED);
    expect(breaker.status('https://other.example/hook')).toBe(STATUS.ACTIVE);
  });
});
