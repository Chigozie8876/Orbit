"use client";

import { useEffect, useState } from "react";
import {
  computeStreamBalance,
  formatStreamBalance,
  type StreamSchedule,
} from "@/lib/stream-balance";

const TICK_MS = 100;

/**
 * Live balance for one payroll stream. Re-computes from the schedule every
 * 100ms, so the value stays correct even if a tick is delayed. The interval is
 * cleared on unmount or when the schedule changes.
 */
export function StreamBalanceCounter({
  schedule,
  className,
}: {
  schedule: StreamSchedule;
  className?: string;
}) {
  const [balance, setBalance] = useState(() =>
    computeStreamBalance(schedule, Date.now()),
  );

  useEffect(() => {
    setBalance(computeStreamBalance(schedule, Date.now()));
    const id = window.setInterval(() => {
      setBalance(computeStreamBalance(schedule, Date.now()));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [schedule]);

  return (
    <span className={className} aria-live="off" data-testid="stream-balance">
      {formatStreamBalance(balance)}
    </span>
  );
}
