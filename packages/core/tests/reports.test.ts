// Pure reports on the real the reference company cases (decisions/0080): Summen- und Saldenliste, account
// sheet, open items (Meta prepaid, Google Ads charged first and invoiced later) and the USt-VA
// preview.
import { describe, expect, it } from "vitest";

import {
  computeAccountSheet,
  computeBalances,
  computeOpenItems,
  computeVatPreview,
  expandTaxLines,
  SKR04_SEED_ACCOUNTS,
  type BaseLineInput,
  type ReportAccount,
  type ReportLine,
} from "../src";

const accounts: ReportAccount[] = [
  ...SKR04_SEED_ACCOUNTS.map((seed) => ({ id: `acc-${seed.number}`, number: seed.number, name: seed.name, kind: seed.kind, group: seed.group, openItems: seed.openItems })),
  { id: "acc-1461", number: "1461", name: "Verrechnungskonto Meta", kind: "asset", group: "open_items", openItems: true },
  { id: "acc-1462", number: "1462", name: "Verrechnungskonto Google Ads", kind: "asset", group: "open_items", openItems: true },
  { id: "acc-3511", number: "3511", name: "Auslagen Erika", kind: "liability", group: "open_items", openItems: true },
];
const accountByNumber = new Map(accounts.map((account) => [account.number, account]));

let entrySeq = 0;
/** One entry's report lines, tax lines expanded like the use case does. */
function entry(bookingDate: string, lines: BaseLineInput[], text = "Buchung"): ReportLine[] {
  const entryId = `e${String(++entrySeq).padStart(4, "0")}`;
  return expandTaxLines(lines).map((line) => ({
    lineId: `${entryId}-${line.position}`,
    entryId,
    position: line.position,
    accountId: accountByNumber.get(line.accountNumber)!.id,
    accountNumber: line.accountNumber,
    bookingDate,
    amountCents: line.amountCents,
    taxCode: line.taxCode,
    taxRole: line.taxRole,
    text: line.text,
    entryText: text,
    documentId: null,
    transactionId: null,
  }));
}

const shareCapital = [1, 2, 3].flatMap(() =>
  entry("2026-06-10", [
    { accountNumber: "1800", amountCents: 416700 },
    { accountNumber: "2900", amountCents: -416700 },
  ]),
);
const ionos = entry("2026-07-01", [
  { accountNumber: "6810", amountCents: 150, taxCode: "vst19" },
  { accountNumber: "1800", amountCents: -150 },
]);

describe("computeBalances", () => {
  it("lists opening, debit, credit and closing per account, sorted by number", () => {
    const list = computeBalances(accounts, [...shareCapital, ...ionos], { from: "2026-07-01", to: "2026-07-31" });
    const byNumber = new Map(list.rows.map((row) => [row.number, row]));
    expect(byNumber.get("1800")).toMatchObject({ openingCents: 1250100, debitCents: 0, creditCents: 150, closingCents: 1249950 });
    expect(byNumber.get("2900")).toMatchObject({ openingCents: -1250100, debitCents: 0, creditCents: 0, closingCents: -1250100 });
    expect(byNumber.get("6810")).toMatchObject({ openingCents: 0, debitCents: 126, closingCents: 126 });
    expect(byNumber.get("1406")).toMatchObject({ debitCents: 24, closingCents: 24 });
    expect(list.rows.map((row) => row.number)).toEqual(["1406", "1800", "2900", "6810"]);
    expect(list.totals.closingCents).toBe(0);
    expect(list.totals.debitCents).toBe(list.totals.creditCents);
  });

  it("starts revenue and expense accounts at zero in a new year, carries balance accounts forward", () => {
    const lastYear = entry("2025-12-15", [
      { accountNumber: "6810", amountCents: 1000 },
      { accountNumber: "1800", amountCents: -1000 },
    ]);
    const list = computeBalances(accounts, lastYear, { from: "2026-01-01", to: "2026-01-31" });
    expect(list.rows.find((row) => row.number === "6810")).toBeUndefined();
    expect(list.rows.find((row) => row.number === "1800")?.openingCents).toBe(-1000);
  });

  it("carries the prior years' result into 2970 Gewinnvortrag, so the openings sum to zero", () => {
    const revenue = entry("2026-07-15", [
      { accountNumber: "1800", amountCents: 50_000 },
      { accountNumber: "4400", amountCents: -50_000 },
    ]);
    const cost = entry("2026-08-15", [
      { accountNumber: "6810", amountCents: 12_000 },
      { accountNumber: "1800", amountCents: -12_000 },
    ]);
    const nextYear = entry("2027-02-01", [
      { accountNumber: "6810", amountCents: 1_000 },
      { accountNumber: "1800", amountCents: -1_000 },
    ]);
    const lines = [...shareCapital, ...revenue, ...cost, ...nextYear];
    const list = computeBalances(accounts, lines, { from: "2027-01-01", to: "2027-12-31" });
    const byNumber = new Map(list.rows.map((row) => [row.number, row]));
    expect(byNumber.get("2970")).toMatchObject({ accountId: "acc-2970", name: "Gewinnvortrag vor Verwendung", openingCents: -38_000, debitCents: 0, creditCents: 0, closingCents: -38_000 });
    expect(byNumber.get("4400")).toBeUndefined();
    expect(byNumber.get("6810")).toMatchObject({ openingCents: 0, debitCents: 1_000 });
    expect(list.totals.openingCents).toBe(0);
    expect(list.totals.closingCents).toBe(0);
    // Inside 2026 nothing is carried yet.
    expect(computeBalances(accounts, lines, { from: "2026-09-01", to: "2026-12-31" }).rows.find((row) => row.number === "2970")).toBeUndefined();
    // Without 2970 in the chart the row is still there, so the list stays balanced.
    const without = computeBalances(accounts.filter((account) => account.number !== "2970"), lines, { from: "2027-01-01", to: "2027-12-31" });
    expect(without.rows.find((row) => row.number === "2970")?.openingCents).toBe(-38_000);
    expect(without.totals.openingCents).toBe(0);
  });

  it("counts an expense from earlier in the same year toward the opening", () => {
    const list = computeBalances(accounts, ionos, { from: "2026-08-01", to: "2026-08-31" });
    expect(list.rows.find((row) => row.number === "6810")?.openingCents).toBe(126);
  });

  it("ignores lines after the period", () => {
    const list = computeBalances(accounts, ionos, { from: "2026-06-01", to: "2026-06-30" });
    expect(list.rows).toEqual([]);
  });
});

