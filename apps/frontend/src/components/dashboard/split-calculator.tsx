"use client";

import React, { useState, useMemo } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import {
  PieChart,
  Download,
  Plus,
  Trash2,
  Lock,
  Unlock,
  Percent,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Sparkles,
  ArrowRight,
  Calculator,
  RefreshCw,
  Sliders,
} from "lucide-react";
import type { PayrollRecipient } from "./dashboard-types";

export interface SplitMember {
  id: string;
  name: string;
  role: string;
  walletAddress: string;
  percentage: number;
  isLocked: boolean;
  color: string;
}

const PALETTE = [
  "#10b981", // emerald
  "#6366f1", // indigo
  "#f59e0b", // amber
  "#ec4899", // pink
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#f97316", // orange
  "#06b6d4", // cyan
  "#84cc16", // lime
];

const INITIAL_MEMBERS: SplitMember[] = [
  {
    id: "split_charlie",
    name: "Charlie Vance",
    role: "Smart Contract Lead",
    walletAddress: "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
    percentage: 40,
    isLocked: false,
    color: PALETTE[0],
  },
  {
    id: "split_sarah",
    name: "Sarah Lin",
    role: "Frontend Engineer",
    walletAddress: "GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A",
    percentage: 30,
    isLocked: false,
    color: PALETTE[1],
  },
  {
    id: "split_david",
    name: "David Kim",
    role: "UI/UX Designer",
    walletAddress: "GAJ7J66Q66THHJ22WTBBEJUHHLVD7RZZW6KTVQDBBQYXRPVC4UFFQFDR",
    percentage: 30,
    isLocked: false,
    color: PALETTE[2],
  },
];

interface SplitCalculatorProps {
  onApplyToBatch?: (recipients: PayrollRecipient[]) => void;
}

