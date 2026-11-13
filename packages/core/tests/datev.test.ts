// The DATEV Buchungsstapel writer: invented bookings of an invented company.
import { describe, expect, it } from "vitest";

import { buildDatevExport, DATEV_COLUMNS, DEFAULT_DATEV_AUTOMATIC_ACCOUNTS, DEFAULT_DATEV_TAX_KEYS, datevAmount, datevDocumentNumber, encodeWindows1252, expandTaxLines, type DatevEntry, type DatevSettings } from "../src";

const settings: DatevSettings = {
  consultantNumber: 1001,
  clientNumber: 10001,
  fiscalYearStart: "2026-01-01",
  accountLength: 4,
  chart: "skr04",
  taxKeys: DEFAULT_DATEV_TAX_KEYS,
  automaticAccounts: DEFAULT_DATEV_AUTOMATIC_ACCOUNTS.skr04,
};

function entry(id: string, bookingDate: string, text: string, documentNumber: string | null, base: Parameters<typeof expandTaxLines>[0]): DatevEntry {
  return { id, bookingDate, text, documentNumber, lines: expandTaxLines(base) };
}

const exportOf = (entries: DatevEntry[], period = { from: "2026-07-01", to: "2026-07-31" }) => buildDatevExport({ settings, period, entries, description: "Juli 2026", createdAt: new Date("2026-08-03T17:45:12.034Z") });

