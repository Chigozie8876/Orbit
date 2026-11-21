"use client";

import { StreamBalanceCounter } from "../stream-balance-counter";
import {
  formatStreamBalance,
  totalStreamAmount,
  type StreamSchedule,
} from "@/lib/stream-balance";

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
 * ticks every 100ms, plus its start, end, total and already-withdrawn amounts.
 * Streams come from the `streams` prop; with none, an empty state is shown.
 */
export function StreamingPayrollPanel({ streams = [] }: { streams?: PayrollStream[] }) {
  return (
    <section className="rounded-2xl border border-black/10 bg-white p-5 space-y-4" aria-labelledby="streaming-payroll-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="streaming-payroll-heading" className="text-xl font-bold tracking-tight text-black">
          Streaming payroll
        </h2>
        <span className="text-xs text-black/50">{streams.length} active</span>
      </div>

      {streams.length === 0 ? (
        <p className="text-sm text-black/60">No active payroll streams.</p>
      ) : (
        <ul className="space-y-3">
          {streams.map((stream) => (
            <li key={stream.id} className="rounded-xl border border-black/10 p-4 space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-black">{stream.recipientLabel}</span>
                <span className="font-mono text-lg font-bold tabular-nums text-black">
                  <StreamBalanceCounter schedule={stream} />{" "}
                  <span className="text-xs font-normal text-black/50">{stream.tokenSymbol}</span>
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
                    {formatStreamBalance(totalStreamAmount(stream))} {stream.tokenSymbol}
                  </dd>
                </div>
                <div>
                  <dt className="text-black/50">Withdrawn</dt>
                  <dd className="tabular-nums">
                    {formatStreamBalance(stream.withdrawnAmount)} {stream.tokenSymbol}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
