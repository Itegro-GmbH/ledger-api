// The DATEV Summen- und Saldenliste parser and the comparison with the ledger.
import { describe, expect, it } from "vitest";

import { compareWithAdvisor, MAX_ADVISOR_ROWS, parseDatevBalanceList, parseGermanAmount } from "../src";

// A realistic DATEV Kanzlei-Rechnungswesen export: a preamble, a header with the month's and the
// cumulative values, "S"/"H" indicator columns, German numbers, a sum line at the end.
const DATEV_CSV = [
  '"Summen- und Saldenliste";"Muster GmbH";"September 2026"',
  "",
  "Konto;Beschriftung;EB-Wert;S/H;Soll Monat;Haben Monat;Soll kumuliert;Haben kumuliert;Saldo;S/H",
  '1406;"Abziehbare Vorsteuer 19 %";0,00;;12,34;0,00;1.523,60;0,00;1.523,60;S',
  "1407;Abziehbare Vorsteuer nach § 13b UStG 19 %;0,00;;18,35;0,00;61,02;0,00;61,02;S",
  "1800;Bank;0,00;;0,00;150,00;12.501,00;2.398,57;10.102,43;S",
  "2900;Gezeichnetes Kapital;0,00;;0,00;0,00;0,00;12.501,00;12.501,00;H",
  "3837;Umsatzsteuer nach § 13b UStG 19 %;0,00;;0,00;18,35;0,00;61,02;61,02;H",
  '6825;"Rechts- und Beratungskosten; Notar";0,00;;0,00;0,00;686,85;0,00;686,85;S',
  "abc;keine Zeile;;;;;;;;",
  ";Summe;;;;;;;;",
].join("\r\n");

describe("parseGermanAmount", () => {
  it("reads German numbers with thousands separators and S/H suffixes", () => {
    expect(parseGermanAmount("1.234,56")).toEqual({ cents: 123456, indicator: null });
    expect(parseGermanAmount("-0,15")).toEqual({ cents: -15, indicator: null });
    expect(parseGermanAmount("12,5 H")).toEqual({ cents: 1250, indicator: "H" });
    expect(parseGermanAmount("100 EUR")).toEqual({ cents: 10000, indicator: null });
    expect(parseGermanAmount("")).toEqual({ cents: 0, indicator: null });
    expect(parseGermanAmount("zwölf")).toBeNull();
  });
});

describe("parseDatevBalanceList", () => {
  it("reads a DATEV export: header found after the preamble, cumulative balance with its S/H", () => {
    const result = parseDatevBalanceList(DATEV_CSV);
    if (!result.ok) throw new Error(result.error);
    expect(result.rows).toEqual([
      { accountNumber: "1406", accountName: "Abziehbare Vorsteuer 19 %", balanceCents: 152360 },
      { accountNumber: "1407", accountName: "Abziehbare Vorsteuer nach § 13b UStG 19 %", balanceCents: 6102 },
      { accountNumber: "1800", accountName: "Bank", balanceCents: 1010243 },
      { accountNumber: "2900", accountName: "Gezeichnetes Kapital", balanceCents: -1250100 },
      { accountNumber: "3837", accountName: "Umsatzsteuer nach § 13b UStG 19 %", balanceCents: -6102 },
      { accountNumber: "6825", accountName: "Rechts- und Beratungskosten; Notar", balanceCents: 68685 },
    ]);
  });

  it("accepts other header names and a 'Saldo S/H' indicator column", () => {
    const csv = "Kontonummer;Kontobezeichnung;Saldo;Saldo S/H\n1800;Bank;100,00;H\n4400;Erlöse 19 % USt;50,00;H";
    const result = parseDatevBalanceList(csv);
    expect(result).toEqual({
      ok: true,
      skippedLines: [],
      rows: [
        { accountNumber: "1800", accountName: "Bank", balanceCents: -10000 },
        { accountNumber: "4400", accountName: "Erlöse 19 % USt", balanceCents: -5000 },
      ],
    });
  });

  it("accepts separate 'Saldo Soll' and 'Saldo Haben' columns", () => {
    const result = parseDatevBalanceList("Konto;Beschriftung;Saldo Soll;Saldo Haben\n1800;Bank;1.000,00;\n2900;Kapital;;12.501,00");
    expect(result.ok && result.rows.map((row) => row.balanceCents)).toEqual([100000, -1250100]);
  });

  it("keeps a signed balance without an indicator and skips unreadable amounts", () => {
    const result = parseDatevBalanceList("Konto;Saldo\n1800;-12,00\n6300;kaputt");
    expect(result).toEqual({ ok: true, rows: [{ accountNumber: "1800", accountName: null, balanceCents: -1200 }], skippedLines: [3] });
  });

  it("names what is wrong with a file it cannot use", () => {
    expect(parseDatevBalanceList("Datum;Betrag\n01.01.2026;5,00")).toEqual({ ok: false, error: "no_header" });
    expect(parseDatevBalanceList("Konto;Beschriftung\n1800;Bank")).toEqual({ ok: false, error: "no_balance_column" });
    expect(parseDatevBalanceList("Konto;Saldo\nSumme;0,00")).toEqual({ ok: false, error: "no_rows" });
  });

  it("refuses more rows than a balance list has, and an amount a Postgres integer cannot hold", () => {
    const rows = Array.from({ length: MAX_ADVISOR_ROWS + 1 }, (_, index) => `${100_000 + index};1,00`).join("\n");
    expect(parseDatevBalanceList(`Konto;Saldo\n${rows}`)).toEqual({ ok: false, error: "too_many_rows" });
    expect(parseDatevBalanceList("Konto;Saldo\n1800;21.474.836,48")).toEqual({ ok: false, error: "amount_too_large" });
    expect(parseDatevBalanceList("Konto;Saldo\n1800;99999999999999999999,00")).toEqual({ ok: false, error: "amount_too_large" });
    expect(parseDatevBalanceList("Konto;Saldo\n1800;21.474.836,47 H")).toMatchObject({ ok: true, rows: [{ balanceCents: -2_147_483_647 }] });
  });
});

describe("compareWithAdvisor", () => {
  it("shows the known August differences per account: Google Ads 50,00 and Meta 0,15", () => {
    const ours = [
      { number: "1800", name: "Bank", closingCents: 1010243 },
      { number: "1461", name: "Verrechnungskonto Meta", closingCents: 19 },
      { number: "1462", name: "Verrechnungskonto Google Ads", closingCents: 0 },
      { number: "6600", name: "Werbekosten", closingCents: 15000 },
    ];
    const theirs = [
      { accountNumber: "1800", accountName: "Bank", balanceCents: 1010243 },
      { accountNumber: "1461", accountName: "Meta", balanceCents: 4 },
      { accountNumber: "1462", accountName: "Google Ads", balanceCents: -5000 },
      { accountNumber: "6600", accountName: "Werbekosten", balanceCents: 15000 },
      { accountNumber: "6855", accountName: "Nebenkosten des Geldverkehrs", balanceCents: 900 },
    ];
    const result = compareWithAdvisor(ours, theirs);
    expect(result.differenceCount).toBe(3);
    expect(result.rows.filter((row) => row.differenceCents !== 0).map((row) => [row.accountNumber, row.differenceCents])).toEqual([
      ["1461", 15],
      ["1462", 5000],
      ["6855", -900],
    ]);
    expect(result.rows.find((row) => row.accountNumber === "6855")?.name).toBe("Nebenkosten des Geldverkehrs");
  });
});
