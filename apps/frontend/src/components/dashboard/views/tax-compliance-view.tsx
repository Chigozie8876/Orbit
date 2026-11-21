"use client";

import React, { useState, useEffect, useMemo } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import {
  ShieldCheck,
  Building2,
  FileText,
  Download,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Copy,
  Check,
  Save,
  Plus,
  RefreshCw,
  Search,
  Users,
  DollarSign,
  Globe,
  Receipt,
  FileSpreadsheet,
} from "lucide-react";
import {
  MerchantTaxProfile,
  ContractorTaxRecord,
  SettledBatchDisbursement,
  YearToDateTaxSummary,
  loadTaxProfile,
  saveTaxProfile,
  loadContractorTaxRecords,
  saveContractorTaxRecord,
  calculateYearToDateSummaries,
  generate1099NecCsv,
  generateInternationalVatCsv,
  downloadCsvFile,
} from "@/lib/tax-compliance";
import { useAuth } from "@/lib/auth-context";

// Sample settled batch disbursements for year-to-date calculation demo
const SAMPLE_DISBURSEMENTS: SettledBatchDisbursement[] = [
  {
    contractorWallet: "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
    legalName: "Charlie Vance",
    amountUsdc: 2500.0,
    settledAt: "2026-02-15T18:30:00Z",
    txHash: "4f7e2a9b1c8d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f",
  },
  {
    contractorWallet: "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
    legalName: "Charlie Vance",
    amountUsdc: 3000.0,
    settledAt: "2026-05-15T18:30:00Z",
    txHash: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b",
  },
  {
    contractorWallet: "GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A",
    legalName: "Sarah Lin",
    amountUsdc: 4200.0,
    settledAt: "2026-03-20T14:15:00Z",
    txHash: "8b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f4f7e2a9b1c8d3e5f7a",
  },
  {
    contractorWallet: "GAJ7J66Q66THHJ22WTBBEJUHHLVD7RZZW6KTVQDBBQYXRPVC4UFFQFDR",
    legalName: "David Kim",
    amountUsdc: 1800.0,
    settledAt: "2026-04-10T11:00:00Z",
    txHash: "7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b",
  },
  {
    contractorWallet: "GBDXVD27PJS4PVC5USFBSJUTTYVXIH6MS6MM6M2IDCXJWJHEPRTTIQNP",
    legalName: "Elena Rostova",
    amountUsdc: 850.0,
    settledAt: "2026-06-01T09:45:00Z",
    txHash: "3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d",
  },
];

const DEFAULT_CONTRACTORS: ContractorTaxRecord[] = [
  {
    walletAddress: "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
    legalName: "Charlie Vance",
    country: "US",
    taxId: "12-3456789",
    taxForm: "W-9",
    withholdingExempt: false,
    submittedAt: "2026-01-10T12:00:00Z",
  },
  {
    walletAddress: "GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A",
    legalName: "Sarah Lin",
    country: "US",
    taxId: "98-7654321",
    taxForm: "W-9",
    withholdingExempt: false,
    submittedAt: "2026-01-12T15:30:00Z",
  },
  {
    walletAddress: "GAJ7J66Q66THHJ22WTBBEJUHHLVD7RZZW6KTVQDBBQYXRPVC4UFFQFDR",
    legalName: "David Kim",
    country: "KR",
    taxId: "KR-891011",
    taxForm: "W-8BEN",
    withholdingExempt: true,
    submittedAt: "2026-02-01T08:00:00Z",
  },
  {
    walletAddress: "GBDXVD27PJS4PVC5USFBSJUTTYVXIH6MS6MM6M2IDCXJWJHEPRTTIQNP",
    legalName: "Elena Rostova",
    country: "EE",
    taxId: "",
    taxForm: "pending",
    withholdingExempt: false,
    submittedAt: null,
  },
];