describe("computeAccountSheet", () => {
  it("shows a running balance and the counter accounts of each line", () => {
    const sheet = computeAccountSheet(accountByNumber.get("1800")!, [...shareCapital, ...ionos], { from: "2026-06-01", to: "2026-07-31" });
    expect(sheet.openingCents).toBe(0);
    expect(sheet.rows.map((row) => row.runningBalanceCents)).toEqual([416700, 833400, 1250100, 1249950]);
    expect(sheet.rows[0]!.counterAccountNumbers).toEqual(["2900"]);
    expect(sheet.rows[3]!.counterAccountNumbers).toEqual(["6810", "1406"]);
    expect(sheet).toMatchObject({ debitCents: 1250100, creditCents: 150, closingCents: 1249950 });
  });
});

describe("computeOpenItems", () => {
  it("Meta prepaid: a 100,00 top-up consumed by 27 small invoices leaves 0,04 credit, explained by a note", () => {
    const topUp = entry("2026-06-20", [
      { accountNumber: "1461", amountCents: 10000 },
      { accountNumber: "1800", amountCents: -10000 },
    ]);
    // 27 invoices from 0,02 to 13,00 summing to 99,96.
    const amounts = [2, 15, 37, 50, 88, 99, 120, 150, 199, 230, 250, 300, 320, 350, 380, 400, 420, 450, 480, 500, 520, 560, 600, 650, 700, 826, 1300];
    expect(amounts).toHaveLength(27);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(9996);
    const invoices = amounts.flatMap((cents, i) =>
      entry(`2026-07-${String((i % 28) + 1).padStart(2, "0")}`, [
        { accountNumber: "6600", amountCents: cents, taxCode: "rc13b" },
        { accountNumber: "1461", amountCents: -cents },
      ]),
    );
    const lines = [...topUp, ...invoices];
    const meta = accountByNumber.get("1461")!;

    const open = computeOpenItems(meta.id, lines, [], "2026-09-30");
    expect(open.balanceCents).toBe(4);
    expect(open.status).toBe("open");
    expect(open.unmatched).toHaveLength(28);

    const metaLines = lines.filter((line) => line.accountId === meta.id).map((line) => line.lineId);
    const explained = computeOpenItems(meta.id, lines, [{ id: "m1", kind: "explained", note: "Guthaben bei Meta 0,04 EUR", lineIds: metaLines }], "2026-09-30");
    expect(explained.status).toBe("explained");
    expect(explained.unmatched).toHaveLength(0);
    expect(explained.matches[0]!.sumCents).toBe(4);
  });

  it("Google Ads: charges of 10 + 50 + 36,57 against one invoice of 96,57 settle to zero", () => {
    const charges = [1000, 5000, 3657].flatMap((cents, i) =>
      entry(`2026-08-${10 + i}`, [
        { accountNumber: "1462", amountCents: cents },
        { accountNumber: "1800", amountCents: -cents },
      ]),
    );
    const invoice = entry("2026-08-31", [
      { accountNumber: "6600", amountCents: 9657, taxCode: "rc13b" },
      { accountNumber: "1462", amountCents: -9657 },
    ]);
    const google = accountByNumber.get("1462")!;
    const lines = [...charges, ...invoice];
    const items = computeOpenItems(google.id, lines, [], "2026-08-31");
    expect(items.balanceCents).toBe(0);
    expect(items.status).toBe("zero");

    // Without the 50,00 charge (the real error found in August), the account does not reach zero.
    const missing = [...charges.filter((line) => line.amountCents !== 5000 && line.amountCents !== -5000), ...invoice];
    expect(computeOpenItems(google.id, missing, [], "2026-08-31")).toMatchObject({ balanceCents: -5000, status: "open" });

    const ids = lines.filter((line) => line.accountId === google.id).map((line) => line.lineId);
    const matched = computeOpenItems(google.id, lines, [{ id: "m", kind: "match", note: null, lineIds: ids }], "2026-08-31");
    expect(matched.unmatched).toHaveLength(0);
    expect(matched.matches[0]!.sumCents).toBe(0);
  });

  it("a match counts at a date only when all its lines are on or before that date", () => {
    const charge = entry("2026-08-19", [
      { accountNumber: "1462", amountCents: 5000 },
      { accountNumber: "1800", amountCents: -5000 },
    ]);
    const invoice = entry("2026-09-03", [
      { accountNumber: "6600", amountCents: 5000, taxCode: "rc13b" },
      { accountNumber: "1462", amountCents: -5000 },
    ]);
    const google = accountByNumber.get("1462")!;
    const lines = [...charge, ...invoice];
    const ids = lines.filter((line) => line.accountId === google.id).map((line) => line.lineId);
    const match = [{ id: "m", kind: "match" as const, note: null, lineIds: ids }];
    const august = computeOpenItems(google.id, lines, match, "2026-08-31");
    expect(august).toMatchObject({ balanceCents: 5000, status: "open", unmatchedSumCents: 5000, matches: [] });
    expect(august.unmatched.map((line) => line.lineId)).toEqual([ids[0]]);
    expect(computeOpenItems(google.id, lines, match, "2026-09-30")).toMatchObject({ status: "zero", unmatched: [] });
  });

  it("notary paid by the shareholder, refunded by bank: the shareholder account settles", () => {
    const invoice = entry("2026-06-05", [
      { accountNumber: "6825", amountCents: 80683, taxCode: "vst19" },
      { accountNumber: "6825", amountCents: 900, taxCode: "pass_through" },
      { accountNumber: "3511", amountCents: -81583 },
    ]);
    const refund = entry("2026-06-12", [
      { accountNumber: "3511", amountCents: 81583 },
      { accountNumber: "1800", amountCents: -81583 },
    ]);
    const erika = accountByNumber.get("3511")!;
    expect(computeOpenItems(erika.id, invoice, [], "2026-06-30").status).toBe("open");
    expect(computeOpenItems(erika.id, [...invoice, ...refund], [], "2026-06-30").status).toBe("zero");
    // As of a day before the refund, it is still open.
    expect(computeOpenItems(erika.id, [...invoice, ...refund], [], "2026-06-11").balanceCents).toBe(-81583);
  });
});