describe("the DATEV Buchungsstapel", () => {
  it("has 125 columns with Festschreibung and Generalumkehr where DATEV expects them", () => {
    expect(DATEV_COLUMNS).toHaveLength(125);
    expect(DATEV_COLUMNS.indexOf("Belegfeld 1") + 1).toBe(11);
    expect(DATEV_COLUMNS.indexOf("Beleglink") + 1).toBe(20);
    expect(DATEV_COLUMNS.indexOf("Festschreibung") + 1).toBe(114);
    expect(DATEV_COLUMNS.indexOf("Generalumkehr (GU)") + 1).toBe(118);
  });

  it("writes the header with consultant, client, fiscal year, account length and period", () => {
    const result = exportOf([]);
    if (!result.ok) throw new Error(result.error);
    const header = result.text.split("\r\n")[0]!;
    expect(header.split(";")).toHaveLength(31);
    expect(header).toBe('"EXTF";700;21;"Buchungsstapel";13;20260803174512034;;"LG";"ledger-api";"";1001;10001;20260101;4;20260701;20260731;"Juli 2026";"";1;0;0;"EUR";;"";;;"04";;;"";""');
    expect(result.fileName).toBe("EXTF_Buchungsstapel_20260701_20260731.csv");
  });

  it("exports an input-tax invoice as one gross row with key 9", () => {
    const result = exportOf([entry("e1", "2026-07-15", "Hosting Juli", "RE-2026-17", [{ accountNumber: "6810", amountCents: 1190, taxCode: "vst19" }, { accountNumber: "3300", amountCents: -1190 }])]);
    if (!result.ok) throw new Error(result.error);
    expect(result.rows).toEqual([{ amountCents: 1190, side: "S", account: "6810", contraAccount: "3300", taxKey: "9", bookingDate: "2026-07-15", documentNumber: "RE-2026-17", text: "Hosting Juli" }]);
    const record = result.text.split("\r\n")[2]!.split(";");
    expect(record).toHaveLength(125);
    expect(record.slice(0, 14)).toEqual(["11,90", '"S"', '"EUR"', "", "", "", "6810", "3300", '"9"', "1507", '"RE-2026-17"', "", "", '"Hosting Juli"']);
    expect(record[113]).toBe("0");
    expect(result.warnings).toEqual([]);
  });

  it("exports revenue on an automatic account gross and without a key", () => {
    const result = exportOf([entry("e2", "2026-07-20", "Menü Familie Beispiel", "R-1001", [{ accountNumber: "1200", amountCents: 11900 }, { accountNumber: "4400", amountCents: -11900, taxCode: "ust19" }])]);
    if (!result.ok) throw new Error(result.error);
    expect(result.rows.map(({ amountCents, side, account, contraAccount, taxKey }) => ({ amountCents, side, account, contraAccount, taxKey }))).toEqual([
      { amountCents: 11900, side: "S", account: "1200", contraAccount: "4400", taxKey: null },
    ]);
  });

  it("splits an invoice with two rates against one receivable into two rows", () => {
    const result = exportOf([
      entry("e3", "2026-07-21", "Menü", "R-1002", [
        { accountNumber: "1200", amountCents: 11000 },
        { accountNumber: "4300", amountCents: -8000, taxCode: "ust7" },
        { accountNumber: "4400", amountCents: -3000, taxCode: "ust19" },
      ]),
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.rows.map((row) => [row.amountCents, row.account, row.contraAccount])).toEqual([
      [8000, "1200", "4300"],
      [3000, "1200", "4400"],
    ]);
  });

  it("exports reverse charge net; without a key the tax lines stay as booked and are reported", () => {
    const lines = [{ accountNumber: "6600", amountCents: 10000, taxCode: "rc13b" as const }, { accountNumber: "3300", amountCents: -10000 }];
    const keyed = buildDatevExport({ settings: { ...settings, taxKeys: { ...DEFAULT_DATEV_TAX_KEYS, rc13b: "46" } }, period: { from: "2026-07-01", to: "2026-07-31" }, entries: [entry("e4", "2026-07-02", "Werbung", "W-1", lines)], description: "x", createdAt: new Date() });
    if (!keyed.ok) throw new Error(keyed.error);
    expect(keyed.rows.map((row) => [row.amountCents, row.account, row.contraAccount, row.taxKey])).toEqual([[10000, "6600", "3300", "46"]]);

    const unkeyed = exportOf([entry("e4", "2026-07-02", "Werbung", "W-1", lines)]);
    if (!unkeyed.ok) throw new Error(unkeyed.error);
    expect(unkeyed.rows.map((row) => [row.amountCents, row.side, row.account, row.contraAccount])).toEqual([
      [10000, "S", "6600", "3300"],
      [1900, "S", "1407", "3837"],
    ]);
    expect(unkeyed.warnings).toEqual([{ entryId: "e4", code: "tax_without_key", detail: "rc13b" }]);
  });

  it("refuses a period outside the fiscal year and an entry outside the period", () => {
    expect(exportOf([], { from: "2025-12-01", to: "2026-01-31" })).toEqual({ ok: false, error: "period_outside_fiscal_year" });
    const outside = exportOf([entry("e5", "2026-08-01", "x", null, [{ accountNumber: "1800", amountCents: 100 }, { accountNumber: "2900", amountCents: -100 }])]);
    expect(outside).toEqual({ ok: false, error: "entry_outside_period", detail: "e5" });
  });

  it("formats amounts and cleans document numbers and text for DATEV", () => {
    expect(datevAmount(142800)).toBe("1428,00");
    expect(datevAmount(-5)).toBe("0,05");
    expect(datevDocumentNumber("RE 2026_17.a")).toEqual({ value: "RE202617a", changed: true });
    const result = exportOf([entry("e6", "2026-07-03", 'Rechnung „Sommerfest" – Nr. 5', null, [{ accountNumber: "6300", amountCents: 500 }, { accountNumber: "1800", amountCents: -500 }])]);
    if (!result.ok) throw new Error(result.error);
    expect(result.text.split("\r\n")[2]!.split(";")[13]).toBe('"Rechnung ""Sommerfest"" - Nr. 5"');
  });

  it("encodes umlauts and the euro sign as Windows-1252", () => {
    expect(Array.from(encodeWindows1252("Gebühr 5 €"))).toEqual([0x47, 0x65, 0x62, 0xfc, 0x68, 0x72, 0x20, 0x35, 0x20, 0x80]);
    expect(Array.from(encodeWindows1252("\u{1F600}"))).toEqual([0x3f]);
  });
});
