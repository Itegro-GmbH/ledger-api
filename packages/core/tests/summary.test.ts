// The deterministic entry summary, rendered through the real `Ledger.summaries` templates.
import { createTranslator } from "use-intl/core";
import { describe, expect, it } from "vitest";

import de from "./fixtures/messages.de.json";
import { expandTaxLines, SKR04_SEED_ACCOUNTS, summarizeEntry, type BaseLineInput, type LedgerAccountGroup, type LedgerAccountKind, type LedgerOwnerType, type SummaryLine } from "../src";

type ChartAccount = { name: string; kind: LedgerAccountKind; group: LedgerAccountGroup; openItems: boolean; ownerType: LedgerOwnerType | null; ownerPersonName: string | null };
const chart = new Map<string, ChartAccount>([
  ...SKR04_SEED_ACCOUNTS.map((seed): [string, ChartAccount] => [seed.number, { name: seed.name, kind: seed.kind, group: seed.group, openItems: seed.openItems, ownerType: null, ownerPersonName: null }]),
  ["1800", { name: "Bank Hausbank", kind: "asset", group: "bank", openItems: false, ownerType: "bank_account", ownerPersonName: null }],
  ["1461", { name: "Verrechnungskonto Meta", kind: "asset", group: "open_items", openItems: true, ownerType: "contact", ownerPersonName: null }],
  ["1462", { name: "Verrechnungskonto Google Ads", kind: "asset", group: "open_items", openItems: true, ownerType: "contact", ownerPersonName: null }],
  ["3511", { name: "Auslagen Erika", kind: "liability", group: "open_items", openItems: true, ownerType: "person", ownerPersonName: "Erika" }],
]);

function lines(input: BaseLineInput[]): SummaryLine[] {
  return expandTaxLines(input).map((line) => {
    const account = chart.get(line.accountNumber)!;
    return { accountNumber: line.accountNumber, accountName: account.name, kind: account.kind, group: account.group, openItems: account.openItems, ownerType: account.ownerType, ownerPersonName: account.ownerPersonName, amountCents: line.amountCents, taxCode: line.taxCode, taxRole: line.taxRole };
  });
}

const t = createTranslator({ locale: "de", messages: de, namespace: "Ledger" });
function render(input: BaseLineInput[]): string {
  const summary = summarizeEntry(lines(input));
  return t(summary.key as Parameters<typeof t>[0], summary.params as never).replace(/ /g, " ");
}

describe("summarizeEntry", () => {
  it("expense paid by bank (IONOS)", () => {
    expect(render([{ accountNumber: "6810", amountCents: 150, taxCode: "vst19" }, { accountNumber: "1800", amountCents: -150 }])).toBe(
      "1,50 € für Internetkosten, bezahlt über Bank Hausbank.",
    );
  });

  it("reverse charge (Google Ads invoice against its clearing account)", () => {
    const summary = summarizeEntry(lines([{ accountNumber: "6600", amountCents: 9657, taxCode: "rc13b" }, { accountNumber: "1462", amountCents: -9657 }]));
    expect(summary).toEqual({ key: "summaries.reverseCharge", params: { amount: 96.57, account: "Werbekosten", counter: "Verrechnungskonto Google Ads" } });
  });

  it("expense from a prepaid credit (Meta, without § 13b tax)", () => {
    expect(summarizeEntry(lines([{ accountNumber: "6600", amountCents: 2 }, { accountNumber: "1461", amountCents: -2 }])).key).toBe("summaries.expenseFromPrepaid");
  });

  it("expense against the payables", () => {
    expect(summarizeEntry(lines([{ accountNumber: "6300", amountCents: 1000 }, { accountNumber: "3300", amountCents: -1000 }])).key).toBe("summaries.expenseAgainstOpenItem");
  });

  it("expense paid by a shareholder (notary)", () => {
    expect(render([{ accountNumber: "6825", amountCents: 81583, taxCode: "vst19" }, { accountNumber: "3511", amountCents: -81583 }])).toBe(
      "815,83 € für Rechts- und Beratungskosten, privat bezahlt von Erika. Die Gesellschaft erstattet den Betrag.",
    );
  });

  it("revenue", () => {
    expect(render([{ accountNumber: "1200", amountCents: 11900 }, { accountNumber: "4400", amountCents: -11900, taxCode: "ust19" }])).toBe(
      "Einnahme von 119,00 € auf Erlöse 19 % USt, gegen Forderungen aus Lieferungen und Leistungen.",
    );
  });

  it("payments: the top-up of the Meta credit out, the share capital in", () => {
    expect(render([{ accountNumber: "1461", amountCents: 10000 }, { accountNumber: "1800", amountCents: -10000 }])).toBe(
      "Zahlung von 100,00 € von Bank Hausbank, gebucht auf Verrechnungskonto Meta.",
    );
    expect(render([{ accountNumber: "1800", amountCents: 416700 }, { accountNumber: "2900", amountCents: -416700 }])).toBe(
      "Zahlungseingang von 4.167,00 € auf Bank Hausbank, gebucht auf Gezeichnetes Kapital.",
    );
  });

  it("transfer between money accounts (bank to money in transit)", () => {
    expect(render([{ accountNumber: "1360", amountCents: 5000 }, { accountNumber: "1800", amountCents: -5000 }])).toBe("50,00 € von Bank Hausbank nach Geldtransit umgebucht.");
  });

  it("split (court fee 300 + dunning fee 5)", () => {
    expect(
      render([
        { accountNumber: "6825", amountCents: 30000, taxCode: "not_taxable" },
        { accountNumber: "6300", amountCents: 500, taxCode: "not_taxable" },
        { accountNumber: "1800", amountCents: -30500 },
      ]),
    ).toBe("305,00 € aufgeteilt auf 2 Konten.");
  });

  it("manual when no template fits", () => {
    expect(summarizeEntry(lines([{ accountNumber: "1800", amountCents: 100 }]))).toEqual({ key: "summaries.manual", params: { amount: 1, count: 1 } });
    expect(render([{ accountNumber: "1800", amountCents: 100 }, { accountNumber: "1360", amountCents: 50 }, { accountNumber: "2900", amountCents: -150 }])).toBe(
      "Buchung über 1,50 € mit 3 Zeilen.",
    );
  });
});
