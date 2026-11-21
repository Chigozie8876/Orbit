/**
 * Subscriber health and churn-risk scoring for the merchant dashboard (#298).
 *
 * A subscription's renewal can fail for three reasons the merchant can act on
 * before it happens: the subscriber's wallet does not hold enough USDC, the
 * vault allowance Orbit pulls against is used up or expired, or recent pulls
 * have already failed. Each is a `HealthFactor`; the worst factor decides the
 * level. A warning becomes critical when the renewal is due within
 * `DUE_SOON_HOURS`, because there is no time left to fix it unprompted.
 *
 * Inputs come from data the dashboard already loads:
 *   - `liquidity`: the latest on-chain balance/allowance snapshot recorded by
 *     the pre-billing monitor (backend `prebilling-monitor.js`), in USDC;
 *   - `lastFailure.code`: the classified reason of the last failed pull
 *     (`insufficient_balance`, `insufficient_allowance`, `expired_allowance`);
 *   - `retryCount` / `status`: dunning state;
 *   - `nextBillingAt`: when the next pull is due.
 *
 * Kept free of React and i18n so it can be unit-tested; the view translates
 * factor codes into tooltip text.
 */

export type HealthLevel = "good" | "warning" | "critical";

export type HealthFactorCode =
  | "insufficient_balance"
  | "low_balance"
  | "allowance_exhausted"
  | "allowance_low"
  | "allowance_expired"
  | "pull_failures"
  | "past_due"
  | "due_soon";

export interface HealthFactor {
  code: HealthFactorCode;
  severity: Exclude<HealthLevel, "good">;
  /** Values for the factor's tooltip message (amounts in USDC). */
  params?: Record<string, string | number>;
}

/** Latest on-chain liquidity check for a subscription, amounts in USDC. */
export interface LiquiditySnapshot {
  balance: number;
  allowance: number;
  checkedAt?: string;
}

/** The fields of a subscriber record the scorer reads. */
export interface HealthInput {
  status: string;
  amount: number;
  retryCount?: number;
  nextBillingAt?: string;
  lastFailure?: { code: string };
  liquidity?: LiquiditySnapshot;
}

export interface SubscriberHealth {
  /** `null` for subscriptions that no longer renew (cancelled, churned). */
  level: HealthLevel | null;
  factors: HealthFactor[];
}

/** Renewals due within this many hours escalate warnings to critical. */
export const DUE_SOON_HOURS = 72;
/** A balance or allowance covering fewer than this many cycles is a warning. */
export const LOW_COVERAGE_CYCLES = 2;
/** Retry count at which repeated pull failures become critical. */
export const CRITICAL_RETRY_COUNT = 2;

const NOT_RENEWING = new Set(["cancelled", "churned"]);

const FAILURE_FACTORS: Record<string, HealthFactorCode> = {
  insufficient_balance: "insufficient_balance",
  insufficient_allowance: "allowance_exhausted",
  expired_allowance: "allowance_expired",
};

const round = (value: number) => Math.round(value * 100) / 100;

function hoursUntil(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  return (at - now.getTime()) / 3_600_000;
}

export function assessSubscriberHealth(sub: HealthInput, now: Date = new Date()): SubscriberHealth {
  if (NOT_RENEWING.has(sub.status)) return { level: null, factors: [] };

  const factors = new Map<HealthFactorCode, HealthFactor>();
  const add = (factor: HealthFactor) => {
    const existing = factors.get(factor.code);
    if (!existing || (existing.severity === "warning" && factor.severity === "critical")) {
      factors.set(factor.code, factor);
    }
  };

  // Reason the last pull failed: observed on-chain, so it is critical.
  const failureCode = sub.lastFailure?.code && FAILURE_FACTORS[sub.lastFailure.code];
  if (failureCode) add({ code: failureCode, severity: "critical" });

  // Latest on-chain liquidity snapshot.
  const amount = Math.max(0, sub.amount);
  if (sub.liquidity && amount > 0) {
    const { balance, allowance } = sub.liquidity;
    if (balance < amount) {
      add({ code: "insufficient_balance", severity: "critical", params: { balance: round(balance), amount: round(amount) } });
    } else if (balance < amount * LOW_COVERAGE_CYCLES) {
      add({ code: "low_balance", severity: "warning", params: { balance: round(balance), amount: round(amount) } });
    }
    if (allowance < amount) {
      add({ code: "allowance_exhausted", severity: "critical", params: { allowance: round(allowance), amount: round(amount) } });
    } else if (allowance < amount * LOW_COVERAGE_CYCLES) {
      add({ code: "allowance_low", severity: "warning", params: { cycles: Math.floor(allowance / amount) } });
    }
  }

  // Dunning state.
  const retries = sub.retryCount ?? 0;
  if (sub.status === "past_due") add({ code: "past_due", severity: "critical" });
  if (retries >= CRITICAL_RETRY_COUNT) add({ code: "pull_failures", severity: "critical", params: { count: retries } });
  else if (retries > 0) add({ code: "pull_failures", severity: "warning", params: { count: retries } });

  // An imminent renewal leaves no time for a warning to resolve itself.
  const hours = hoursUntil(sub.nextBillingAt, now);
  const dueSoon = sub.status === "pending_pull" || (hours !== null && hours <= DUE_SOON_HOURS);
  if (dueSoon && factors.size > 0 && [...factors.values()].some((f) => f.severity === "warning")) {
    add({ code: "due_soon", severity: "critical", params: { hours: Math.max(0, Math.round(hours ?? 0)) } });
  }

  const list = [...factors.values()].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1,
  );
  const level: HealthLevel = list.some((f) => f.severity === "critical")
    ? "critical"
    : list.length > 0
      ? "warning"
      : "good";
  return { level, factors: list };
}

export interface ChurnRiskSummary {
  /** Renewing subscriptions that are warning or critical. */
  atRisk: number;
  critical: number;
  warning: number;
  /** Sum of the next-cycle amount of every at-risk subscription, in USDC. */
  revenueAtRisk: number;
  /** Same, for critical subscriptions only. */
  criticalRevenueAtRisk: number;
  /** Renewing subscriptions that were scored. */
  scored: number;
}

export function summarizeChurnRisk(
  subs: ReadonlyArray<HealthInput>,
  now: Date = new Date(),
): ChurnRiskSummary {
  const summary: ChurnRiskSummary = {
    atRisk: 0,
    critical: 0,
    warning: 0,
    revenueAtRisk: 0,
    criticalRevenueAtRisk: 0,
    scored: 0,
  };
  for (const sub of subs) {
    const { level } = assessSubscriberHealth(sub, now);
    if (level === null) continue;
    summary.scored += 1;
    if (level === "good") continue;
    summary.atRisk += 1;
    summary.revenueAtRisk += sub.amount;
    if (level === "critical") {
      summary.critical += 1;
      summary.criticalRevenueAtRisk += sub.amount;
    } else {
      summary.warning += 1;
    }
  }
  summary.revenueAtRisk = round(summary.revenueAtRisk);
  summary.criticalRevenueAtRisk = round(summary.criticalRevenueAtRisk);
  return summary;
}

/** Whether a balance reminder is worth sending: the risk is something the subscriber can fix. */
export function canSendBalanceReminder(health: SubscriberHealth): boolean {
  return health.factors.some((f) =>
    ["insufficient_balance", "low_balance", "allowance_exhausted", "allowance_low", "allowance_expired"].includes(f.code),
  );
}