export function TaxComplianceView() {
  const { user } = useAuth();
  const merchantId = user?.id || "demo_merchant";

  // Corporate Profile State
  const [profile, setProfile] = useState<MerchantTaxProfile>({
    businessLegalName: user?.businessName || "Orbit DAO LLC",
    registeredEntityAddress: "100 Montgomery St, Suite 2400",
    city: "San Francisco",
    stateProvince: "CA",
    postalCode: "94104",
    country: "US",
    taxId: "84-2194812",
    vatNumber: "",
  });

  const [isSavedNotice, setIsSavedNotice] = useState(false);
  const [contractors, setContractors] = useState<ContractorTaxRecord[]>(DEFAULT_CONTRACTORS);
  const [selectedYear, setSelectedYear] = useState<number>(2026);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"profile" | "forms" | "summary">("summary");
  const [searchQuery, setSearchQuery] = useState("");

  // Load saved data from localStorage on mount
  useEffect(() => {
    const savedProf = loadTaxProfile(merchantId);
    if (savedProf) {
      setProfile(savedProf);
    }
    const savedContractors = loadContractorTaxRecords(merchantId);
    if (savedContractors && savedContractors.length > 0) {
      setContractors(savedContractors);
    }
  }, [merchantId]);

  // Save tax profile
  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    saveTaxProfile(merchantId, profile);
    setIsSavedNotice(true);
    setTimeout(() => setIsSavedNotice(false), 2500);
  };

  // Toggle or update tax form for a contractor
  const handleUpdateForm = (
    walletAddress: string,
    formType: "W-9" | "W-8BEN" | "pending"
  ) => {
    setContractors((prev) => {
      const updated = prev.map((c) => {
        if (c.walletAddress.toLowerCase() === walletAddress.toLowerCase()) {
          const newRec: ContractorTaxRecord = {
            ...c,
            taxForm: formType,
            submittedAt: formType !== "pending" ? new Date().toISOString() : null,
          };
          saveContractorTaxRecord(merchantId, newRec);
          return newRec;
        }
        return c;
      });
      return updated;
    });
  };

  // Toggle withholding exempt
  const handleToggleExempt = (walletAddress: string) => {
    setContractors((prev) => {
      const updated = prev.map((c) => {
        if (c.walletAddress.toLowerCase() === walletAddress.toLowerCase()) {
          const newRec: ContractorTaxRecord = {
            ...c,
            withholdingExempt: !c.withholdingExempt,
          };
          saveContractorTaxRecord(merchantId, newRec);
          return newRec;
        }
        return c;
      });
      return updated;
    });
  };

  // Copy helper
  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  // Year to date calculations
  const ytdSummaries = useMemo(() => {
    return calculateYearToDateSummaries(SAMPLE_DISBURSEMENTS, contractors, selectedYear);
  }, [contractors, selectedYear]);

  // Filtered summaries
  const filteredSummaries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return ytdSummaries;
    return ytdSummaries.filter(
      (s) =>
        s.legalName.toLowerCase().includes(query) ||
        s.contractorAddress.toLowerCase().includes(query) ||
        s.country.toLowerCase().includes(query)
    );
  }, [ytdSummaries, searchQuery]);

  // Summary Metrics
  const totalReportableUsdc = useMemo(() => {
    return ytdSummaries.reduce((sum, s) => sum + s.totalDisbursedUsdc, 0);
  }, [ytdSummaries]);

  const totalWithheldUsdc = useMemo(() => {
    return ytdSummaries.reduce((sum, s) => sum + s.withholdingAmountUsdc, 0);
  }, [ytdSummaries]);

  const collectedFormsCount = useMemo(() => {
    return ytdSummaries.filter((s) => s.formSubmitted).length;
  }, [ytdSummaries]);

  const pendingFormsCount = useMemo(() => {
    return ytdSummaries.filter((s) => !s.formSubmitted && s.totalDisbursedUsdc >= 600).length;
  }, [ytdSummaries]);

  // 1-Click Exports
  const handleDownload1099Nec = () => {
    const csv = generate1099NecCsv(ytdSummaries, profile, selectedYear);
    downloadCsvFile(csv, `orbit_irs_1099_nec_${selectedYear}.csv`);
  };

  const handleDownloadVat = () => {
    const csv = generateInternationalVatCsv(ytdSummaries, profile, selectedYear);
    downloadCsvFile(csv, `orbit_international_vat_summary_${selectedYear}.csv`);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-black/10 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-emerald-50 text-emerald-700">
              <ShieldCheck size={20} />
            </div>
            <h2 className="text-xl font-bold tracking-tight text-black">
              Tax & Compliance Hub
            </h2>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-black text-white font-bold">
              IRS 1099 & VAT
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-1">
            Maintain corporate tax identification, collect vendor W-9 & W-8BEN compliance forms, and generate audit-ready year-end filings.
          </p>
        </div>

        {/* 1-Click Export Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleDownload1099Nec}
            className="button button-secondary text-xs h-9 px-3 flex items-center gap-1.5 font-semibold text-emerald-800 bg-emerald-50 border-emerald-300 hover:bg-emerald-100"
            title="Download IRS 1099-NEC standard financial CSV"
          >
            <Download size={13} />
            <span>IRS 1099-NEC CSV</span>
          </button>
          <button
            type="button"
            onClick={handleDownloadVat}
            className="button button-secondary text-xs h-9 px-3 flex items-center gap-1.5 font-semibold text-blue-800 bg-blue-50 border-blue-300 hover:bg-blue-100"
            title="Download International B2B / VAT Reverse Charge CSV"
          >
            <Globe size={13} />
            <span>International VAT CSV</span>
          </button>
        </div>
      </div>

      {/* Ribbon Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl border border-black/10 bg-white shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            {selectedYear} Total Disbursed
          </div>
          <div className="text-2xl font-bold text-black mt-1 font-mono tracking-tight">
            ${totalReportableUsdc.toLocaleString("en-US", { minimumFractionDigits: 2 })}{" "}
            <span className="text-xs font-normal text-neutral-500">USDC</span>
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5">
            Across {ytdSummaries.length} contractor wallets
          </div>
        </div>

        <div className="p-4 rounded-xl border border-black/10 bg-white shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Compliance Collection Rate
          </div>
          <div className="text-2xl font-bold text-emerald-700 mt-1 font-mono tracking-tight">
            {ytdSummaries.length > 0
              ? `${Math.round((collectedFormsCount / ytdSummaries.length) * 100)}%`
              : "100%"}
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5">
            {collectedFormsCount} of {ytdSummaries.length} tax forms on file
          </div>
        </div>

        <div className="p-4 rounded-xl border border-black/10 bg-white shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Statutory Backup Withholding
          </div>
          <div className="text-2xl font-bold text-black mt-1 font-mono tracking-tight">
            ${totalWithheldUsdc.toLocaleString("en-US", { minimumFractionDigits: 2 })}{" "}
            <span className="text-xs font-normal text-neutral-500">USDC</span>
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5">
            {pendingFormsCount > 0
              ? `${pendingFormsCount} contractor(s) missing W-9/W-8`
              : "All active recipients compliant"}
          </div>
        </div>

        <div className="p-4 rounded-xl border border-black/10 bg-white shadow-xs flex flex-col justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Reporting Tax Year
          </div>
          <div className="flex items-center gap-2 mt-1">
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(parseInt(e.target.value, 10))}
              className="w-full text-sm font-bold font-mono px-3 py-1.5 rounded-lg border border-black/20 bg-neutral-50 focus:outline-indigo-600"
            >
              <option value={2026}>Tax Year 2026 (Current)</option>
              <option value={2025}>Tax Year 2025</option>
              <option value={2024}>Tax Year 2024</option>
            </select>
          </div>
        </div>
      </div>

      {/* Segment Navigation */}
      <div className="flex items-center gap-2 border-b border-black/10 pb-2">
        <button
          type="button"
          onClick={() => setActiveTab("summary")}
          className={`text-xs px-4 py-2 font-semibold rounded-lg transition-all ${
            activeTab === "summary"
              ? "bg-black text-white shadow-xs"
              : "text-neutral-600 hover:text-black hover:bg-neutral-100"
          }`}
        >
          Year-to-Date Compensation Summary
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("forms")}
          className={`text-xs px-4 py-2 font-semibold rounded-lg transition-all flex items-center gap-1.5 ${
            activeTab === "forms"
              ? "bg-black text-white shadow-xs"
              : "text-neutral-600 hover:text-black hover:bg-neutral-100"
          }`}
        >
          <span>Vendor Tax Form Collection (W-9 / W-8BEN)</span>
          {pendingFormsCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
              {pendingFormsCount} Pending
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("profile")}
          className={`text-xs px-4 py-2 font-semibold rounded-lg transition-all ${
            activeTab === "profile"
              ? "bg-black text-white shadow-xs"
              : "text-neutral-600 hover:text-black hover:bg-neutral-100"
          }`}
        >
          Corporate Tax Profile Settings
        </button>
      </div>

      {/* 1. Year-to-Date Tax Summary View */}
      {activeTab === "summary" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search size={14} className="absolute left-3 top-2.5 text-neutral-400" />
              <input
                type="text"
                placeholder="Search contractor name, wallet, or country..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-black/15 bg-white focus:outline-indigo-600"
              />
            </div>
            <div className="text-xs text-neutral-500 font-mono">
              Showing {filteredSummaries.length} records for Tax Year {selectedYear}
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-black/10 bg-white shadow-xs">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-neutral-50 border-b border-black/10 text-neutral-600 font-semibold">
                  <th className="py-3 px-4">Contractor Legal Name</th>
                  <th className="py-3 px-4">Stellar Public Address</th>
                  <th className="py-3 px-4">Tax Form</th>
                  <th className="py-3 px-4 text-right">Total Disbursed</th>
                  <th className="py-3 px-4 text-center">Backup Withholding</th>
                  <th className="py-3 px-4 text-right">Withheld Amount</th>
                  <th className="py-3 px-4 text-right">Net Compensation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {filteredSummaries.map((s) => (
                  <tr key={s.contractorAddress} className="hover:bg-neutral-50/60 transition-colors">
                    <td className="py-3 px-4 font-semibold text-black">
                      <div className="flex items-center gap-1.5">
                        <span>{s.legalName}</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-neutral-100 text-neutral-600 font-mono">
                          {s.country}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-neutral-600">
                      <div className="flex items-center gap-1.5">
                        <a
                          href={`https://stellar.expert/explorer/testnet/account/${s.contractorAddress}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-black hover:underline inline-flex items-center gap-0.5"
                          title="View on Stellar Expert"
                        >
                          {s.contractorAddress.slice(0, 6)}...{s.contractorAddress.slice(-6)}
                          <ExternalLink size={10} className="text-neutral-400" />
                        </a>
                        <button
                          type="button"
                          onClick={() => handleCopy(s.contractorAddress, s.contractorAddress)}
                          className="text-neutral-400 hover:text-black cursor-pointer"
                          title="Copy address"
                        >
                          {copiedKey === s.contractorAddress ? (
                            <Check size={11} className="text-emerald-600" />
                          ) : (
                            <Copy size={11} />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {s.taxForm === "W-9" ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                          <CheckCircle2 size={10} />
                          W-9 (US)
                        </span>
                      ) : s.taxForm === "W-8BEN" ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-800 border border-blue-200">
                          <Globe size={10} />
                          W-8BEN (Foreign)
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-800 border border-amber-300">
                          <AlertTriangle size={10} />
                          Pending Form
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-black">
                      ${s.totalDisbursedUsdc.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {s.withholdingRequired ? (
                        <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-red-100 text-red-800 border border-red-200">
                          24% Mandatory
                        </span>
                      ) : (
                        <span className="text-[11px] text-neutral-400 font-mono">Exempt / Verified</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-red-700 font-semibold">
                      {s.withholdingAmountUsdc > 0
                        ? `-$${s.withholdingAmountUsdc.toFixed(2)}`
                        : "$0.00"}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-emerald-700">
                      ${s.netDisbursedUsdc.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 2. Vendor Tax Form Collection View */}
      {activeTab === "forms" && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl border border-black/10 bg-neutral-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-black">
                Vendor Compliance & Form Status (W-9 / W-8BEN)
              </h4>
              <p className="text-xs text-neutral-500 mt-0.5">
                Flag verified contractor tax forms to remove mandatory 24% IRS backup withholding.
              </p>
            </div>
            <div className="text-xs font-semibold text-neutral-700">
              {collectedFormsCount} of {contractors.length} Verified
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-black/10 bg-white shadow-xs">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-neutral-50 border-b border-black/10 text-neutral-600 font-semibold">
                  <th className="py-3 px-4">Contractor</th>
                  <th className="py-3 px-4">Stellar Wallet</th>
                  <th className="py-3 px-4">Country</th>
                  <th className="py-3 px-4">Tax Form Flag</th>
                  <th className="py-3 px-4">Status & Verified Date</th>
                  <th className="py-3 px-4 text-center">Backup Withholding Exempt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {contractors.map((c) => (
                  <tr key={c.walletAddress} className="hover:bg-neutral-50/60 transition-colors">
                    <td className="py-3 px-4 font-semibold text-black">{c.legalName}</td>
                    <td className="py-3 px-4 font-mono text-[11px] text-neutral-600">
                      {c.walletAddress.slice(0, 8)}...{c.walletAddress.slice(-6)}
                    </td>
                    <td className="py-3 px-4 font-mono">{c.country}</td>
                    <td className="py-3 px-4">
                      <select
                        value={c.taxForm}
                        onChange={(e) =>
                          handleUpdateForm(c.walletAddress, e.target.value as "W-9" | "W-8BEN" | "pending")
                        }
                        className="text-xs font-semibold px-2 py-1 rounded border border-black/20 bg-white focus:outline-indigo-600"
                      >
                        <option value="W-9">Form W-9 (US Citizen/Entity)</option>
                        <option value="W-8BEN">Form W-8BEN (Foreign Individual/Entity)</option>
                        <option value="pending">Pending Form Collection</option>
                      </select>
                    </td>
                    <td className="py-3 px-4 text-[11px] font-mono text-neutral-600">
                      {c.submittedAt ? (
                        <span className="text-emerald-700 flex items-center gap-1 font-semibold">
                          <CheckCircle2 size={12} />
                          Verified ({new Date(c.submittedAt).toLocaleDateString()})
                        </span>
                      ) : (
                        <span className="text-amber-700 font-semibold flex items-center gap-1">
                          <AlertTriangle size={12} />
                          Awaiting Form
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <input
                        type="checkbox"
                        checked={c.withholdingExempt}
                        onChange={() => handleToggleExempt(c.walletAddress)}
                        className="accent-indigo-600 rounded cursor-pointer"
                        title="Toggle backup withholding exemption"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. Corporate Tax Profile Settings */}
      {activeTab === "profile" && (
        <form onSubmit={handleSaveProfile} className="p-6 rounded-2xl border border-black/10 bg-white shadow-xs space-y-6 max-w-2xl">
          <div className="flex items-center justify-between border-b border-black/10 pb-4">
            <div className="flex items-center gap-2">
              <Building2 size={18} className="text-neutral-700" />
              <h3 className="text-base font-bold text-black">
                Entity Tax Profile Settings
              </h3>
            </div>
            {isSavedNotice && (
              <span className="text-xs font-bold text-emerald-700 flex items-center gap-1 bg-emerald-50 px-2 py-1 rounded-md border border-emerald-200">
                <CheckCircle2 size={13} />
                Saved Corporate Details Securely
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="text-xs font-bold text-neutral-700 block mb-1">
                Business Legal Name *
              </label>
              <input
                type="text"
                required
                value={profile.businessLegalName}
                onChange={(e) => setProfile((p) => ({ ...p, businessLegalName: e.target.value }))}
                placeholder="e.g. Acme Corporation LLC"
                className="w-full text-xs px-3 py-2 rounded-lg border border-black/20 bg-white focus:outline-indigo-600"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="text-xs font-bold text-neutral-700 block mb-1">
                Registered Entity Address *
              </label>
              <input
                type="text"
                required
                value={profile.registeredEntityAddress}
                onChange={(e) => setProfile((p) => ({ ...p, registeredEntityAddress: e.target.value }))}
                placeholder="Street address, Suite, PO Box"
                className="w-full text-xs px-3 py-2 rounded-lg border border-black/20 bg-white focus:outline-indigo-600"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-neutral-700 block mb-1">
                City / Municipality
              </label>
              <input
                type="text"
                value={profile.city || ""}
                onChange={(e) => setProfile((p) => ({ ...p, city: e.target.value }))}
                placeholder="City"
                className="w-full text-xs px-3 py-2 rounded-lg border border-black/20 bg-white focus:outline-indigo-600"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-neutral-700 block mb-1">
                Country *
              </label>
              <select
                value={profile.country}
                onChange={(e) => setProfile((p) => ({ ...p, country: e.target.value }))}
                className="w-full text-xs px-3 py-2 rounded-lg border border-black/20 bg-white focus:outline-indigo-600 font-semibold"
              >
                <option value="US">United States (US)</option>
                <option value="GB">United Kingdom (GB)</option>
                <option value="DE">Germany (DE)</option>
                <option value="FR">France (FR)</option>
                <option value="CA">Canada (CA)</option>
                <option value="SG">Singapore (SG)</option>
                <option value="CH">Switzerland (CH)</option>
                <option value="EE">Estonia (EE)</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-bold text-neutral-700 block mb-1">
                Tax Identification Number (EIN / TIN) *
              </label>
              <input
                type="text"
                required
                value={profile.taxId}
                onChange={(e) => setProfile((p) => ({ ...p, taxId: e.target.value }))}
                placeholder="e.g. 12-3456789"
                className="w-full text-xs font-mono px-3 py-2 rounded-lg border border-black/20 bg-white focus:outline-indigo-600"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-neutral-700 block mb-1">
                International VAT Number (Optional)
              </label>
              <input
                type="text"
                value={profile.vatNumber || ""}
                onChange={(e) => setProfile((p) => ({ ...p, vatNumber: e.target.value }))}
                placeholder="e.g. EU123456789"
                className="w-full text-xs font-mono px-3 py-2 rounded-lg border border-black/20 bg-white focus:outline-indigo-600"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-black/10 flex items-center justify-between">
            <span className="text-[11px] text-neutral-400">
              {profile.updatedAt ? `Last saved: ${new Date(profile.updatedAt).toLocaleString()}` : "Not saved yet"}
            </span>
            <button
              type="submit"
              className="button button-primary text-xs h-9 px-4 flex items-center gap-1.5"
            >
              <Save size={13} />
              <span>Save Tax Profile</span>
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
