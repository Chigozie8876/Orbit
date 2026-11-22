/**
 * Streaming payroll balance math (#291).
 *
 * A stream accrues `ratePerSecond` tokens from `startTime` until `endTime`.
 * The claimable balance is what has accrued minus what was already withdrawn.
 * Times are epoch milliseconds, amounts are token units as numbers.
 */

export interface StreamSchedule {
  /** Tokens accrued per second. */
  ratePerSecond: number;
  /** Stream start, epoch ms. */
  startTime: number;
  /** Stream end, epoch ms. Accrual stops here. */
  endTime: number;
  /** Tokens already withdrawn by the recipient. */
  withdrawnAmount: number;
}

export function totalStreamAmount(schedule: StreamSchedule): number {
  const seconds = Math.max(0, schedule.endTime - schedule.startTime) / 1000;
  return schedule.ratePerSecond * seconds;
}

/**
 * Claimable balance at `nowMs`. Accrual is clamped to the stream window, so
 * the balance never exceeds the total and never goes negative.
 */
export function computeStreamBalance(schedule: StreamSchedule, nowMs: number): number {
  const elapsedMs = Math.min(
    Math.max(0, nowMs - schedule.startTime),
    Math.max(0, schedule.endTime - schedule.startTime),
  );
  const accrued = schedule.ratePerSecond * (elapsedMs / 1000);
  return Math.max(0, accrued - schedule.withdrawnAmount);
}

/** Fixed 6-decimal string, matching the on-chain precision shown to users. */
export function formatStreamBalance(amount: number): string {
  return amount.toFixed(6);
}
