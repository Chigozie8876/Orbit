import React, { useCallback, useEffect, useRef } from "react";

const STELLAR_EXPERT_BASE = "https://stellar.expert/explorer";

function getExplorerUrl(networkPassphrase, txHash) {
  const isTestnet = networkPassphrase?.includes("Test");
  const net = isTestnet ? "testnet" : "public";
  return `${STELLAR_EXPERT_BASE}/${net}/tx/${txHash}`;
}

function buildShareText({ merchantName, planName, amount, cadence }) {
  const cadenceLabel = cadence === "monthly" ? "monthly" : cadence === "yearly" ? "annually" : cadence;
  return `Just subscribed to ${planName} on @OrbitNetwork rails! 🚀 ${amount} USDC ${cadenceLabel} to ${merchantName}.`;
}

function fireConfetti(canvasRef) {
  if (typeof window === "undefined") return () => {};
  const canvas = canvasRef.current;
  if (!canvas) return () => {};

  // Lightweight particle confetti — no external dependency
  const ctx = canvas.getContext("2d");
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const COLORS = ["#3B82F6", "#8B5CF6", "#10B981", "#F59E0B", "#EF4444", "#EC4899"];
  const COUNT = 80;
  const particles = Array.from({ length: COUNT }, () => ({
    x: canvas.width * Math.random(),
    y: -10 - Math.random() * 40,
    r: 4 + Math.random() * 6,
    d: 2 + Math.random() * 3,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    tilt: Math.random() * 10 - 5,
    tiltAngle: 0,
    tiltSpeed: 0.1 + Math.random() * 0.1,
    opacity: 1,
  }));

  let frame;
  let startTime = performance.now();
  const DURATION_MS = 2800;

  function draw(now) {
    const elapsed = now - startTime;
    if (elapsed > DURATION_MS) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const progress = elapsed / DURATION_MS;
    for (const p of particles) {
      p.tiltAngle += p.tiltSpeed;
      p.y += p.d + 1 * progress;
      p.x += Math.sin(p.tiltAngle) * 1.5;
      p.opacity = Math.max(0, 1 - progress * 1.4);
      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.tiltAngle);
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      ctx.restore();
    }
    frame = requestAnimationFrame(draw);
  }

  frame = requestAnimationFrame(draw);
  return () => { cancelAnimationFrame(frame); ctx.clearRect(0, 0, canvas.width, canvas.height); };
}

/**
 * SuccessReceipt — shown after a subscription transaction confirms.
 *
 * Props:
 *   merchantName  {string}
 *   planName      {string}
 *   amount        {string}   human-readable, e.g. "29.00"
 *   cadence       {string}   "monthly" | "yearly" | custom label
 *   txHash        {string}   confirmed transaction hash
 *   networkPassphrase {string}
 *   onDismiss     {function}
 */
export function SuccessReceipt({
  merchantName,
  planName,
  amount,
  cadence,
  txHash,
  networkPassphrase,
  onDismiss,
}) {
  const canvasRef = useRef(null);
  const receiptRef = useRef(null);
  const shortHash = txHash ? `${txHash.slice(0, 8)}…${txHash.slice(-6)}` : "";
  const explorerUrl = txHash ? getExplorerUrl(networkPassphrase, txHash) : "#";
  const shareText = buildShareText({ merchantName, planName, amount: `${amount} USDC`, cadence });

  useEffect(() => {
    const cleanup = fireConfetti(canvasRef);
    return cleanup;
  }, []);

  const handleDismiss = useCallback(() => {
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    onDismiss?.();
  }, [onDismiss]);

  const handleShareX = useCallback(() => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
    window.open(url, "_blank", "noopener,noreferrer,width=550,height=420");
  }, [shareText]);

  const handleShareFarcaster = useCallback(() => {
    const url = `https://warpcast.com/~/compose?text=${encodeURIComponent(shareText)}`;
    window.open(url, "_blank", "noopener,noreferrer,width=600,height=500");
  }, [shareText]);

  const handleDownloadReceipt = useCallback(async () => {
    if (!receiptRef.current) return;
    try {
      const { default: html2canvas } = await import(/* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.esm.js");
      const canvas = await html2canvas(receiptRef.current, { backgroundColor: "#0f1117", scale: 2 });
      const link = document.createElement("a");
      link.download = `orbit-receipt-${txHash?.slice(0, 8) ?? "subscription"}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch {
      // Fallback: open print dialog
      window.print();
    }
  }, [txHash]);

  return (
    <div className="orbit-success-receipt" style={styles.wrapper}>
      {/* Confetti canvas — absolutely positioned behind receipt */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={styles.canvas}
      />

      <div ref={receiptRef} style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.checkCircle} aria-hidden="true">✓</span>
          <h2 style={styles.title}>Subscription Confirmed</h2>
          <p style={styles.subtitle}>Your subscription is now active</p>
        </div>

        {/* Receipt details */}
        <div style={styles.details}>
          <Row label="Merchant" value={merchantName} />
          <Row label="Plan" value={planName} />
          <Row label="Amount" value={`${amount} USDC`} />
          <Row label="Billing" value={cadence} />
          <Row
            label="Tx"
            value={
              <a href={explorerUrl} target="_blank" rel="noopener noreferrer" style={styles.link}>
                {shortHash}
              </a>
            }
          />
        </div>

        {/* Action buttons */}
        <div style={styles.actions}>
          <button onClick={handleShareX} style={{ ...styles.btn, ...styles.btnSecondary }} type="button">
            Share on X
          </button>
          <button onClick={handleShareFarcaster} style={{ ...styles.btn, ...styles.btnSecondary }} type="button">
            Share on Farcaster
          </button>
          <button onClick={handleDownloadReceipt} style={{ ...styles.btn, ...styles.btnSecondary }} type="button">
            Save Receipt
          </button>
        </div>

        <button onClick={handleDismiss} style={{ ...styles.btn, ...styles.btnPrimary }} type="button">
          Done
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <span style={styles.rowValue}>{value}</span>
    </div>
  );
}

const styles = {
  wrapper: { position: "relative", display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 16px", minHeight: 400 },
  canvas: { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 },
  card: { position: "relative", zIndex: 1, background: "#1a1f2e", border: "1px solid #2d3748", borderRadius: 16, padding: "28px 24px", width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 16 },
  header: { textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  checkCircle: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, borderRadius: "50%", background: "#10B981", color: "#fff", fontSize: 24, fontWeight: "bold" },
  title: { margin: 0, fontSize: 18, fontWeight: 700, color: "#fff" },
  subtitle: { margin: 0, fontSize: 13, color: "#94a3b8" },
  details: { background: "#0f1117", borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 },
  row: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  rowLabel: { fontSize: 12, color: "#64748b", fontWeight: 500 },
  rowValue: { fontSize: 13, color: "#e2e8f0", fontWeight: 600, textAlign: "right" },
  link: { color: "#3B82F6", textDecoration: "underline" },
  actions: { display: "flex", gap: 8, flexWrap: "wrap" },
  btn: { flex: 1, minWidth: 100, padding: "10px 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  btnPrimary: { background: "#3B82F6", color: "#fff", width: "100%" },
  btnSecondary: { background: "#1e293b", color: "#cbd5e1", border: "1px solid #334155" },
};

export default SuccessReceipt;
