"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, HeartPulse, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ChurnRiskSummary, HealthFactor, SubscriberHealth } from "@/lib/subscriber-health";

const LEVEL_STYLES = {
  good: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  critical: "bg-red-50 text-red-700 border-red-200",
} as const;

const DOT_STYLES = {
  good: "bg-emerald-500",
  warning: "bg-amber-500",
  critical: "bg-red-500 animate-pulse",
} as const;

/** One translated, human-readable line per risk factor. */
export function useHealthFactorText() {
  const t = useTranslations("SubscriberHealth");
  return (factor: HealthFactor) => t(`factors.${factor.code}`, factor.params ?? {});
}

/**
 * Health badge for the subscribers table (#298). Hover or focus shows why the
 * subscriber is at risk; screen readers get the same text via aria-describedby.
 */
export function HealthBadge({ health }: { health: SubscriberHealth }) {
  const t = useTranslations("SubscriberHealth");
  const factorText = useHealthFactorText();
  const tooltipId = useId();

  if (health.level === null) {
    return <span className="text-[10px] font-mono text-neutral-400">{t("notScored")}</span>;
  }

  const lines = health.factors.length > 0 ? health.factors.map(factorText) : [t("noRisk")];

  return (
    <span className="relative inline-flex group">
      <span
        tabIndex={0}
        aria-describedby={tooltipId}
        className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border font-medium cursor-help outline-none focus-visible:ring-2 focus-visible:ring-black/30 ${LEVEL_STYLES[health.level]}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${DOT_STYLES[health.level]}`} aria-hidden="true" />
        {t(`level.${health.level}`)}
      </span>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-30 mt-1.5 w-64 rounded-lg border border-black/10 bg-white p-2.5 text-[11px] leading-snug text-neutral-700 shadow-lg opacity-0 invisible transition-opacity group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible"
      >
        <ul className="space-y-1">
          {lines.map((line) => (
            <li key={line} className="flex gap-1.5">
              <span aria-hidden="true">•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </span>
    </span>
  );
}

const formatUsdc = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * At-risk summary card (#298): how many renewing subscribers may churn and how
 * much next-cycle revenue that puts at risk.
 */
export function ChurnRiskCard({
  summary,
  isLoading,
  showingAtRisk,
  onToggleAtRisk,
}: {
  summary: ChurnRiskSummary;
  isLoading: boolean;
  showingAtRisk: boolean;
  onToggleAtRisk: () => void;
}) {
  const t = useTranslations("SubscriberHealth.card");

  if (isLoading || summary.scored === 0) return null;

  if (summary.atRisk === 0) {
    return (
      <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/60 text-xs text-emerald-900 flex items-center gap-3 shadow-xs">
        <ShieldCheck size={18} className="text-emerald-600 shrink-0" />
        <span>{t("allHealthy", { count: summary.scored })}</span>
      </div>
    );
  }

  const critical = summary.critical > 0;
  return (
    <section
      aria-label={t("title", { count: summary.atRisk })}
      className={`p-4 rounded-xl border shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4 ${critical ? "border-red-200 bg-red-50/60" : "border-amber-200 bg-amber-50/60"}`}
    >
      <div className="flex items-start gap-3 min-w-0">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${critical ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
          {critical ? <ShieldAlert size={18} /> : <AlertTriangle size={18} />}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-black flex items-center gap-1.5">
            <HeartPulse size={14} className="text-neutral-500" aria-hidden="true" />
            {t("title", { count: summary.atRisk })}
          </h3>
          <p className="text-xs text-neutral-600 mt-0.5">{t("subtitle")}</p>
          <div className="flex flex-wrap gap-2 mt-2 text-[11px] font-mono">
            {summary.critical > 0 && (
              <span className="px-2 py-0.5 rounded border bg-red-50 text-red-700 border-red-200">
                {t("critical", { count: summary.critical })}
              </span>
            )}
            {summary.warning > 0 && (
              <span className="px-2 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">
                {t("warning", { count: summary.warning })}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 md:gap-5 shrink-0">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{t("revenueLabel")}</div>
          <div className="text-xl font-bold text-black">
            {formatUsdc(summary.revenueAtRisk)} <span className="text-xs font-mono text-neutral-500">USDC</span>
          </div>
          {summary.critical > 0 && (
            <div className="text-[11px] text-red-700">
              {t("criticalRevenue", { amount: formatUsdc(summary.criticalRevenueAtRisk) })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleAtRisk}
          aria-pressed={showingAtRisk}
          className="button button-secondary text-xs h-9 px-3 whitespace-nowrap"
        >
          {showingAtRisk ? t("showAll") : t("viewAtRisk")}
        </button>
      </div>
    </section>
  );
}
