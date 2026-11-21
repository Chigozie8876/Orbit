import React, { useCallback, useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 4000;
const MAX_POLL_ATTEMPTS = 60; // 4 min

/**
 * Poll Horizon for the USDC balance of `address` until it reaches `requiredAmount`
 * or `maxAttempts` is exhausted.
 *
 * @param {object} opts
 * @param {string}   opts.horizonUrl
 * @param {string}   opts.address
 * @param {{ code: string, issuer: string }} opts.asset
 * @param {bigint}   opts.requiredAmount   stroops
 * @param {number}   opts.intervalMs
 * @param {number}   opts.maxAttempts
 * @param {function} opts.onFunded         called when balance >= requiredAmount
 * @param {function} [opts.fetchImpl]
 * @returns {{ stop: function }}
 */
export function pollUntilFunded({
  horizonUrl,
  address,
  asset,
  requiredAmount,
  intervalMs = POLL_INTERVAL_MS,
  maxAttempts = MAX_POLL_ATTEMPTS,
  onFunded,
  fetchImpl = globalThis.fetch,
}) {
  let attempts = 0;
  let timerId = null;
  let stopped = false;

  async function check() {
    if (stopped) return;
    attempts++;
    try {
      const res = await fetchImpl(`${horizonUrl}/accounts/${encodeURIComponent(address)}`);
      if (res.ok) {
        const account = await res.json();
        const trustline = (account.balances ?? []).find(
          (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer
        );
        if (trustline) {
          const STROOPS = 10_000_000n;
          const [whole, frac = ""] = trustline.balance.split(".");
          const balanceStroops =
            BigInt(whole) * STROOPS + BigInt((frac + "0000000").slice(0, 7));
          if (balanceStroops >= requiredAmount) {
            stopped = true;
            onFunded(trustline.balance);
            return;
          }
        }
      }
    } catch {
      // network hiccup — keep polling
    }
    if (attempts < maxAttempts && !stopped) {
      timerId = setTimeout(check, intervalMs);
    }
  }

  timerId = setTimeout(check, intervalMs);
  return { stop() { stopped = true; clearTimeout(timerId); } };
}

/**
 * FiatOnRamp — zero-balance top-up modal for the checkout widget.
 *
 * Shows when `usdcReadiness.status === "insufficient"` or `"trustline_missing"`.
 *
 * Props:
 *   walletAddress  {string}
 *   requiredAmount {bigint}   stroops
 *   shortfall      {string}   human-readable, e.g. "15.0000000"
 *   asset          {{ code, issuer }}
 *   horizonUrl     {string}
 *   onFunded       {function}  called once balance reaches requiredAmount
 *   onClose        {function}
 *   provider       {string}   "moonpay" | "decaf" | "stripe" | "demo" (default "demo")
 */
export function FiatOnRamp({
  walletAddress,
  requiredAmount,
  shortfall,
  asset,
  horizonUrl,
  onFunded,
  onClose,
  provider = "demo",
}) {
  const [phase, setPhase] = useState("idle"); // idle | open | polling | funded
  const pollerRef = useRef(null);
  const overlayRef = useRef(null);

  // Build the on-ramp URL with pre-filled params
  const onRampUrl = buildOnRampUrl({ provider, walletAddress, asset, shortfall });

  const startPolling = useCallback(() => {
    setPhase("polling");
    pollerRef.current = pollUntilFunded({
      horizonUrl,
      address: walletAddress,
      asset,
      requiredAmount,
      onFunded(balance) {
        setPhase("funded");
        onFunded?.(balance);
      },
    });
  }, [horizonUrl, walletAddress, asset, requiredAmount, onFunded]);

  const handleOpen = useCallback(() => {
    setPhase("open");
    const popup = window.open(onRampUrl, "orbit-onramp", "width=480,height=700,noopener,noreferrer");
    if (!popup) {
      // Popup blocked — open in same tab
      window.location.href = onRampUrl;
      return;
    }
    // Start polling as soon as window opens — Decaf/MoonPay callbacks may be slow
    startPolling();
  }, [onRampUrl, startPolling]);

  const handleClose = useCallback(() => {
    pollerRef.current?.stop();
    onClose?.();
  }, [onClose]);

  // Escape key dismisses
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose]);

  // Cleanup on unmount
  useEffect(() => () => pollerRef.current?.stop(), []);

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Top up USDC"
      style={styles.overlay}
      onClick={(e) => { if (e.target === overlayRef.current) handleClose(); }}
    >
      <div style={styles.modal}>
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.icon} aria-hidden="true">💳</span>
            <h2 style={styles.title}>Top Up USDC</h2>
          </div>
          <button onClick={handleClose} style={styles.closeBtn} aria-label="Close" type="button">✕</button>
        </div>

        <p style={styles.description}>
          Your wallet needs <strong>{shortfall} USDC</strong> to complete this subscription. Buy crypto directly with a card — no exchange needed.
        </p>

        <InfoRow label="Wallet" value={`${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`} />
        <InfoRow label="Amount needed" value={`${shortfall} USDC`} />
        <InfoRow label="Provider" value={providerLabel(provider)} />

        {phase === "idle" && (
          <button onClick={handleOpen} style={{ ...styles.btn, ...styles.btnPrimary }} type="button">
            Buy USDC with Card
          </button>
        )}

        {phase === "open" && (
          <div style={styles.statusBox}>
            <Spinner />
            <span style={styles.statusText}>Complete the purchase in the popup…</span>
            <button onClick={startPolling} style={{ ...styles.btn, ...styles.btnSecondary, marginTop: 8 }} type="button">
              I already paid — check my balance
            </button>
          </div>
        )}

        {phase === "polling" && (
          <div style={styles.statusBox}>
            <Spinner />
            <span style={styles.statusText}>Watching for USDC arrival on-chain…</span>
          </div>
        )}

        {phase === "funded" && (
          <div style={{ ...styles.statusBox, background: "#052e16", borderColor: "#10b981" }}>
            <span style={{ fontSize: 28 }}>✓</span>
            <span style={{ ...styles.statusText, color: "#10b981" }}>USDC arrived! Proceeding to subscription…</span>
          </div>
        )}

        <p style={styles.disclaimer}>
          Transactions are processed by {providerLabel(provider)}. Orbit does not handle fiat payments.
        </p>
      </div>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={styles.infoRow}>
      <span style={styles.infoLabel}>{label}</span>
      <span style={styles.infoValue}>{value}</span>
    </div>
  );
}