export function SplitCalculator({ onApplyToBatch }: SplitCalculatorProps) {
  const [totalBudget, setTotalBudget] = useState<number>(10000);
  const [estimatedGas, setEstimatedGas] = useState<number>(0.01); // 0.01 USDC base reserve/gas per transfer
  const [members, setMembers] = useState<SplitMember[]>(INITIAL_MEMBERS);
  const [copiedCsv, setCopiedCsv] = useState(false);

  // Total allocated percentage
  const totalPercentage = useMemo(() => {
    return Number(members.reduce((acc, m) => acc + (Number(m.percentage) || 0), 0).toFixed(2));
  }, [members]);

  const isBalanced = Math.abs(totalPercentage - 100) < 0.01;
  const remainingPercentage = Number((100 - totalPercentage).toFixed(2));

  // Dynamic calculations: Gross amount, gas fee deduction, net amount
  const splitDetails = useMemo(() => {
    return members.map((m) => {
      const pct = Math.max(0, Number(m.percentage) || 0);
      const gross = (totalBudget * (pct / 100));
      const gasFee = pct > 0 ? estimatedGas : 0;
      const net = Math.max(0, gross - gasFee);
      return {
        ...m,
        grossUsdc: Number(gross.toFixed(2)),
        gasFeeUsdc: Number(gasFee.toFixed(4)),
        netUsdc: Number(net.toFixed(2)),
      };
    });
  }, [members, totalBudget, estimatedGas]);

  const totalGross = useMemo(() => {
    return splitDetails.reduce((acc, m) => acc + m.grossUsdc, 0);
  }, [splitDetails]);

  const totalFees = useMemo(() => {
    return splitDetails.reduce((acc, m) => acc + m.gasFeeUsdc, 0);
  }, [splitDetails]);

  const totalNet = useMemo(() => {
    return splitDetails.reduce((acc, m) => acc + m.netUsdc, 0);
  }, [splitDetails]);

  // Handle single member percentage change
  const handlePercentageChange = (id: string, newPct: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(newPct * 100) / 100));
    setMembers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, percentage: clamped } : m))
    );
  };

  // Lock toggle
  const toggleLock = (id: string) => {
    setMembers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, isLocked: !m.isLocked } : m))
    );
  };

  // Add member
  const handleAddMember = () => {
    const colorIndex = members.length % PALETTE.length;
    const newMember: SplitMember = {
      id: `split_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: `Contractor ${members.length + 1}`,
      role: "Contributor",
      walletAddress: "",
      percentage: remainingPercentage > 0 ? remainingPercentage : 0,
      isLocked: false,
      color: PALETTE[colorIndex],
    };
    setMembers((prev) => [...prev, newMember]);
  };

  // Remove member
  const handleRemoveMember = (id: string) => {
    if (members.length <= 1) return;
    setMembers((prev) => prev.filter((m) => m.id !== id));
  };

  // Split equally among unlocked members
  const handleEqualSplit = () => {
    const lockedTotal = members.filter((m) => m.isLocked).reduce((sum, m) => sum + m.percentage, 0);
    const unlockedMembers = members.filter((m) => !m.isLocked);
    if (unlockedMembers.length === 0) return;

    const available = Math.max(0, 100 - lockedTotal);
    const each = Number((available / unlockedMembers.length).toFixed(2));
    let remainder = Number((available - each * unlockedMembers.length).toFixed(2));

    setMembers((prev) =>
      prev.map((m) => {
        if (m.isLocked) return m;
        const addRem = remainder > 0 ? 0.01 : 0;
        if (remainder > 0) remainder = Number((remainder - 0.01).toFixed(2));
        return { ...m, percentage: Number((each + addRem).toFixed(2)) };
      })
    );
  };

  // Normalize to exactly 100%
  const handleNormalizeTo100 = () => {
    const lockedTotal = members.filter((m) => m.isLocked).reduce((sum, m) => sum + m.percentage, 0);
    const unlockedMembers = members.filter((m) => !m.isLocked);
    if (unlockedMembers.length === 0 || lockedTotal >= 100) return;

    const currentUnlockedSum = unlockedMembers.reduce((sum, m) => sum + m.percentage, 0);
    const available = 100 - lockedTotal;

    if (currentUnlockedSum === 0) {
      handleEqualSplit();
      return;
    }

    let runningSum = 0;
    const newMembers = members.map((m, idx) => {
      if (m.isLocked) return m;
      const normalized = Number(((m.percentage / currentUnlockedSum) * available).toFixed(2));
      runningSum += normalized;
      return { ...m, percentage: normalized };
    });

    // Fix rounding drift
    const drift = Number((100 - (lockedTotal + runningSum)).toFixed(2));
    if (drift !== 0) {
      const firstUnlockedIndex = newMembers.findIndex((m) => !m.isLocked);
      if (firstUnlockedIndex >= 0) {
        newMembers[firstUnlockedIndex].percentage = Number(
          (newMembers[firstUnlockedIndex].percentage + drift).toFixed(2)
        );
      }
    }

    setMembers(newMembers);
  };

  // 1-Click Export to CSV matching Orbit Batch Payroll Import Schema
  // Schema: Name,Role,StellarWallet,AmountUSDC
  const handleExportCSV = () => {
    const header = "Name,Role,StellarWallet,AmountUSDC";
    const rows = splitDetails.map((m) => {
      const safeName = `"${m.name.replace(/"/g, '""')}"`;
      const safeRole = `"${m.role.replace(/"/g, '""')}"`;
      const wallet = m.walletAddress.trim();
      const amount = m.netUsdc.toFixed(2);
      return `${safeName},${safeRole},${wallet},${amount}`;
    });

    const csvContent = [header, ...rows].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `orbit_split_payroll_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setCopiedCsv(true);
    setTimeout(() => setCopiedCsv(false), 2500);
  };

  // Apply to current batch table
  const handleApplyToBatch = () => {
    if (!onApplyToBatch) return;
    const recipients: PayrollRecipient[] = splitDetails.map((m, i) => ({
      id: `rec_split_${Date.now()}_${i}`,
      name: m.name,
      role: m.role,
      walletAddress: m.walletAddress.trim(),
      amount: m.netUsdc,
      network: "stellar-testnet",
      status: StrKey.isValidEd25519PublicKey(m.walletAddress.trim()) && m.netUsdc > 0 ? "ready" : "failed",
    }));
    onApplyToBatch(recipients);
  };

  // Donut chart calculations (Radius = 70, Circumference = 439.82)
  const RADIUS = 70;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  let cumulativeOffset = 0;
  const donutSlices = splitDetails.map((m) => {
    const slicePct = Math.max(0, m.percentage);
    const strokeDash = (slicePct / 100) * CIRCUMFERENCE;
    const offset = cumulativeOffset;
    cumulativeOffset += strokeDash;
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      strokeDasharray: `${strokeDash} ${CIRCUMFERENCE - strokeDash}`,
      strokeDashoffset: -offset,
      percentage: m.percentage,
      netUsdc: m.netUsdc,
    };
  });

  return (
    <div className="rounded-2xl border border-black/15 bg-white p-5 md:p-6 shadow-xs space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-black/10 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-indigo-50 text-indigo-700">
              <Calculator size={18} />
            </div>
            <h3 className="text-lg font-bold text-black tracking-tight">
              Interactive Team Split Calculator
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 font-bold">
              ESTIMATOR
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-1">
            Divide total payroll budgets by percentage, verify gross vs net USDC amounts, and deduct estimated network gas fees before submitting.
          </p>
        </div>

        {/* Global Controls & 1-Click Export */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleEqualSplit}
            className="button button-secondary text-xs h-8 px-2.5 flex items-center gap-1.5"
            title="Split remaining percentages equally"
          >
            <RefreshCw size={12} />
            <span>Equal Split</span>
          </button>
          <button
            type="button"
            onClick={handleNormalizeTo100}
            className="button button-secondary text-xs h-8 px-2.5 flex items-center gap-1.5"
            title="Normalize unlocked splits to exactly 100%"
          >
            <Sliders size={12} />
            <span>Lock to 100%</span>
          </button>
          <button
            type="button"
            onClick={handleExportCSV}
            className="button button-secondary text-xs h-8 px-3 flex items-center gap-1.5 font-semibold text-emerald-800 bg-emerald-50 border-emerald-300 hover:bg-emerald-100"
            title="Download CSV formatted for Orbit Batch Payroll"
          >
            <Download size={13} />
            <span>{copiedCsv ? "Exported!" : "1-Click CSV Export"}</span>
          </button>
          {onApplyToBatch && (
            <button
              type="button"
              onClick={handleApplyToBatch}
              className="button button-primary text-xs h-8 px-3 flex items-center gap-1.5"
              title="Populate batch payroll table with this distribution"
            >
              <span>Apply to Batch</span>
              <ArrowRight size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Budget & Gas Inputs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl border border-black/10 bg-neutral-50">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 block mb-1">
            Total Budget (USDC)
          </label>
          <div className="relative">
            <input
              type="number"
              min="0"
              step="any"
              value={totalBudget}
              onChange={(e) => setTotalBudget(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-full text-lg font-bold font-mono pl-3 pr-12 py-1.5 rounded-lg border border-black/20 bg-white focus:outline-indigo-600"
            />
            <span className="absolute right-3 top-2 text-xs font-bold text-neutral-400 font-mono">
              USDC
            </span>
          </div>
        </div>

        <div className="p-4 rounded-xl border border-black/10 bg-neutral-50">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 block mb-1">
            Network Gas / Base Fee per Tx
          </label>
          <div className="relative">
            <input
              type="number"
              min="0"
              step="0.0001"
              value={estimatedGas}
              onChange={(e) => setEstimatedGas(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-full text-lg font-bold font-mono pl-3 pr-12 py-1.5 rounded-lg border border-black/20 bg-white focus:outline-indigo-600"
            />
            <span className="absolute right-3 top-2 text-xs font-bold text-neutral-400 font-mono">
              USDC
            </span>
          </div>
        </div>

        {/* Validation Status Card */}
        <div className={`p-4 rounded-xl border flex flex-col justify-between ${
          isBalanced
            ? "border-emerald-300 bg-emerald-50/70"
            : totalPercentage > 100
            ? "border-red-300 bg-red-50/70"
            : "border-amber-300 bg-amber-50/70"
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-600">
              Allocation Status
            </span>
            {isBalanced ? (
              <span className="flex items-center gap-1 text-xs font-bold text-emerald-800">
                <CheckCircle2 size={14} className="text-emerald-600" />
                100% Balanced
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-bold text-amber-800">
                <AlertCircle size={14} className={totalPercentage > 100 ? "text-red-600" : "text-amber-600"} />
                {totalPercentage > 100 ? `Over by ${(totalPercentage - 100).toFixed(1)}%` : `${remainingPercentage}% Left`}
              </span>
            )}
          </div>
          <div className="text-2xl font-bold font-mono tracking-tight text-black mt-1">
            {totalPercentage.toFixed(1)}%{" "}
            <span className="text-xs font-normal text-neutral-500">/ 100%</span>
          </div>
        </div>
      </div>

      {/* Main Split Section: Left Donut Chart, Right Member Sliders */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Donut Chart Visualization */}
        <div className="lg:col-span-5 p-5 rounded-xl border border-black/10 bg-neutral-50/50 flex flex-col items-center justify-center">
          <div className="relative w-52 h-52 flex items-center justify-center">
            <svg viewBox="0 0 160 160" className="w-full h-full -rotate-90 transform">
              {/* Background ring */}
              <circle
                cx="80"
                cy="80"
                r={RADIUS}
                fill="transparent"
                stroke="#e5e7eb"
                strokeWidth="16"
              />
              {/* Animated/Reactive Donut Slices */}
              {donutSlices.map((slice) => (
                <circle
                  key={slice.id}
                  cx="80"
                  cy="80"
                  r={RADIUS}
                  fill="transparent"
                  stroke={slice.color}
                  strokeWidth="16"
                  strokeDasharray={slice.strokeDasharray}
                  strokeDashoffset={slice.strokeDashoffset}
                  strokeLinecap="round"
                  className="transition-all duration-150 ease-out"
                />
              ))}
            </svg>

            {/* Inner Center Content */}
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none p-4">
              <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-400">
                Net Disbursed
              </span>
              <span className="text-lg font-bold font-mono text-black leading-tight">
                ${totalNet.toLocaleString("en-US", { minimumFractionDigits: 2 })}
              </span>
              <span className="text-[10px] font-mono text-neutral-500 mt-0.5">
                Fees: -${totalFees.toFixed(3)}
              </span>
            </div>
          </div>

          {/* Quick Donut Legend */}
          <div className="w-full mt-4 space-y-1.5 max-h-40 overflow-y-auto pr-1">
            {splitDetails.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-xs py-1 border-b border-black/5 last:border-0">
                <div className="flex items-center gap-2 truncate">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
                  <span className="font-semibold text-neutral-800 truncate">{m.name}</span>
                </div>
                <div className="flex items-center gap-2 font-mono shrink-0">
                  <span className="text-neutral-500">{m.percentage.toFixed(1)}%</span>
                  <span className="font-bold text-black">${m.netUsdc.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Team Member Sliders and Gross/Net Calculation Table */}
        <div className="lg:col-span-7 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-600">
              Team Allocations ({members.length} Members)
            </h4>
            <button
              type="button"
              onClick={handleAddMember}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 cursor-pointer"
            >
              <Plus size={13} />
              <span>Add Member</span>
            </button>
          </div>

          <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
            {splitDetails.map((m) => {
              const isInvalidWallet = m.walletAddress.trim() && !StrKey.isValidEd25519PublicKey(m.walletAddress.trim());

              return (
                <div
                  key={m.id}
                  className="p-3.5 rounded-xl border border-black/10 bg-white hover:border-black/25 transition-all space-y-2.5 shadow-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
                      <input
                        type="text"
                        value={m.name}
                        onChange={(e) => {
                          const val = e.target.value;
                          setMembers((prev) => prev.map((item) => (item.id === m.id ? { ...item, name: val } : item)));
                        }}
                        className="text-xs font-bold text-black border-b border-transparent hover:border-black/20 focus:border-indigo-600 focus:outline-hidden py-0.5"
                        placeholder="Member Name"
                      />
                      <input
                        type="text"
                        value={m.role}
                        onChange={(e) => {
                          const val = e.target.value;
                          setMembers((prev) => prev.map((item) => (item.id === m.id ? { ...item, role: val } : item)));
                        }}
                        className="text-[11px] text-neutral-500 border-b border-transparent hover:border-black/20 focus:border-indigo-600 focus:outline-hidden py-0.5 hidden sm:inline"
                        placeholder="Role / Title"
                      />
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleLock(m.id)}
                        className={`p-1 rounded-md text-xs transition-colors ${
                          m.isLocked ? "bg-amber-100 text-amber-800" : "text-neutral-400 hover:text-black hover:bg-neutral-100"
                        }`}
                        title={m.isLocked ? "Locked percentage" : "Unlocked (auto-balances)"}
                      >
                        {m.isLocked ? <Lock size={12} /> : <Unlock size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveMember(m.id)}
                        disabled={members.length <= 1}
                        className="p-1 rounded-md text-neutral-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 transition-colors"
                        title="Remove member"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Wallet address */}
                  <div>
                    <input
                      type="text"
                      value={m.walletAddress}
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        setMembers((prev) => prev.map((item) => (item.id === m.id ? { ...item, walletAddress: val } : item)));
                      }}
                      placeholder="Stellar Public Key (G...)"
                      className={`w-full text-[11px] font-mono px-2 py-1 rounded border ${
                        isInvalidWallet
                          ? "border-red-400 bg-red-50 text-red-950"
                          : "border-black/10 bg-neutral-50 text-neutral-700"
                      } focus:outline-indigo-600`}
                    />
                    {isInvalidWallet && (
                      <span className="text-[10px] text-red-600 mt-0.5 block">Invalid Stellar Ed25519 address</span>
                    )}
                  </div>

                  {/* Slider & Percentage Input */}
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="0.5"
                      value={m.percentage}
                      onChange={(e) => handlePercentageChange(m.id, parseFloat(e.target.value) || 0)}
                      className="flex-1 accent-indigo-600 h-1.5 bg-neutral-200 rounded-lg cursor-pointer"
                    />
                    <div className="flex items-center gap-1 w-20 shrink-0">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={m.percentage}
                        onChange={(e) => handlePercentageChange(m.id, parseFloat(e.target.value) || 0)}
                        className="w-14 text-right text-xs font-bold font-mono px-1.5 py-0.5 rounded border border-black/20 bg-white"
                      />
                      <span className="text-xs text-neutral-500 font-mono">%</span>
                    </div>
                  </div>

                  {/* Gross vs Net Breakdown */}
                  <div className="flex items-center justify-between text-[11px] pt-1.5 border-t border-black/5 font-mono text-neutral-600">
                    <div>Gross: <span className="font-semibold text-black">${m.grossUsdc.toFixed(2)}</span></div>
                    <div>Gas: <span className="text-neutral-500">-${m.gasFeeUsdc.toFixed(4)}</span></div>
                    <div>Net: <span className="font-bold text-emerald-700">${m.netUsdc.toFixed(2)} USDC</span></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
