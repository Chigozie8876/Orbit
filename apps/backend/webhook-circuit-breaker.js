'use strict';

/**
 * Per-endpoint circuit breaker for merchant webhooks (#289).
 *
 * Tracks the last `windowSize` delivery attempts for each endpoint. When the
 * failure ratio goes above `pauseRatio` the endpoint is PAUSED: new events are
 * queued instead of retried, and the merchant is notified once. Queued events
 * are replayed after a successful "Verify Endpoint" health ping.
 */

const STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  DEGRADED: 'DEGRADED',
  PAUSED: 'PAUSED',
});

class WebhookCircuitBreaker {
  /**
   * @param {object} [options]
   * @param {number} [options.windowSize=50] Attempts kept per endpoint.
   * @param {number} [options.minAttempts=10] Attempts needed before the breaker may trip.
   * @param {number} [options.pauseRatio=0.9] Failure ratio above which the endpoint pauses.
   * @param {number} [options.degradeRatio=0.5] Failure ratio at which the endpoint is marked DEGRADED.
   * @param {(alert: object) => (void|Promise<void>)} [options.notify] Called once per trip.
   */
  constructor({
    windowSize = 50,
    minAttempts = 10,
    pauseRatio = 0.9,
    degradeRatio = 0.5,
    notify = () => {},
  } = {}) {
    this.windowSize = windowSize;
    this.minAttempts = minAttempts;
    this.pauseRatio = pauseRatio;
    this.degradeRatio = degradeRatio;
    this.notify = notify;
    this.endpoints = new Map(); // url -> state
  }

  _state(url) {
    let state = this.endpoints.get(url);
    if (!state) {
      state = { status: STATUS.ACTIVE, outcomes: [], pending: [], last: null };
      this.endpoints.set(url, state);
    }
    return state;
  }

  status(url) {
    return this._state(url).status;
  }

  pendingCount(url) {
    return this._state(url).pending.length;
  }

  /**
   * Record one delivery attempt and update the endpoint status.
   * @param {string} url
   * @param {{ ok: boolean, statusCode?: number, body?: string }} result
   * @returns {Promise<string>} The status after recording the attempt.
   */
  async recordAttempt(url, { ok, statusCode = null, body = '' }) {
    const state = this._state(url);
    state.outcomes.push(Boolean(ok));
    if (state.outcomes.length > this.windowSize) {
      state.outcomes.splice(0, state.outcomes.length - this.windowSize);
    }
    if (!ok) {
      state.last = { statusCode, body: String(body).slice(0, 500) };
    }

    if (state.status === STATUS.PAUSED) {
      return state.status; // only verify() re-activates a paused endpoint
    }

    const attempts = state.outcomes.length;
    if (attempts < this.minAttempts) {
      return state.status;
    }
    const failures = state.outcomes.filter((ok) => !ok).length;
    const ratio = failures / attempts;

    if (ratio > this.pauseRatio) {
      state.status = STATUS.PAUSED;
      await this.notify({
        url,
        status: STATUS.PAUSED,
        failureRatio: ratio,
        lastStatusCode: state.last?.statusCode ?? null,
        lastResponseBody: state.last?.body ?? '',
      });
    } else if (ratio >= this.degradeRatio) {
      state.status = STATUS.DEGRADED;
    } else {
      state.status = STATUS.ACTIVE;
    }
    return state.status;
  }

  /**
   * Deliver an event through the breaker.
   * While PAUSED the event is queued and `deliver` is not called. A failure
   * that trips the breaker queues the event too, so it is not lost.
   *
   * @param {string} url
   * @param {object} event
   * @param {(event: object) => Promise<{ ok: boolean, statusCode?: number, body?: string }>} deliver
   * @returns {Promise<{ queued: boolean, ok?: boolean, status: string }>}
   */
  async submit(url, event, deliver) {
    const state = this._state(url);
    if (state.status === STATUS.PAUSED) {
      state.pending.push(event);
      return { queued: true, status: state.status };
    }

    const result = await deliver(event);
    const status = await this.recordAttempt(url, result);
    if (!result.ok && status === STATUS.PAUSED) {
      state.pending.push(event);
      return { queued: true, ok: false, status };
    }
    return { queued: false, ok: Boolean(result.ok), status };
  }

  /**
   * "Verify Endpoint" health ping. A successful ping re-activates the endpoint,
   * resets its failure window and returns the queued events for replay.
   *
   * @param {string} url
   * @param {() => Promise<{ ok: boolean, statusCode?: number, body?: string }>} ping
   * @returns {Promise<{ ok: boolean, status: string, pending: object[] }>}
   */
  async verify(url, ping) {
    const state = this._state(url);
    let ok = false;
    try {
      ok = Boolean((await ping()).ok);
    } catch (_err) {
      ok = false;
    }
    if (!ok) {
      return { ok: false, status: state.status, pending: [] };
    }
    state.status = STATUS.ACTIVE;
    state.outcomes = [];
    const pending = state.pending.splice(0, state.pending.length);
    return { ok: true, status: state.status, pending };
  }
}

module.exports = { WebhookCircuitBreaker, STATUS };
