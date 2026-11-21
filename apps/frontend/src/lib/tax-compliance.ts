/**
 * Tax & Compliance Module for Orbit
 * Handles corporate tax profile settings, vendor tax form collection (W-9 / W-8BEN),
 * year-to-date payroll compensation aggregation, and audit-ready 1099-NEC / VAT CSV exports.
 */

export interface MerchantTaxProfile {
  businessLegalName: string;
  registeredEntityAddress: string;
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  country: string;
  taxId: string; // EIN / TIN
  vatNumber?: string;
  updatedAt?: string;
}

export interface ContractorTaxRecord {
  walletAddress: string;
  legalName: string;
  country: string;
  taxId?: string;
  taxForm: "W-9" | "W-8BEN" | "pending";
  withholdingExempt: boolean;
  submittedAt: string | null;
  notes?: string;
}

export interface SettledBatchDisbursement {
  contractorWallet: string;
  legalName?: string;
  amountUsdc: number;
  settledAt: string; // ISO date
  txHash: string;
}

export interface YearToDateTaxSummary {
  contractorAddress: string;
  legalName: string;
  country: string;
  taxId: string;
  taxForm: "W-9" | "W-8BEN" | "pending";
  formSubmitted: boolean;
  totalDisbursedUsdc: number;
  transactionCount: number;
  withholdingRate: number; // e.g. 0.24 for statutory backup withholding
  withholdingRequired: boolean;
  withholdingAmountUsdc: number;
  netDisbursedUsdc: number;
}

const TAX_PROFILE_PREFIX = "orbit_merchant_tax_profile:";
const CONTRACTOR_TAX_PREFIX = "orbit_contractor_tax_forms:";

export function getTaxProfileStorageKey(merchantId: string): string {
  return `${TAX_PROFILE_PREFIX}${merchantId || "default"}`;
}

export function getContractorsTaxStorageKey(merchantId: string): string {
  return `${CONTRACTOR_TAX_PREFIX}${merchantId || "default"}`;
}

