import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateYearToDateSummaries,
  generate1099NecCsv,
  generateInternationalVatCsv,
} from '../src/lib/tax-compliance.ts';

test('Tax & Compliance: calculateYearToDateSummaries aggregates settled payroll transactions accurately', () => {
  const transactions = [
    {
      contractorWallet: 'GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG',
      legalName: 'Charlie Vance',
      amountUsdc: 2500.0,
      settledAt: '2026-02-15T18:30:00Z',
      txHash: 'hash1',
    },
    {
      contractorWallet: 'GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG',
      legalName: 'Charlie Vance',
      amountUsdc: 3000.0,
      settledAt: '2026-05-15T18:30:00Z',
      txHash: 'hash2',
    },
    {
      contractorWallet: 'GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A',
      legalName: 'Sarah Lin',
      amountUsdc: 400.0,
      settledAt: '2026-03-20T14:15:00Z',
      txHash: 'hash3',
    },
    {
      contractorWallet: 'GBDXVD27PJS4PVC5USFBSJUTTYVXIH6MS6MM6M2IDCXJWJHEPRTTIQNP',
      legalName: 'Elena Rostova',
      amountUsdc: 1200.0,
      settledAt: '2026-06-01T09:45:00Z',
      txHash: 'hash4',
    },
    // Transaction in another year - should be excluded
    {
      contractorWallet: 'GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG',
      legalName: 'Charlie Vance',
      amountUsdc: 999.0,
      settledAt: '2025-12-15T18:30:00Z',
      txHash: 'hash_old',
    },
  ];

  const taxRecords = [
    {
      walletAddress: 'GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG',
      legalName: 'Charlie Vance',
      country: 'US',
      taxId: '12-3456789',
      taxForm: 'W-9',
      withholdingExempt: false,
      submittedAt: '2026-01-10T12:00:00Z',
    },
    {
      walletAddress: 'GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A',
      legalName: 'Sarah Lin',
      country: 'US',
      taxId: '98-7654321',
      taxForm: 'W-9',
      withholdingExempt: false,
      submittedAt: '2026-01-12T15:30:00Z',
    },
    {
      walletAddress: 'GBDXVD27PJS4PVC5USFBSJUTTYVXIH6MS6MM6M2IDCXJWJHEPRTTIQNP',
      legalName: 'Elena Rostova',
      country: 'EE',
      taxId: '',
      taxForm: 'pending', // Missing W-9 / W-8BEN, over $600 threshold -> 24% backup withholding
      withholdingExempt: false,
      submittedAt: null,
    },
  ];

  const summaries = calculateYearToDateSummaries(transactions, taxRecords, 2026);
  assert.equal(summaries.length, 3);

  // Charlie Vance: 2500 + 3000 = 5500 USDC
  const charlie = summaries.find((s) => s.contractorAddress.includes('GD3AGJ'));
  assert.ok(charlie);
  assert.equal(charlie.totalDisbursedUsdc, 5500.0);
  assert.equal(charlie.transactionCount, 2);
  assert.equal(charlie.withholdingRequired, false);
  assert.equal(charlie.withholdingAmountUsdc, 0);
  assert.equal(charlie.netDisbursedUsdc, 5500.0);

  // Sarah Lin: 400 USDC (< $600 threshold)
  const sarah = summaries.find((s) => s.contractorAddress.includes('GBXCR3'));
  assert.ok(sarah);
  assert.equal(sarah.totalDisbursedUsdc, 400.0);
  assert.equal(sarah.transactionCount, 1);
  assert.equal(sarah.withholdingRequired, false);

  // Elena Rostova: 1200 USDC (>= $600 threshold, pending form -> 24% statutory withholding)
  const elena = summaries.find((s) => s.contractorAddress.includes('GBDXVD'));
  assert.ok(elena);
  assert.equal(elena.totalDisbursedUsdc, 1200.0);
  assert.equal(elena.withholdingRequired, true);
  assert.equal(elena.withholdingRate, 0.24);
  assert.equal(elena.withholdingAmountUsdc, 288.0); // 1200 * 0.24
  assert.equal(elena.netDisbursedUsdc, 912.0); // 1200 - 288
});

test('Tax & Compliance: generate1099NecCsv exports standard IRS financial reporting columns', () => {
  const summaries = [
    {
      contractorAddress: 'GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG',
      legalName: 'Charlie Vance',
      country: 'US',
      taxId: '12-3456789',
      taxForm: 'W-9',
      formSubmitted: true,
      totalDisbursedUsdc: 5500.0,
      transactionCount: 2,
      withholdingRate: 0,
      withholdingRequired: false,
      withholdingAmountUsdc: 0,
      netDisbursedUsdc: 5500.0,
    },
  ];

  const profile = {
    businessLegalName: 'Orbit Technologies Inc.',
    registeredEntityAddress: '100 Montgomery St',
    country: 'US',
    taxId: '84-2194812',
  };

  const csv = generate1099NecCsv(summaries, profile, 2026);
  assert.match(csv, /Payer Legal Name,Payer TIN,Payer Address,Payer Country/);
  assert.match(csv, /Box 1 Nonemployee Compensation \(USDC\)/);
  assert.match(csv, /Box 4 Federal Income Tax Withheld \(USDC\)/);
  assert.match(csv, /Orbit Technologies Inc\./);
  assert.match(csv, /84-2194812/);
  assert.match(csv, /Charlie Vance/);
  assert.match(csv, /5500\.00/);
});

test('Tax & Compliance: generateInternationalVatCsv exports B2B cross-border reverse charge summary', () => {
  const summaries = [
    {
      contractorAddress: 'GAJ7J66Q66THHJ22WTBBEJUHHLVD7RZZW6KTVQDBBQYXRPVC4UFFQFDR',
      legalName: 'David Kim',
      country: 'KR',
      taxId: 'KR-891011',
      taxForm: 'W-8BEN',
      formSubmitted: true,
      totalDisbursedUsdc: 1800.0,
      transactionCount: 1,
      withholdingRate: 0,
      withholdingRequired: false,
      withholdingAmountUsdc: 0,
      netDisbursedUsdc: 1800.0,
    },
  ];

  const profile = {
    businessLegalName: 'Orbit Technologies Inc.',
    registeredEntityAddress: '100 Montgomery St',
    country: 'US',
    taxId: '84-2194812',
    vatNumber: 'US842194812',
  };

  const csv = generateInternationalVatCsv(summaries, profile, 2026);
  assert.match(csv, /Entity Legal Name,Entity VAT \/ TIN,Entity Country/);
  assert.match(csv, /Gross B2B Disbursed \(USDC\)/);
  assert.match(csv, /Reverse Charge Applicable/);
  assert.match(csv, /David Kim/);
  assert.match(csv, /W-8BEN/);
  assert.match(csv, /1800\.00/);
});