describe("computeVatPreview", () => {
  it("fills the Kennzahlen and the Zahllast from tax accounts and base lines", () => {
    const googleInvoice = entry("2026-08-31", [
      { accountNumber: "6600", amountCents: 9657, taxCode: "rc13b" },
      { accountNumber: "1462", amountCents: -9657 },
    ]);
    const sale = entry("2026-08-15", [
      { accountNumber: "1200", amountCents: 11900 },
      { accountNumber: "4400", amountCents: -11900, taxCode: "ust19" },
    ]);
    const euSale = entry("2026-08-16", [
      { accountNumber: "1200", amountCents: 50000 },
      { accountNumber: "4339", amountCents: -50000, taxCode: "eu_not_taxable" },
    ]);
    const preview = computeVatPreview([...ionos, ...googleInvoice, ...sale, ...euSale]);
    const row = (kz: string) => preview.rows.find((candidate) => candidate.kennzahl === kz)!;
    expect(row("81")).toEqual({ kennzahl: "81", baseCents: 10000, taxCents: 1900 });
    expect(row("21")).toEqual({ kennzahl: "21", baseCents: 50000, taxCents: null });
    expect(row("46")).toEqual({ kennzahl: "46", baseCents: 9657, taxCents: null });
    expect(row("47")).toEqual({ kennzahl: "47", baseCents: null, taxCents: 1835 });
    expect(row("66")).toEqual({ kennzahl: "66", baseCents: null, taxCents: 24 });
    expect(row("67")).toEqual({ kennzahl: "67", baseCents: null, taxCents: 1835 });
    expect(row("86")).toEqual({ kennzahl: "86", baseCents: null, taxCents: null });
    // 19,00 + 18,35 owed, 0,24 + 18,35 deductible.
    expect(preview.outputTaxCents).toBe(3735);
    expect(preview.inputTaxCents).toBe(1859);
    expect(preview.payableCents).toBe(1876);
    expect(row("83").taxCents).toBe(1876);
  });

  it("is a refund when input tax exceeds output tax", () => {
    expect(computeVatPreview(ionos).payableCents).toBe(-24);
  });

  it("does not take input tax on the notary's pass-through costs", () => {
    const notary = entry("2026-06-05", [
      { accountNumber: "6825", amountCents: 80683, taxCode: "vst19" },
      { accountNumber: "6825", amountCents: 900, taxCode: "pass_through" },
      { accountNumber: "3511", amountCents: -81583 },
    ]);
    expect(computeVatPreview(notary).inputTaxCents).toBe(12882);
  });
});
