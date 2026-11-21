"use client";

import { useState } from "react";
import { connectFreighter } from "@/lib/freighter";
import { formatStreamBalance } from "@/lib/stream-balance";
import type { PayrollStream } from "@/components/dashboard/views/streaming-payroll-panel";

interface ClaimStreamDrawerProps {
  stream: PayrollStream;
  claimableBalance: number;
  onClose: () => void;
  onClaimed?: (amount: number) => void;
  /** Injected in tests to bypass Freighter and the relayer. */
  submitClaim?: (params: { streamId: string; amount: number; senderAddress: string }) => Promise<{ txHash: string }>;
}

type StepState =
  | { step: "idle" }
  | { step: "connecting" }
  | { step: "confirm"; address: string }
  | { step: "submitting" }
  | { step: "done"; txHash: string }
  | { step: "error"; message: string };

/**
 * Drawer for claiming (withdrawing) the claimable balance of a streaming
 * payroll stream (#291). Connects Freighter, asks the user to confirm, then
 * calls the relayer to submit a `withdraw_from_stream` transaction.
 */
export function ClaimStreamDrawer({
  stream,
  claimableBalance,
  onClose,
  onClaimed,
  submitClaim,
}: ClaimStreamDrawerProps) {
  const [state, setState] = useState<StepState>({ step: "idle" });

  const displayBalance = formatStreamBalance(claimableBalance);
  const canClaim = claimableBalance > 0;

  const handleConnect = async () => {
    setState({ step: "connecting" });
    const result = await connectFreighter();
    if (!result.ok) {
      setState({ step: "error", message: result.error });
      return;
    }
    setState({ step: "confirm", address: result.address });
  };

  const handleClaim = async () => {
    if (state.step !== "confirm") return;
    const { address } = state;
    setState({ step: "submitting" });
    try {
      const amount = claimableBalance;
      let txHash: string;
      if (submitClaim) {
        const result = await submitClaim({ streamId: stream.id, amount, senderAddress: address });
        txHash = result.txHash;
      } else {
        const res = await fetch("/api/payroll/streams/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stream_id: stream.id, amount, sender_address: address }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        }
        const data = (await res.json()) as { tx_hash: string };
        txHash = data.tx_hash;
      }
      setState({ step: "done", txHash });
      onClaimed?.(claimableBalance);
    } catch (err) {
      setState({
        step: "error",
        message: err instanceof Error ? err.message : "Claim failed. Try again.",
      });
    }
  };

  return (
    <aside
      className="fixed inset-y-0 right-0 w-full max-w-sm bg-white border-l border-black/10 shadow-xl z-50 flex flex-col"
      aria-label="Claim stream balance"
    >
      <div className="flex items-center justify-between px-5 py-4 border-b border-black/10">
        <h2 className="text-lg font-bold text-black">Claim balance</h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-black/40 hover:text-black transition-colors"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-6 space-y-6">
        <div className="rounded-xl border border-black/10 p-4 space-y-1">
          <p className="text-xs text-black/50">Recipient</p>
          <p className="font-semibold text-black">{stream.recipientLabel}</p>
        </div>

        <div className="rounded-xl border border-black/10 p-4 space-y-1">
          <p className="text-xs text-black/50">Claimable now</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-black">
            {displayBalance}{" "}
            <span className="text-sm font-normal text-black/50">{stream.tokenSymbol}</span>
          </p>
        </div>

        {state.step === "idle" && (
          <button
            onClick={handleConnect}
            disabled={!canClaim}
            className="w-full rounded-xl bg-black text-white py-3 font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-black/80 transition-colors"
          >
            {canClaim ? "Connect Freighter to claim" : "Nothing to claim yet"}
          </button>
        )}

        {state.step === "connecting" && (
          <p className="text-sm text-black/60 text-center">Connecting to Freighter…</p>
        )}

        {state.step === "confirm" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-black/10 p-4 space-y-1">
              <p className="text-xs text-black/50">Signing address</p>
              <p className="font-mono text-xs text-black break-all">{state.address}</p>
            </div>
            <button
              onClick={handleClaim}
              className="w-full rounded-xl bg-black text-white py-3 font-semibold hover:bg-black/80 transition-colors"
            >
              Claim {displayBalance} {stream.tokenSymbol}
            </button>
            <button
              onClick={() => setState({ step: "idle" })}
              className="w-full rounded-xl border border-black/10 py-3 text-sm text-black/60 hover:bg-black/5 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {state.step === "submitting" && (
          <p className="text-sm text-black/60 text-center">Submitting transaction…</p>
        )}

        {state.step === "done" && (
          <div className="space-y-4">
            <div className="rounded-xl bg-green-50 border border-green-200 p-4 space-y-1">
              <p className="text-sm font-semibold text-green-800">Claim submitted</p>
              <p className="font-mono text-xs text-green-700 break-all">{state.txHash}</p>
            </div>
            <button
              onClick={onClose}
              className="w-full rounded-xl border border-black/10 py-3 text-sm text-black/60 hover:bg-black/5 transition-colors"
            >
              Close
            </button>
          </div>
        )}

        {state.step === "error" && (
          <div className="space-y-4">
            <div className="rounded-xl bg-red-50 border border-red-200 p-4">
              <p className="text-sm text-red-700">{state.message}</p>
            </div>
            <button
              onClick={() => setState({ step: "idle" })}
              className="w-full rounded-xl border border-black/10 py-3 text-sm text-black/60 hover:bg-black/5 transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