function Spinner() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ animation: "orbit-spin 1s linear infinite" }}>
      <style>{`@keyframes orbit-spin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="12" cy="12" r="10" stroke="#3B82F6" strokeWidth="3" strokeDasharray="40 20" />
    </svg>
  );
}

function buildOnRampUrl({ provider, walletAddress, asset, shortfall }) {
  const amount = shortfall?.replace(/0+$/, "").replace(/\.$/, "") ?? "10";
  if (provider === "moonpay") {
    return `https://buy-sandbox.moonpay.com/?apiKey=pk_test_123&currencyCode=usdc_xlm&walletAddress=${encodeURIComponent(walletAddress)}&baseCurrencyAmount=${amount}`;
  }
  if (provider === "decaf") {
    return `https://app.decaf.so/buy?network=stellar&address=${encodeURIComponent(walletAddress)}&amount=${amount}&asset=USDC`;
  }
  if (provider === "stripe") {
    return `https://crypto.link.com?session_hash=demo&wallet_address=${encodeURIComponent(walletAddress)}`;
  }
  // demo / fallback — visual mock
  return `about:blank`;
}

function providerLabel(provider) {
  if (provider === "moonpay") return "MoonPay";
  if (provider === "decaf") return "Decaf";
  if (provider === "stripe") return "Stripe";
  return "On-ramp";
}

const styles = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 16 },
  modal: { background: "#1a1f2e", border: "1px solid #2d3748", borderRadius: 16, padding: "24px 20px", width: "100%", maxWidth: 400, display: "flex", flexDirection: "column", gap: 14 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  icon: { fontSize: 22 },
  title: { margin: 0, fontSize: 17, fontWeight: 700, color: "#fff" },
  closeBtn: { background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 18, padding: 4, lineHeight: 1 },
  description: { margin: 0, fontSize: 13, color: "#94a3b8", lineHeight: 1.5 },
  infoRow: { display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #1e293b" },
  infoLabel: { fontSize: 12, color: "#64748b" },
  infoValue: { fontSize: 13, color: "#e2e8f0", fontWeight: 600, fontFamily: "monospace" },
  statusBox: { background: "#0f1117", border: "1px solid #2d3748", borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  statusText: { fontSize: 13, color: "#94a3b8", textAlign: "center" },
  btn: { padding: "11px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, textAlign: "center", width: "100%" },
  btnPrimary: { background: "#3B82F6", color: "#fff" },
  btnSecondary: { background: "#1e293b", color: "#cbd5e1", border: "1px solid #334155" },
  disclaimer: { margin: 0, fontSize: 11, color: "#475569", textAlign: "center" },
};

export default FiatOnRamp;
