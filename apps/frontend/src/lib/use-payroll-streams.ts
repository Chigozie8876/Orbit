"use client";

import { useEffect, useState } from "react";
import type { PayrollStream } from "@/components/dashboard/views/streaming-payroll-panel";

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; streams: PayrollStream[] }
  | { status: "error"; message: string };

/**
 * Fetches active payroll streams for the current merchant (#291).
 * Re-fetches every `refreshIntervalMs` (default 30s) to pick up new streams
 * and updated withdrawn amounts.
 */
export function usePayrollStreams({
  apiKey,
  refreshIntervalMs = 30_000,
}: {
  apiKey?: string;
  refreshIntervalMs?: number;
}): { streams: PayrollStream[]; loading: boolean; error: string | null } {
  const [state, setState] = useState<FetchState>({ status: "idle" });

  useEffect(() => {
    if (!apiKey) {
      setState({ status: "ok", streams: [] });
      return;
    }

    let cancelled = false;

    const load = async () => {
      setState((prev) => (prev.status === "idle" ? { status: "loading" } : prev));
      try {
        const res = await fetch("/api/payroll/streams", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = (await res.json()) as { streams: PayrollStream[] };
        if (!cancelled) setState({ status: "ok", streams: json.streams ?? [] });
      } catch (err) {
        if (!cancelled)
          setState({ status: "error", message: err instanceof Error ? err.message : "Unknown error" });
      }
    };

    load();
    const interval = setInterval(load, refreshIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [apiKey, refreshIntervalMs]);

  return {
    streams: state.status === "ok" ? state.streams : [],
    loading: state.status === "loading",
    error: state.status === "error" ? state.message : null,
  };
}
