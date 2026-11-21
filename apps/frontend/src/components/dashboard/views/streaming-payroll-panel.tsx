"use client";

import { useState } from "react";
import { StreamBalanceCounter } from "../stream-balance-counter";
import {
  computeStreamBalance,
  formatStreamBalance,
  totalStreamAmount,
  type StreamSchedule,
} from "@/lib/stream-balance";
import { ClaimStreamDrawer } from "@/components/dashboard/drawers/claim-stream-drawer";

export interface PayrollStream extends StreamSchedule {
  id: string;
  recipientLabel: string;
  tokenSymbol: string;
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Live streaming payroll panel (#291). Each active stream shows a balance that
 * ticks every 100ms, plus start/end/total/withdrawn amounts and a Claim button
 * that opens the ClaimStreamDrawer when the claimable balance is non-zero.
 * Streams come from the `streams` prop; with none, an empty state is shown.
 */
export function StreamingPayrollPanel({ streams = [] }: { streams?: PayrollStream[] }) {
  const [claimTarget, setClaimTarget] = useState<PayrollStream | null>(null);

  return (
    <>
      <section
        className="rounded-2xl border border-black/10 bg-white p-5 space-y-4"
        aria-labelledby="streaming-payroll-heading"
      >
        <div className="flex items-center justify-between gap-3">
          <h2
            id="streaming-payroll-heading"
            className="text-xl font-bold tracking-tight text-black"
          >
            Streaming payroll
          </h2>
          <span className="text-xs text-black/50">{streams.length} active</span>
        </div>

        {streams.length === 0 ? (
          <p className="text-sm text-black/60">No active payroll streams.</p>
        ) : (
          <ul className="space-y-3">
            {streams.map((stream) => {
              const claimable = computeStreamBalance(stream, Date.now());
              return (
                <li
                  key={stream.id}
                  className="rounded-xl border border-black/10 p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold text-black">{stream.recipientLabel}</span>
                    <span className="font-mono text-lg font-bold tabular-nums text-black">
                      <StreamBalanceCounter schedule={stream} />{" "}
                      <span className="text-xs font-normal text-black/50">
                        {stream.tokenSymbol}
                      </span>
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-black/70 sm:grid-cols-4">
                    <div>
                      <dt className="text-black/50">Start</dt>
                      <dd>{dateFormat.format(new Date(stream.startTime))}</dd>
                    </div>
                    <div>
                      <dt className="text-black/50">End</dt>
                      <dd>{dateFormat.format(new Date(stream.endTime))}</dd>
                    </div>
                    <div>
                      <dt className="text-black/50">Total</dt>
                      <dd className="tabular-nums">
                        {formatStreamBalance(totalStreamAmount(stream))}{" "}
                        {stream.tokenSymbol}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-black/50">Withdrawn</dt>
                      <dd className="tabular-nums">
                        {formatStreamBalance(stream.withdrawnAmount)} {stream.tokenSymbol}
                      </dd>
                    </div>
                  </dl>
                  <button
                    onClick={() => setClaimTarget(stream)}
                    disabled={claimable <= 0}
                    className="mt-1 rounded-lg border border-black/20 px-3 py-1.5 text-xs font-medium text-black hover:bg-black/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {claimable > 0
                      ? `Claim ${formatStreamBalance(claimable)} ${stream.tokenSymbol}`
                      : "Nothing to claim"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {claimTarget && (
        <ClaimStreamDrawer
          stream={claimTarget}
          claimableBalance={computeStreamBalance(claimTarget, Date.now())}
          onClose={() => setClaimTarget(null)}
        />
      )}
    </>
  );
}