export function loadTaxProfile(merchantId: string): MerchantTaxProfile | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = localStorage.getItem(getTaxProfileStorageKey(merchantId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveTaxProfile(merchantId: string, profile: MerchantTaxProfile): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  const updated: MerchantTaxProfile = {
    ...profile,
    businessLegalName: profile.businessLegalName.trim(),
    registeredEntityAddress: profile.registeredEntityAddress.trim(),
    country: profile.country.trim().toUpperCase(),
    taxId: profile.taxId.trim(),
    vatNumber: profile.vatNumber?.trim() || "",
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(getTaxProfileStorageKey(merchantId), JSON.stringify(updated));
}

export function loadContractorTaxRecords(merchantId: string): ContractorTaxRecord[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem(getContractorsTaxStorageKey(merchantId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveContractorTaxRecord(merchantId: string, record: ContractorTaxRecord): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  const existing = loadContractorTaxRecords(merchantId);
  const normalizedWallet = record.walletAddress.trim();
  const index = existing.findIndex((r) => r.walletAddress.toLowerCase() === normalizedWallet.toLowerCase());

  const updatedRecord: ContractorTaxRecord = {
    ...record,
    walletAddress: normalizedWallet,
    legalName: record.legalName.trim(),
    country: record.country.trim().toUpperCase(),
    taxId: record.taxId?.trim() || "",
    submittedAt: record.taxForm !== "pending" && !record.submittedAt ? new Date().toISOString() : record.submittedAt,
  };

  if (index >= 0) {
    existing[index] = updatedRecord;
  } else {
    existing.push(updatedRecord);
  }

  localStorage.setItem(getContractorsTaxStorageKey(merchantId), JSON.stringify(existing));
}

/**
 * Accurately aggregates settled batch payroll transactions for a given calendar year
 * and combines them with contractor tax compliance records.
 */
export function calculateYearToDateSummaries(
  transactions: SettledBatchDisbursement[],
  taxRecords: ContractorTaxRecord[],
  year: number = new Date().getFullYear()
): YearToDateTaxSummary[] {
  const yearPrefix = String(year);
  const recordsByWallet = new Map<string, ContractorTaxRecord>();
  for (const r of taxRecords) {
    recordsByWallet.set(r.walletAddress.trim().toUpperCase(), r);
  }

  const totalsByWallet = new Map<string, { total: number; count: number; name: string }>();

  for (const tx of transactions) {
    if (!tx.settledAt || !tx.settledAt.startsWith(yearPrefix)) continue;
    const wallet = tx.contractorWallet.trim().toUpperCase();
    const existing = totalsByWallet.get(wallet) || {
      total: 0,
      count: 0,
      name: tx.legalName || "",
    };
    existing.total += Number(tx.amountUsdc) || 0;
    existing.count += 1;
    if (tx.legalName && !existing.name) existing.name = tx.legalName;
    totalsByWallet.set(wallet, existing);
  }

  // Also include contractors with tax records who may have 0 disbursements this year
  for (const [wallet, record] of recordsByWallet.entries()) {
    if (!totalsByWallet.has(wallet)) {
      totalsByWallet.set(wallet, { total: 0, count: 0, name: record.legalName });
    }
  }

  const summaries: YearToDateTaxSummary[] = [];

  for (const [wallet, agg] of totalsByWallet.entries()) {
    const record = recordsByWallet.get(wallet);
    const legalName = record?.legalName || agg.name || `Contractor ${wallet.slice(0, 6)}`;
    const country = record?.country || "US";
    const taxForm = record?.taxForm || "pending";
    const formSubmitted = taxForm !== "pending";
    const totalDisbursed = Number(agg.total.toFixed(2));

    // Under US IRS regulations, nonemployee compensation of $600 or more requires Form W-9 on file;
    // failure to provide TIN/W-9 triggers 24% statutory backup withholding.
    const isOverThreshold = totalDisbursed >= 600;
    const withholdingRequired = isOverThreshold && !formSubmitted && !record?.withholdingExempt;
    const withholdingRate = withholdingRequired ? 0.24 : 0.0;
    const withholdingAmount = Number((totalDisbursed * withholdingRate).toFixed(2));
    const netDisbursed = Number((totalDisbursed - withholdingAmount).toFixed(2));

    summaries.push({
      contractorAddress: wallet,
      legalName,
      country,
      taxId: record?.taxId || (formSubmitted ? "W-9-ON-FILE" : "NOT-PROVIDED"),
      taxForm,
      formSubmitted,
      totalDisbursedUsdc: totalDisbursed,
      transactionCount: agg.count,
      withholdingRate,
      withholdingRequired,
      withholdingAmountUsdc: withholdingAmount,
      netDisbursedUsdc: netDisbursed,
    });
  }

  // Sort by total disbursed descending
  return summaries.sort((a, b) => b.totalDisbursedUsdc - a.totalDisbursedUsdc);
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[=+@\-\t\r]/.test(text) ? "'" + text : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Generates an IRS 1099-NEC CSV export matching standard financial accounting columns.
 */
export function generate1099NecCsv(
  summaries: YearToDateTaxSummary[],
  profile: MerchantTaxProfile | null,
  year: number = new Date().getFullYear()
): string {
  const headers = [
    "Payer Legal Name",
    "Payer TIN",
    "Payer Address",
    "Payer Country",
    "Recipient Legal Name",
    "Recipient TIN",
    "Recipient Country",
    "Recipient Stellar Wallet",
    "Box 1 Nonemployee Compensation (USDC)",
    "Box 4 Federal Income Tax Withheld (USDC)",
    "W-9 on File",
    "Tax Year",
  ];

  const payerName = profile?.businessLegalName || "Orbit Merchant";
  const payerTin = profile?.taxId || "NOT_SET";
  const payerAddr = profile?.registeredEntityAddress || "";
  const payerCountry = profile?.country || "US";

  const rows = summaries.map((s) => [
    payerName,
    payerTin,
    payerAddr,
    payerCountry,
    s.legalName,
    s.taxId,
    s.country,
    s.contractorAddress,
    s.totalDisbursedUsdc.toFixed(2),
    s.withholdingAmountUsdc.toFixed(2),
    s.taxForm === "W-9" ? "YES" : "NO",
    String(year),
  ]);

  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Generates an International VAT / Cross-border summary CSV export.
 */
export function generateInternationalVatCsv(
  summaries: YearToDateTaxSummary[],
  profile: MerchantTaxProfile | null,
  year: number = new Date().getFullYear()
): string {
  const headers = [
    "Entity Legal Name",
    "Entity VAT / TIN",
    "Entity Country",
    "Vendor Legal Name",
    "Vendor Country",
    "Vendor Tax ID / VAT",
    "Vendor Stellar Wallet",
    "Gross B2B Disbursed (USDC)",
    "Tax Form Type",
    "Reverse Charge Applicable",
    "Tax Year",
  ];

  const entityName = profile?.businessLegalName || "Orbit Merchant";
  const entityVat = profile?.vatNumber || profile?.taxId || "NOT_SET";
  const entityCountry = profile?.country || "US";

  const rows = summaries.map((s) => [
    entityName,
    entityVat,
    entityCountry,
    s.legalName,
    s.country,
    s.taxId,
    s.contractorAddress,
    s.totalDisbursedUsdc.toFixed(2),
    s.taxForm === "W-8BEN" ? "W-8BEN" : s.taxForm === "W-9" ? "W-9" : "NONE",
    s.country !== entityCountry ? "YES" : "NO",
    String(year),
  ]);

  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function downloadCsvFile(content: string, filename: string): void {
  if (typeof window === "undefined" || !window.Blob) return;
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
