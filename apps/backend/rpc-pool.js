const { rpc } = require('@stellar/stellar-sdk');

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const retryableRpcError = (error) => {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const message = String(error?.message || '').toLowerCase();
  return status === 429 || status >= 500 || /timeout|rate limit|econnreset|econnrefused|fetch failed/.test(message);
};

const parseRpcUrls = (env = process.env) => {
  const raw = env.SOROBAN_RPC_SERVERS || env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  return [...new Set(String(raw).split(',').map((v) => v.trim()).filter(Boolean))];
};

class SorobanRpcPool {
  constructor(options = {}) {
    const urls = options.urls || parseRpcUrls();
    const factory = options.serverFactory || ((url) => new rpc.Server(url));
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random || Math.random;
    this.now = options.now || Date.now;
    this.quarantineMs = options.quarantineMs || Number(process.env.SOROBAN_RPC_QUARANTINE_MS) || 30000;
    this.healthIntervalMs = options.healthIntervalMs || Number(process.env.SOROBAN_RPC_HEALTH_INTERVAL_MS) || 15000;
    this.nodes = urls.map((url) => ({ url, server: factory(url), healthy: true, latencyMs: Infinity, errors: 0, quarantinedUntil: 0 }));
    this.timer = null;
  }

  available() {
    const now = this.now();
    return this.nodes.filter((n) => n.healthy && n.quarantinedUntil <= now)
      .sort((a, b) => a.latencyMs - b.latencyMs || a.errors - b.errors);
  }

  markFailure(node) {
    node.healthy = false;
    node.errors += 1;
    node.quarantinedUntil = this.now() + this.quarantineMs;
  }

  markSuccess(node, latency) {
    node.healthy = true;
    node.errors = 0;
    node.quarantinedUntil = 0;
    node.latencyMs = Number.isFinite(node.latencyMs) ? Math.round(node.latencyMs * 0.7 + latency * 0.3) : latency;
  }

  async probe(node) {
    if (node.quarantinedUntil > this.now()) return false;
    const started = this.now();
    try {
      await node.server.getLatestLedger();
      this.markSuccess(node, Math.max(0, this.now() - started));
      return true;
    } catch {
      this.markFailure(node);
      return false;
    }
  }

  async healthCheck() { return Promise.all(this.nodes.map((node) => this.probe(node))); }

  start() {
    if (this.timer || this.healthIntervalMs <= 0) return;
    this.timer = setInterval(() => this.healthCheck().catch(() => {}), this.healthIntervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async request(method, ...args) {
    const tried = new Set();
    let lastError;
    for (let attempt = 0; attempt < this.nodes.length; attempt += 1) {
      let node = this.available().find((candidate) => !tried.has(candidate.url));
      if (!node) {
        node = this.nodes.filter((candidate) => !tried.has(candidate.url))
          .sort((a, b) => a.quarantinedUntil - b.quarantinedUntil)[0];
        if (!node) break;
        const delay = Math.max(0, node.quarantinedUntil - this.now());
        if (delay) await this.sleep(Math.min(delay, 250) + Math.floor(this.random() * 50));
        node.quarantinedUntil = 0;
      }
      tried.add(node.url);
      const started = this.now();
      try {
        const fn = node.server?.[method];
        if (typeof fn !== 'function') throw new Error('Soroban RPC method unavailable: ' + method);
        const result = await fn.apply(node.server, args);
        this.markSuccess(node, Math.max(0, this.now() - started));
        return result;
      } catch (error) {
        lastError = error;
        if (!retryableRpcError(error)) throw error;
        this.markFailure(node);
        if (attempt < this.nodes.length - 1) {
          const backoff = Math.min(250, 25 * (2 ** attempt));
          await this.sleep(backoff + Math.floor(this.random() * Math.max(1, backoff)));
        }
      }
    }
    const error = new Error('All configured Soroban RPC nodes are unavailable');
    error.statusCode = 503;
    error.cause = lastError;
    throw error;
  }

  proxy() {
    return new Proxy({}, { get: (_target, key) => key === 'pool' ? this : (...args) => this.request(String(key), ...args) });
  }
}

let shared;
function getSharedRpcPool(options) {
  if (!shared || options) { shared = new SorobanRpcPool(options); shared.start(); }
  return shared;
}

module.exports = { SorobanRpcPool, getSharedRpcPool, parseRpcUrls, retryableRpcError };