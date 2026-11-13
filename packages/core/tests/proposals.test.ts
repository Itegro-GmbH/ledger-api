// The proposal engine's pure core (decisions/0080 phase 3) on the real the reference company cases of the
// brief: the reference company's chart (the SKR 04 seed plus the accounts the bank, Meta, Google Ads, Apple,
// Google Play and a shareholder own), one test per template, and every draft rendered through the
// deterministic summary and `de.json`.
import { createTranslator } from "use-intl/core";
import { describe, expect, it } from "vitest";

import de from "./fixtures/messages.de.json";
import {
  adviceQuestionsFor,
  buildProposals,
  createFakeLedgerBookingAdvisor,
  expandTaxLines,
  findAutoMatches,
  invoiceVatGroups,
  isBalanced,
  suggestMatchGroups,
  SKR04_SEED_ACCOUNTS,
  summarizeEntry,
  validateBookingAdvice,
  type BookingAdvice,
  type ExpandedLine,
  type ProposalAccount,
  type ProposalDocument,
  type ProposalDraft,
  type ProposalPlan,
  type ProposalSnapshot,
  type ProposalTransaction,
} from "../src";

const BANK = "bank-musterbank";
const META = "11111111-0000-4000-8000-000000000001";
const GOOGLE_ADS = "11111111-0000-4000-8000-000000000002";
const IONOS = "11111111-0000-4000-8000-000000000003";
const MUSTERBANK = "11111111-0000-4000-8000-000000000004";
const NOTARY = "11111111-0000-4000-8000-000000000005";
const COURT = "11111111-0000-4000-8000-000000000006";
const APPLE_IE = "11111111-0000-4000-8000-000000000007";
const CUSTOMER = "11111111-0000-4000-8000-000000000008";

const account = (number: string, name: string, overrides: Partial<ProposalAccount>): ProposalAccount => ({
  number,
  name,
  kind: "asset",
  group: "open_items",
  openItems: true,
  ownerType: null,
  ownerBankAccountId: null,
  ownerContactId: null,
  ownerPlatform: null,
  ownerPersonName: null,
  archived: false,
  ...overrides,
});

/** The seed chart with 1800 owned by Hausbank, plus the open-item accounts the reference company owns. */
function referenceChart(options: { person?: boolean } = {}): ProposalAccount[] {
  const seeded = SKR04_SEED_ACCOUNTS.map(
    (seed): ProposalAccount =>
      seed.number === "1800"
        ? account("1800", "Bank Hausbank", { kind: "asset", group: "bank", openItems: false, ownerType: "bank_account", ownerBankAccountId: BANK })
        : account(seed.number, seed.name, { kind: seed.kind, group: seed.group, openItems: seed.openItems }),
  );
  const owned = [
    account("1370", "Forderung Apple", { ownerType: "platform", ownerPlatform: "apple" }),
    account("1371", "Forderung Google Play", { ownerType: "platform", ownerPlatform: "google" }),
    account("1461", "Verrechnungskonto Meta", { ownerType: "contact", ownerContactId: META }),
    account("1462", "Verrechnungskonto Google Ads", { ownerType: "contact", ownerContactId: GOOGLE_ADS }),
  ];
  if (options.person !== false) owned.push(account("3511", "Auslagen Erika Mustermann", { kind: "liability", ownerType: "person", ownerPersonName: "Erika Mustermann" }));
  return [...seeded, ...owned];
}

function doc(id: string, overrides: Partial<ProposalDocument> = {}): ProposalDocument {
  return {
    id,
    kind: "incoming_invoice",
    direction: "incoming",
    status: "done",
    documentDate: "2026-07-01",
    effectiveDate: overrides.documentDate ?? "2026-07-01",
    title: "Rechnung",
    sender: null,
    summary: null,
    originalFileName: `${id}.pdf`,
    invoiceNumber: null,
    totalAmountCents: 100,
    currency: "EUR",
    platform: null,
    taxBreakdown: null,
    netTotalCents: null,
    taxTotalCents: null,
    passThroughCents: null,
    reverseCharge: null,
    serviceDate: null,
    servicePeriodFrom: null,
    servicePeriodTo: null,
    contactId: null,
    contactName: null,
    contactVatId: null,
    contactCountry: "DE",
    confirmedTransactions: [],
    ...overrides,
  };
}

function tx(id: string, amountCents: number, overrides: Partial<ProposalTransaction> = {}): ProposalTransaction {
  return {
    id,
    bankAccountId: BANK,
    bookingDate: "2026-07-05",
    amountCents,
    counterpartyName: null,
    counterpartyIban: null,
    remittanceText: null,
    resolvedContactId: null,
    pairedClearing: null,
    noDocumentNeeded: false,
    noDocumentRule: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ProposalSnapshot> = {}): ProposalSnapshot {
  return {
    startDate: "2026-06-01",
    accounts: referenceChart(),
    rules: [],
    documents: [],
    transactions: [],
    settlementLines: [],
    invoices: [],
    ownBankAccounts: [{ id: BANK, iban: "DE89370400440532013000" }],
    decidedSourceKeys: new Set(),
    ...overrides,
  };
}

/** Asks the deterministic fake every question the engine lists, validated like the use case. */
async function fakeAdvice(snap: ProposalSnapshot): Promise<Map<string, BookingAdvice | null>> {
  const advisor = createFakeLedgerBookingAdvisor();
  const advice = new Map<string, BookingAdvice | null>();
  for (const question of adviceQuestionsFor(snap)) advice.set(question.documentId, validateBookingAdvice(await advisor.advise(question), question));
  return advice;
}

async function plan(snap: ProposalSnapshot): Promise<ProposalPlan> {
  const labels: Record<string, string> = { google: "Google Play", apple: "Apple" };
  return buildProposals(snap, await fakeAdvice(snap), (platform) => labels[platform] ?? platform);
}

function draftFor(result: ProposalPlan, sourceKey: string): ProposalDraft {
  const found = result.drafts.find((draft) => draft.sourceKey === sourceKey);
  if (!found) throw new Error(`no draft for ${sourceKey}; have ${result.drafts.map((draft) => draft.sourceKey).join(", ")}`);
  return found;
}

/** The lines as they would be stored: tax lines generated, `[account, cents, taxCode, documentId]`. */
function booked(draft: ProposalDraft): [string, number, string | null, string | null][] {
  return expandTaxLines(draft.entry.lines).map((line: ExpandedLine) => [line.accountNumber, line.amountCents, line.taxCode, line.documentId]);
}

/** The deterministic sentence of a draft, rendered through `de.json` like the UI will. */
function sentence(draft: ProposalDraft, chart: readonly ProposalAccount[] = referenceChart()): string {
  const byNumber = new Map(chart.map((entry) => [entry.number, entry]));
  const ref = summarizeEntry(
    expandTaxLines(draft.entry.lines).map((line) => {
      const entry = byNumber.get(line.accountNumber)!;
      return {
        accountNumber: entry.number,
        accountName: entry.name,
        kind: entry.kind,
        group: entry.group,
        openItems: entry.openItems,
        ownerType: entry.ownerType,
        ownerPersonName: entry.ownerPersonName,
        amountCents: line.amountCents,
        taxCode: line.taxCode,
        taxRole: line.taxRole,
      };
    }),
  );
  const t = createTranslator({ locale: "de", messages: de, namespace: "Ledger" });
  // Intl puts a no-break space before the currency sign.
  return t(ref.key as Parameters<typeof t>[0], ref.params as never).replace(/\u00a0/g, " ");
}

/** Simulates booking every draft: the open-item lines with ids, for the matching functions. */
function openItemLines(drafts: readonly ProposalDraft[], chart: readonly ProposalAccount[] = referenceChart()) {
  const openItems = new Set(chart.filter((entry) => entry.openItems).map((entry) => entry.number));
  return drafts.flatMap((draft) =>
    expandTaxLines(draft.entry.lines)
      .filter((line) => openItems.has(line.accountNumber))
      .map((line) => ({ lineId: `${draft.sourceKey}#${line.position}`, accountId: line.accountNumber, amountCents: line.amountCents, documentId: line.documentId, bookingDate: draft.entry.bookingDate })),
  );
}

describe("buildProposals: incoming invoices", () => {
  it("IONOS 1,50: 6810 1,26 + 1406 0,24 against payables 3300, paid by bank, matched automatically", async () => {
    const snap = snapshot({
      documents: [
        doc("ionos", {
          contactId: IONOS,
          contactName: "IONOS SE",
          totalAmountCents: 150,
          taxBreakdown: [{ ratePercent: 19, netCents: 126, taxCents: 24 }],
          confirmedTransactions: [{ transactionId: "tx-ionos", allocatedAmountCents: 150 }],
        }),
      ],
      transactions: [tx("tx-ionos", -150, { counterpartyName: "IONOS SE", resolvedContactId: IONOS })],
    });
    const result = await plan(snap);
    const invoice = draftFor(result, "doc:ionos");
    expect(invoice.origin).toBe("ai");
    expect(invoice.warnings).toEqual([]);
    expect(booked(invoice)).toEqual([
      ["6810", 126, "vst19", null],
      ["1406", 24, "vst19", null],
      ["3300", -150, null, "ionos"],
    ]);
    const payment = draftFor(result, "tx:tx-ionos");
    expect(payment.template).toBe("bank_document_payment");
    expect(booked(payment)).toEqual([
      ["1800", -150, null, null],
      ["3300", 150, null, "ionos"],
    ]);
    expect(sentence(invoice)).toBe("1,50 € für Internetkosten, gebucht gegen Verbindlichkeiten aus Lieferungen und Leistungen, bis die Zahlung ausgeglichen ist.");
    expect(sentence(payment)).toBe("Zahlung von 1,50 € von Bank Hausbank, gebucht auf Verbindlichkeiten aus Lieferungen und Leistungen.");
    expect(findAutoMatches(openItemLines(result.drafts))).toEqual([{ accountId: "3300", documentId: "ionos", lineIds: ["doc:ionos#3", "tx:tx-ionos#2"] }]);
  });

  it("Meta prepaid credit: the top-up goes to 1461, every reverse-charge invoice consumes it, the rest stays open", async () => {
    const meta = { contactId: META, contactName: "Meta Platforms Ireland Ltd.", contactCountry: "IE", contactVatId: "IE9692928F", reverseCharge: true };
    const snap = snapshot({
      documents: [doc("meta-1", { ...meta, totalAmountCents: 2 }), doc("meta-2", { ...meta, totalAmountCents: 1300 }), doc("meta-3", { ...meta, totalAmountCents: 8654 })],
      transactions: [tx("tx-topup", -10_000, { counterpartyName: "FACEBK *QX7MNP41KD", resolvedContactId: META })],
    });
    const result = await plan(snap);
    const topUp = draftFor(result, "tx:tx-topup");
    expect(topUp.template).toBe("bank_contact_account");
    expect(booked(topUp)).toEqual([
      ["1800", -10_000, null, null],
      ["1461", 10_000, null, null],
    ]);
    const invoice = draftFor(result, "doc:meta-2");
    expect(booked(invoice)).toEqual([
      ["6600", 1300, "rc13b", null],
      ["1407", 247, "rc13b", null],
      ["3837", -247, "rc13b", null],
      ["1461", -1300, null, "meta-2"],
    ]);
    expect(sentence(invoice)).toContain("§ 13b UStG");
    const lines = openItemLines(result.drafts);
    expect(lines.filter((line) => line.accountId === "1461").reduce((sum, line) => sum + line.amountCents, 0)).toBe(44);
    expect(findAutoMatches(lines)).toEqual([]);
  });

  it("Google Ads: charged 10 + 50 + 36,57 before one invoice of 96,57; the account reaches zero only as a suggested group", async () => {
    const gads = { contactId: GOOGLE_ADS, contactName: "Google Ireland Limited", contactCountry: "IE", contactVatId: "IE6388047V", title: "Google Ads Rechnung", reverseCharge: true };
    const charge = (id: string, cents: number, date: string) => tx(id, -cents, { bookingDate: date, counterpartyName: "GOOGLE *ADS1234", resolvedContactId: GOOGLE_ADS });
    const snap = snapshot({
      documents: [doc("gads", { ...gads, documentDate: "2026-08-31", effectiveDate: "2026-08-31", totalAmountCents: 9657 })],
      transactions: [charge("c1", 1000, "2026-08-05"), charge("c2", 5000, "2026-08-19"), charge("c3", 3657, "2026-09-02")],
    });
    const result = await plan(snap);
    expect(booked(draftFor(result, "doc:gads"))).toContainEqual(["1462", -9657, null, "gads"]);
    expect(booked(draftFor(result, "doc:gads"))[0]).toEqual(["6600", 9657, "rc13b", null]);
    for (const id of ["c1", "c2", "c3"]) expect(draftFor(result, `tx:${id}`).entry.lines[1]!.accountNumber).toBe("1462");
    const lines = openItemLines(result.drafts);
    expect(findAutoMatches(lines)).toEqual([]);
    const suggestions = suggestMatchGroups(lines);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ accountId: "1462", reason: "subset_sum", amountCents: 9657 });
    expect(suggestions[0]!.lineIds).toHaveLength(4);
  });

  it("notary 815,83 with 9,00 pass-through, paid by the shareholder and refunded by the bank: both sides on his own account", async () => {
    const snap = snapshot({
      documents: [
        doc("notary", {
          contactId: NOTARY,
          contactName: "Notar Dr. Beispiel",
          title: "Kostenrechnung Notar",
          totalAmountCents: 81_583,
          taxBreakdown: [{ ratePercent: 19, netCents: 67_801, taxCents: 12_882 }],
          passThroughCents: 900,
          confirmedTransactions: [{ transactionId: "tx-refund", allocatedAmountCents: 81_583 }],
        }),
      ],
      transactions: [tx("tx-refund", -81_583, { counterpartyName: "Erika Mustermann", remittanceText: "Auslage Notar" })],
    });
    const result = await plan(snap);
    const invoice = draftFor(result, "doc:notary");
    expect(booked(invoice)).toEqual([
      ["6825", 67_801, "vst19", null],
      ["1406", 12_882, "vst19", null],
      ["6825", 900, "pass_through", null],
      ["3511", -81_583, null, "notary"],
    ]);
    expect(invoice.warnings).toEqual([]);
    expect(sentence(invoice)).toBe("815,83 € für Rechts- und Beratungskosten, privat bezahlt von Erika Mustermann. Die Gesellschaft erstattet den Betrag.");
    const refund = draftFor(result, "tx:tx-refund");
    expect(booked(refund)).toEqual([
      ["1800", -81_583, null, null],
      ["3511", 81_583, null, "notary"],
    ]);
    expect(findAutoMatches(openItemLines(result.drafts))).toHaveLength(1);
  });

  it("notary without a shareholder account: the matched refund still settles payables; an unmatched one is left as a problem, no guess", async () => {
    const chart = referenceChart({ person: false });
    const notary = doc("notary", { contactId: NOTARY, contactName: "Notar Dr. Beispiel", totalAmountCents: 81_583, taxBreakdown: [{ ratePercent: 19, netCents: 67_801, taxCents: 12_882 }], passThroughCents: 900 });
    const matched = await plan(snapshot({ accounts: chart, documents: [{ ...notary, confirmedTransactions: [{ transactionId: "tx-refund", allocatedAmountCents: 81_583 }] }], transactions: [tx("tx-refund", -81_583, { counterpartyName: "Erika Mustermann" })] }));
    expect(booked(draftFor(matched, "doc:notary")).at(-1)).toEqual(["3300", -81_583, null, "notary"]);
    expect(booked(draftFor(matched, "tx:tx-refund")).at(-1)).toEqual(["3300", 81_583, null, "notary"]);

    const unmatched = await plan(snapshot({ accounts: chart, documents: [notary], transactions: [tx("tx-refund", -81_583, { counterpartyName: "Erika Mustermann", remittanceText: "Auslage" })] }));
    expect(unmatched.drafts.map((draft) => draft.sourceKey)).toEqual(["doc:notary"]);
    expect(unmatched.unproposed).toEqual(["tx:tx-refund"]);
  });

  it("warns about possible pass-through costs on a notary invoice with VAT and no pass-through extracted", async () => {
    const result = await plan(snapshot({ documents: [doc("notary", { contactName: "Notar Dr. Beispiel", totalAmountCents: 11_900, taxBreakdown: [{ ratePercent: 19, netCents: 10_000, taxCents: 1900 }] })] }));
    expect(draftFor(result, "doc:notary").warnings).toEqual(["possible_pass_through"]);
  });

  it("court letter 300 + 5 dunning fee: the AI fake splits it, no VAT", async () => {
    const result = await plan(
      snapshot({
        documents: [doc("court", { kind: "authority_letter", contactId: COURT, contactName: "Amtsgericht Charlottenburg", title: "Kostenrechnung", summary: "Gerichtskosten 300,00 EUR und Mahngebühr 5,00 EUR", totalAmountCents: 30_500 })],
      }),
    );
    const court = draftFor(result, "doc:court");
    expect(court.origin).toBe("ai");
    expect(court.originReason).toMatch(/Mahngebühr/);
    expect(booked(court)).toEqual([
      ["6825", 30_000, "not_taxable", null],
      ["6300", 500, "not_taxable", null],
      ["3300", -30_500, null, "court"],
    ]);
    expect(sentence(court)).toBe("305,00 € aufgeteilt auf 2 Konten.");
  });

  it("Musterbank from the Netherlands with 19 % German VAT, Apple from Ireland with German VAT: booked as printed, flagged", async () => {
    const result = await plan(
      snapshot({
        documents: [
          doc("musterbank", { contactId: MUSTERBANK, contactName: "Musterbank B.V.", contactCountry: "NL", contactVatId: "NL862287339B01", totalAmountCents: 1190, taxBreakdown: [{ ratePercent: 19, netCents: 1000, taxCents: 190 }] }),
          doc("apple", { contactId: APPLE_IE, contactName: "Apple Distribution International Ltd.", contactCountry: null, contactVatId: "IE9700053D", totalAmountCents: 299, taxBreakdown: [{ ratePercent: 19, netCents: 251, taxCents: 48 }] }),
        ],
      }),
    );
    for (const key of ["doc:musterbank", "doc:apple"]) {
      expect(draftFor(result, key).warnings).toContain("foreign_supplier_with_vat");
      expect(draftFor(result, key).entry.lines[0]!.taxCode).toBe("vst19");
    }
    expect(booked(draftFor(result, "doc:apple")).slice(0, 2)).toEqual([
      ["6837", 251, "vst19", null],
      ["1406", 48, "vst19", null],
    ]);
  });

  it("several printed rates: one base line per rate with the exact printed tax", async () => {
    const result = await plan(
      snapshot({ documents: [doc("mixed", { contactName: "Bürobedarf Müller", totalAmountCents: 1_726, taxBreakdown: [{ ratePercent: 19, netCents: 1000, taxCents: 191 }, { ratePercent: 7, netCents: 500, taxCents: 35 }] })] }),
    );
    expect(booked(draftFor(result, "doc:mixed"))).toEqual([
      ["6815", 1000, "vst19", null],
      ["1406", 191, "vst19", null],
      ["6815", 500, "vst7", null],
      ["1401", 35, "vst7", null],
      ["3300", -1_726, null, "mixed"],
    ]);
  });

  it("no tax figures at all: input tax derived from the gross, flagged", async () => {
    const result = await plan(snapshot({ documents: [doc("plain", { contactName: "Irgendwer GmbH", totalAmountCents: 119 })] }));
    const plain = draftFor(result, "doc:plain");
    expect(plain.warnings).toEqual(["no_tax_breakdown"]);
    expect(booked(plain)).toEqual([
      ["6300", 100, "vst19", null],
      ["1406", 19, "vst19", null],
      ["3300", -119, null, "plain"],
    ]);
  });

  it("a rule of the contact decides account, tax code and open-item account, and the AI is not asked", async () => {
    const snap = snapshot({
      rules: [{ id: "rule-ionos", contactId: IONOS, counterpartyPattern: null, direction: "incoming", accountNumber: "6810", taxCode: "vst19", paymentAccountNumber: null, noDocument: false }],
      documents: [doc("ionos", { contactId: IONOS, contactName: "IONOS SE", totalAmountCents: 150 })],
    });
    expect(adviceQuestionsFor(snap)).toEqual([]);
    const draft = draftFor(buildProposals(snap, new Map()), "doc:ionos");
    expect(draft).toMatchObject({ origin: "rule", originReason: "rule:rule-ionos", warnings: [] });
    expect(booked(draft)[0]).toEqual(["6810", 126, "vst19", null]);
  });

  it("AI unavailable: the template default 6300 with a warning; an unanswered question is deferred", async () => {
    const snap = snapshot({ documents: [doc("a", { contactName: "Irgendwer GmbH", totalAmountCents: 119, taxBreakdown: [{ ratePercent: 19, netCents: 100, taxCents: 19 }] }), doc("b", { totalAmountCents: 500 })] });
    const result = buildProposals(snap, new Map([["a", null]]));
    expect(draftFor(result, "doc:a")).toMatchObject({ origin: "template", originReason: "template:incoming_invoice", warnings: ["ai_unavailable"] });
    expect(draftFor(result, "doc:a").entry.lines[0]!.accountNumber).toBe("6300");
    expect(result.deferred).toEqual(["doc:b"]);
  });

  it("flags a second document with the same contact, invoice number and amount as a duplicate", async () => {
    const twin = { contactId: IONOS, contactName: "IONOS SE", invoiceNumber: "RE-7", totalAmountCents: 150, taxBreakdown: [{ ratePercent: 19, netCents: 126, taxCents: 24 }] };
    const result = await plan(snapshot({ documents: [doc("first", { ...twin, documentDate: "2026-07-01" }), doc("second", { ...twin, documentDate: "2026-07-02", effectiveDate: "2026-07-02" })] }));
    expect(draftFor(result, "doc:first").warnings).toEqual([]);
    expect(draftFor(result, "doc:second").warnings).toEqual(["duplicate_suspect"]);
  });

  it("warns when the confirmed payments do not cover the invoice", async () => {
    const result = await plan(
      snapshot({
        documents: [doc("part", { contactName: "IONOS SE", totalAmountCents: 1000, taxBreakdown: [{ ratePercent: 19, netCents: 840, taxCents: 160 }], confirmedTransactions: [{ transactionId: "t", allocatedAmountCents: 980 }] })],
        transactions: [tx("t", -980)],
      }),
    );
    expect(draftFor(result, "doc:part").warnings).toContain("amount_differs_from_payment");
    expect(draftFor(result, "tx:t").warnings).toContain("amount_differs_from_payment");
    expect(booked(draftFor(result, "tx:t"))).toEqual([
      ["1800", -980, null, null],
      ["3300", 980, null, "part"],
    ]);
  });
});

describe("buildProposals: no reverse charge guessed without tax figures", () => {
  const appleDeveloper = { contactId: APPLE_IE, contactName: "Apple Distribution International Ltd.", contactCountry: "IE", contactVatId: "IE9700053D", title: "Apple Developer Program", totalAmountCents: 9900 };

  it("Apple Developer invoice from Ireland without a breakdown: kept, but flagged tax_unverified", async () => {
    const result = await plan(snapshot({ documents: [doc("apple-dev", appleDeveloper)] }));
    const draft = draftFor(result, "doc:apple-dev");
    expect(draft.origin).toBe("ai");
    expect(draft.warnings).toContain("tax_unverified");
    expect(draft.entry.lines[0]!.taxCode).toBe("rc13b");
  });

  it("the same invoice with its printed breakdown 83,19 + 15,81: vst19, flagged as a foreign supplier with VAT", async () => {
    const result = await plan(snapshot({ documents: [doc("apple-dev", { ...appleDeveloper, taxBreakdown: [{ ratePercent: 19, netCents: 8319, taxCents: 1581 }] })] }));
    const draft = draftFor(result, "doc:apple-dev");
    expect(draft.warnings).toEqual(["foreign_supplier_with_vat"]);
    expect(booked(draft).slice(0, 2)).toEqual([
      ["6837", 8319, "vst19", null],
      ["1406", 1581, "vst19", null],
    ]);
  });

  it("Musterbank with its printed breakdown 107,88 + 20,50: vst19 on 6855, flagged as a foreign supplier with VAT", async () => {
    const result = await plan(
      snapshot({
        documents: [doc("musterbank", { contactId: MUSTERBANK, contactName: "Musterbank B.V.", contactCountry: "NL", contactVatId: "NL862287339B01", title: "Kontoführung", totalAmountCents: 12_838, taxBreakdown: [{ ratePercent: 19, netCents: 10_788, taxCents: 2050 }] })],
      }),
    );
    const draft = draftFor(result, "doc:musterbank");
    expect(draft.warnings).toEqual(["foreign_supplier_with_vat"]);
    expect(booked(draft).slice(0, 2)).toEqual([
      ["6855", 10_788, "vst19", null],
      ["1406", 2050, "vst19", null],
    ]);
  });

  it("Meta with the reverse-charge note: rc13b without a warning", async () => {
    const result = await plan(
      snapshot({ documents: [doc("meta", { contactId: META, contactName: "Meta Platforms Ireland Ltd.", contactCountry: "IE", contactVatId: "IE9692928F", reverseCharge: true, totalAmountCents: 6000 })] }),
    );
    const draft = draftFor(result, "doc:meta");
    expect(draft.warnings).toEqual([]);
    expect(draft.entry.lines[0]!.taxCode).toBe("rc13b");
  });

  it("a rule's tax code wins and needs no warning", async () => {
    const snap = snapshot({
      rules: [{ id: "rule-apple", contactId: APPLE_IE, counterpartyPattern: null, direction: "incoming", accountNumber: "6837", taxCode: "vst19", paymentAccountNumber: null, noDocument: false }],
      documents: [doc("apple-dev", appleDeveloper)],
    });
    const draft = draftFor(buildProposals(snap, new Map()), "doc:apple-dev");
    expect(draft).toMatchObject({ origin: "rule", warnings: [] });
    expect(booked(draft).slice(0, 2)).toEqual([
      ["6837", 8319, "vst19", null],
      ["1406", 1581, "vst19", null],
    ]);
  });

  it("the template default (AI unavailable) is flagged too, so it never counts as safe", async () => {
    const draft = draftFor(buildProposals(snapshot({ documents: [doc("apple-dev", appleDeveloper)] }), new Map([["apple-dev", null]])), "doc:apple-dev");
    expect(draft.origin).toBe("template");
    expect(draft.warnings).toEqual(["ai_unavailable", "tax_unverified"]);
  });

  it("an AI answer of rc13b for a supplier of unknown country without tax figures is flagged", async () => {
    const unknown = doc("unknown", { contactName: "Some Vendor Ltd", contactCountry: null, totalAmountCents: 5000 });
    const advice = validateBookingAdvice({ accountNumber: "6837", taxCode: "rc13b", reason: "Ausländische Software." }, adviceQuestionsFor(snapshot({ documents: [unknown] }))[0]!);
    expect(advice).toMatchObject({ taxCode: "rc13b", taxUnverified: true });
    const draft = draftFor(buildProposals(snapshot({ documents: [unknown] }), new Map([["unknown", advice]])), "doc:unknown");
    expect(draft.warnings).toEqual(["tax_unverified"]);
    expect(draft.entry.lines[0]!.taxCode).toBe("rc13b");
  });
});

describe("buildProposals: printed tax wins over a pass-through or reverse-charge guess", () => {
  const notaryAdvice = new Map<string, BookingAdvice | null>([["notary", { accountNumber: "6825", taxCode: "pass_through", split: null, reason: "Notarkosten." }]]);
  // As extracted in production: two partial invoices, only one of the two "Summe durchlaufende
  // Posten | 4,50" lines, so net + tax + pass-through is 4,50 short of the total.
  const notary = doc("notary", {
    contactId: NOTARY,
    contactName: "Notar Dr. Beispiel",
    title: "Kostenrechnung Notar",
    totalAmountCents: 81_583,
    taxBreakdown: [{ ratePercent: 19, netCents: 67_800, taxCents: 12_883 }],
    netTotalCents: 67_800,
    taxTotalCents: 12_883,
    passThroughCents: 450,
  });

  it("notary with one of two pass-through sums: books the printed breakdown, the rest as pass-through, flagged", async () => {
    const draft = draftFor(buildProposals(snapshot({ accounts: referenceChart({ person: false }), documents: [notary] }), notaryAdvice), "doc:notary");
    expect(booked(draft)).toEqual([
      ["6825", 67_800, "vst19", null],
      ["1406", 12_883, "vst19", null],
      ["6825", 900, "pass_through", null],
      ["3300", -81_583, null, "notary"],
    ]);
    expect(draft.warnings).toEqual(["tax_inconsistent"]);
  });

  it("a gap larger than 10 % of the total is no pass-through: the AI's pass_through is overridden by the printed rate", async () => {
    const draft = draftFor(buildProposals(snapshot({ accounts: referenceChart({ person: false }), documents: [{ ...notary, totalAmountCents: 100_000, passThroughCents: null }] }), notaryAdvice), "doc:notary");
    expect(draft.entry.lines[0]).toMatchObject({ accountNumber: "6825", amountCents: 100_000, taxCode: "vst19", amountMode: "gross" });
    expect(booked(draft).map((line) => line[2])).not.toContain("pass_through");
    expect(draft.warnings).toContain("tax_inconsistent");
  });

  it("a negative gap: the AI's not_taxable never replaces printed tax", async () => {
    const advice = new Map<string, BookingAdvice | null>([["notary", { accountNumber: "6825", taxCode: "not_taxable", split: null, reason: "Notarkosten." }]]);
    const draft = draftFor(buildProposals(snapshot({ accounts: referenceChart({ person: false }), documents: [{ ...notary, totalAmountCents: 70_000, passThroughCents: null }] }), advice), "doc:notary");
    expect(draft.entry.lines[0]).toMatchObject({ amountCents: 70_000, taxCode: "vst19", amountMode: "gross" });
    expect(draft.warnings).toContain("tax_inconsistent");
  });

  it("Musterbank with a conditional reverse-charge footnote and printed 19 %: vst19 as printed, flagged twice", async () => {
    const result = await plan(
      snapshot({
        documents: [
          doc("musterbank", { contactId: MUSTERBANK, contactName: "Musterbank B.V.", contactCountry: "NL", contactVatId: "NL862287339B01", title: "Kontoführung", reverseCharge: true, totalAmountCents: 12_838, taxBreakdown: [{ ratePercent: 19, netCents: 10_788, taxCents: 2050 }] }),
        ],
      }),
    );
    const draft = draftFor(result, "doc:musterbank");
    expect(draft.warnings).toEqual(["foreign_supplier_with_vat", "reverse_charge_conflict"]);
    expect(booked(draft)).toEqual([
      ["6855", 10_788, "vst19", null],
      ["1406", 2050, "vst19", null],
      ["3300", -12_838, null, "musterbank"],
    ]);
  });

  it("Meta with the reverse-charge note and no printed tax stays rc13b without a warning", async () => {
    const result = await plan(
      snapshot({ documents: [doc("meta", { contactId: META, contactName: "Meta Platforms Ireland Ltd.", contactCountry: "IE", contactVatId: "IE9692928F", reverseCharge: true, totalAmountCents: 6000 })] }),
    );
    const draft = draftFor(result, "doc:meta");
    expect(draft.warnings).toEqual([]);
    expect(draft.entry.lines.map((line) => line.taxCode ?? null)).toEqual(["rc13b", null]);
  });
});

describe("buildProposals: outgoing invoices", () => {
  it("an invoice issued in Digipost at 19 %: receivables 1200 against 4400 and 3806; its inbox document is not booked twice", async () => {
    const groups = invoiceVatGroups([{ quantity: "10", unitPrice: "95.00", category: "S", ratePercent: 19 }], { netCents: 95_000, vatCents: 18_050 });
    const result = await plan(
      snapshot({
        invoices: [{ id: "inv-1", number: "RE-2026-0001", type: "invoice", issueDate: "2026-07-10", serviceDate: null, contactId: CUSTOMER, buyerName: "Kunde GmbH", buyerCountry: "DE", documentId: "inv-doc", groups }],
        documents: [doc("inv-doc", { kind: "outgoing_invoice", direction: "outgoing", totalAmountCents: 113_050, confirmedTransactions: [{ transactionId: "tx-in", allocatedAmountCents: 113_050 }] })],
        transactions: [tx("tx-in", 113_050, { counterpartyName: "Kunde GmbH" })],
      }),
    );
    const invoice = draftFor(result, "invoice:inv-1");
    expect(booked(invoice)).toEqual([
      ["1200", 113_050, null, "inv-doc"],
      ["4400", -95_000, "ust19", null],
      ["3806", -18_050, "ust19", null],
    ]);
    expect(sentence(invoice)).toBe("Einnahme von 1.130,50 € auf Erlöse 19 % USt, gegen Forderungen aus Lieferungen und Leistungen.");
    expect(result.drafts.some((draft) => draft.sourceKey === "doc:inv-doc")).toBe(false);
    expect(booked(draftFor(result, "tx:tx-in"))).toEqual([
      ["1800", 113_050, null, null],
      ["1200", -113_050, null, "inv-doc"],
    ]);
    expect(sentence(draftFor(result, "tx:tx-in"))).toBe("Zahlungseingang von 1.130,50 € auf Bank Hausbank, gebucht auf Forderungen aus Lieferungen und Leistungen.");
  });

  it("a cancellation negates; reverse charge to an EU business goes to 4339", async () => {
    const result = await plan(
      snapshot({
        invoices: [
          { id: "storno", number: "RE-2026-0002", type: "cancellation", issueDate: "2026-07-11", serviceDate: null, contactId: null, buyerName: "Kunde GmbH", buyerCountry: "DE", documentId: null, groups: invoiceVatGroups([{ quantity: "-10", unitPrice: "95.00", category: "S", ratePercent: 19 }], { netCents: -95_000, vatCents: -18_050 }) },
          { id: "eu", number: "RE-2026-0003", type: "invoice", issueDate: "2026-07-12", serviceDate: null, contactId: null, buyerName: "Klant B.V.", buyerCountry: "NL", documentId: null, groups: invoiceVatGroups([{ quantity: "1", unitPrice: "500", category: "AE", ratePercent: 0 }], { netCents: 50_000, vatCents: 0 }) },
        ],
      }),
    );
    expect(booked(draftFor(result, "invoice:storno"))).toEqual([
      ["1200", -113_050, null, null],
      ["4400", 95_000, "ust19", null],
      ["3806", 18_050, "ust19", null],
    ]);
    expect(booked(draftFor(result, "invoice:eu"))).toEqual([
      ["1200", 50_000, null, null],
      ["4339", -50_000, "eu_not_taxable", null],
    ]);
  });

  it("an outgoing invoice document not issued in Digipost books from its printed tax fields", async () => {
    const result = await plan(snapshot({ documents: [doc("out", { kind: "outgoing_invoice", direction: "outgoing", totalAmountCents: 23_800, taxBreakdown: [{ ratePercent: 19, netCents: 20_000, taxCents: 3_800 }] })] }));
    expect(booked(draftFor(result, "doc:out"))).toEqual([
      ["1200", 23_800, null, "out"],
      ["4400", -20_000, "ust19", null],
      ["3806", -3_800, "ust19", null],
    ]);
  });

  it("invoiceVatGroups reconciles a rounding cent to the stored totals", () => {
    const groups = invoiceVatGroups(
      [
        { quantity: "3", unitPrice: "0.333", category: "S", ratePercent: 19 },
        { quantity: "1", unitPrice: "10", category: "S", ratePercent: 7 },
      ],
      { netCents: 1100, vatCents: 89 },
    );
    expect(groups.reduce((sum, group) => sum + group.netCents, 0)).toBe(1100);
    expect(groups.reduce((sum, group) => sum + group.vatCents, 0)).toBe(89);
  });
});

describe("buildProposals: platform reports and payouts", () => {
  it("Apple: one report per month (revenue 4339, fees 6855) against 1370, settled by its payout", async () => {
    const report = doc("apple-07", { kind: "payout_report", direction: "unknown", platform: "apple", totalAmountCents: null, servicePeriodTo: "2026-07-31" });
    const result = await plan(
      snapshot({
        documents: [report],
        settlementLines: [
          { id: "r1", documentId: "apple-07", platform: "apple", type: "revenue", grossCents: 7000, feeCents: 1180, netCents: 5820, bookingDate: "2026-07-15" },
          { id: "f1", documentId: "apple-07", platform: "apple", type: "fee", grossCents: 7000, feeCents: 1180, netCents: 5820, bookingDate: "2026-07-15" },
        ],
        transactions: [tx("payout", 5820, { bookingDate: "2026-08-28", counterpartyName: "Apple Distribution", pairedClearing: { platform: "apple", contactId: null, reportDocumentIds: ["apple-07"] } })],
      }),
    );
    const settlement = draftFor(result, "settlement:apple-07:2026-07");
    expect(settlement.entry.bookingDate).toBe("2026-07-31");
    expect(booked(settlement)).toEqual([
      ["4339", -7000, "eu_not_taxable", null],
      ["6855", 1180, null, null],
      ["1370", 5820, null, "apple-07"],
    ]);
    expect(sentence(settlement)).toBe("Abrechnung über Forderung Apple: Einnahmen von 70,00 €, abzüglich Gebühren von 11,80 €.");
    expect(booked(draftFor(result, "tx:payout"))).toEqual([
      ["1800", 5820, null, null],
      ["1370", -5820, null, "apple-07"],
    ]);
    expect(findAutoMatches(openItemLines(result.drafts))).toHaveLength(1);
  });

  it("Google Play: three monthly reports, one payout of 36,94 bundling them; fees reverse charge; suggested as one group", async () => {
    const months = [
      ["gp-06", "2026-06", 1412, 212],
      ["gp-07", "2026-07", 1530, 230],
      ["gp-08", "2026-08", 1405, 211],
    ] as const;
    const result = await plan(
      snapshot({
        documents: months.map(([id, month]) => doc(id, { kind: "platform_settlement", direction: "unknown", platform: "google", totalAmountCents: null, servicePeriodTo: `${month}-${month === "2026-06" ? "30" : "31"}` })),
        settlementLines: months.flatMap(([id, month, gross, fee]) => [
          { id: `${id}-r`, documentId: id, platform: "google", type: "revenue" as const, grossCents: gross, feeCents: null, netCents: null, bookingDate: `${month}-10` },
          { id: `${id}-f`, documentId: id, platform: "google", type: "fee" as const, grossCents: null, feeCents: -fee, netCents: null, bookingDate: `${month}-10` },
        ]),
        transactions: [tx("gp-payout", 3694, { bookingDate: "2026-09-15", counterpartyName: "Google Payment Ireland", pairedClearing: { platform: "google", contactId: null, reportDocumentIds: [] } })],
      }),
    );
    expect(booked(draftFor(result, "settlement:gp-07:2026-07"))).toEqual([
      ["4339", -1530, "eu_not_taxable", null],
      ["6855", 230, "rc13b", null],
      ["1407", 44, "rc13b", null],
      ["3837", -44, "rc13b", null],
      ["1371", 1300, null, "gp-07"],
    ]);
    expect(booked(draftFor(result, "tx:gp-payout"))).toEqual([
      ["1800", 3694, null, null],
      ["1371", -3694, null, null],
    ]);
    const lines = openItemLines(result.drafts);
    expect(lines.filter((line) => line.accountId === "1371").reduce((sum, line) => sum + line.amountCents, 0)).toBe(0);
    const suggestions = suggestMatchGroups(lines);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.lineIds).toHaveLength(4);
  });
});

describe("buildProposals: Google Play fee refunds (July 2026)", () => {
  // The owner's July report: charges minus a charge refund are 13,36, Google's fees minus the
  // refunded fees 2,01, net 11,35. A refunded fee is a fee line with a positive amount
  // (`src/modules/accounts`' reader, corrected 2026-11); stored as revenue it had booked
  // revenue 36,29 and fees 24,94.
  const report = doc("gp-07", { kind: "platform_settlement", direction: "unknown", platform: "google", totalAmountCents: null, servicePeriodTo: "2026-07-31" });
  const line = (id: string, type: "revenue" | "refund" | "fee", cents: number) => ({
    id,
    documentId: "gp-07",
    platform: "google",
    type,
    grossCents: type === "fee" ? null : cents,
    feeCents: type === "fee" ? cents : null,
    netCents: cents,
    bookingDate: "2026-07-12",
  });

  it("books revenue as charges minus charge refunds and fees as fees minus fee refunds", async () => {
    const result = await plan(
      snapshot({
        documents: [report],
        settlementLines: [
          line("charge-1", "revenue", 1430),
          line("charge-2", "revenue", 1070),
          line("charge-refund", "refund", -1164),
          line("fee-1", "fee", -375),
          line("fee-2", "fee", -2119),
          line("fee-refund-1", "fee", 1071),
          line("fee-refund-2", "fee", 1222),
        ],
      }),
    );
    expect(booked(draftFor(result, "settlement:gp-07:2026-07"))).toEqual([
      ["4339", -1336, "eu_not_taxable", null],
      ["6855", 201, "rc13b", null],
      ["1407", 38, "rc13b", null],
      ["3837", -38, "rc13b", null],
      ["1371", 1135, null, "gp-07"],
    ]);
  });

  it("still deducts a fee stated as a positive magnitude next to its sale", async () => {
    const result = await plan(
      snapshot({
        documents: [report],
        settlementLines: [
          { id: "r", documentId: "gp-07", platform: "google", type: "revenue", grossCents: 1000, feeCents: 150, netCents: 850, bookingDate: "2026-07-12" },
          { id: "f", documentId: "gp-07", platform: "google", type: "fee", grossCents: 1000, feeCents: 150, netCents: 850, bookingDate: "2026-07-12" },
        ],
      }),
    );
    expect(booked(draftFor(result, "settlement:gp-07:2026-07")).map(([accountNumber, cents]) => [accountNumber, cents])).toEqual([
      ["4339", -1000],
      ["6855", 150],
      ["1407", 29],
      ["3837", -29],
      ["1371", 850],
    ]);
  });
});

describe("buildProposals: bank transactions", () => {
  it("share capital via a no-document rule (wins over the shareholder's own account)", async () => {
    const result = await plan(
      snapshot({
        rules: [{ id: "rule-capital", contactId: null, counterpartyPattern: "erika mustermann", direction: "outgoing", accountNumber: "2900", taxCode: null, paymentAccountNumber: null, noDocument: true }],
        transactions: [tx("capital", 416_700, { counterpartyName: "Erika Mustermann", remittanceText: "Stammeinlage" })],
      }),
    );
    const capital = draftFor(result, "tx:capital");
    expect(capital).toMatchObject({ origin: "rule", originReason: "rule:rule-capital", template: "bank_no_document_rule" });
    expect(booked(capital)).toEqual([
      ["1800", 416_700, null, null],
      ["2900", -416_700, null, null],
    ]);
    expect(sentence(capital)).toBe("Zahlungseingang von 4.167,00 € auf Bank Hausbank, gebucht auf Gezeichnetes Kapital.");
  });

  it("a transfer to another own bank account goes to 1360 Geldtransit; an unexplained debit gets no proposal", async () => {
    const result = await plan(
      snapshot({
        ownBankAccounts: [
          { id: BANK, iban: "DE89370400440532013000" },
          { id: "bank-2", iban: "DE02120300000000202051" },
        ],
        transactions: [tx("move", -50_000, { counterpartyIban: "DE02 1203 0000 0000 2020 51" }), tx("mystery", -999, { counterpartyName: "Unbekannt" })],
      }),
    );
    expect(booked(draftFor(result, "tx:move"))[1]).toEqual(["1360", 50_000, null, null]);
    expect(result.unproposed).toEqual(["tx:mystery"]);
  });

  it("is idempotent by source key: decided keys are skipped, sources before the start date or outside the period are not proposed", async () => {
    const snap = snapshot({
      documents: [doc("old", { documentDate: "2026-05-15", effectiveDate: "2026-05-15", totalAmountCents: 119 }), doc("done", { totalAmountCents: 119 }), doc("aug", { documentDate: "2026-08-02", effectiveDate: "2026-08-02", totalAmountCents: 119 })],
      decidedSourceKeys: new Set(["doc:done"]),
    });
    expect((await plan(snap)).drafts.map((draft) => draft.sourceKey)).toEqual(["doc:aug"]);
    expect(adviceQuestionsFor(snap).map((question) => question.documentId)).toEqual(["aug"]);
    expect((await plan({ ...snap, from: "2026-07-01", to: "2026-07-31" })).drafts).toEqual([]);
  });

  it("every draft balances once its tax lines are generated", async () => {
    const result = await plan(
      snapshot({
        documents: [doc("a", { totalAmountCents: 81_583, taxBreakdown: [{ ratePercent: 19, netCents: 67_801, taxCents: 12_882 }], passThroughCents: 900 }), doc("b", { totalAmountCents: -500, contactCountry: "IE" })],
        transactions: [tx("t", -100, { resolvedContactId: META })],
      }),
    );
    expect(result.drafts.length).toBe(3);
    for (const draft of result.drafts) expect(isBalanced(expandTaxLines(draft.entry.lines))).toBe(true);
  });
});

describe("buildProposals: fixes from the acceptance replay and the review", () => {
  it("A1: a rule pattern matches the remittance text too, and the rule wins over the shareholder's own account", async () => {
    const result = await plan(
      snapshot({
        rules: [{ id: "rule-stammeinlage", contactId: null, counterpartyPattern: "stammeinlage", direction: "any", accountNumber: "2900", taxCode: null, paymentAccountNumber: null, noDocument: true }],
        transactions: [
          tx("erika", 833_400, { bookingDate: "2026-06-01", counterpartyName: "Erika Mustermann", remittanceText: "Stammeinlage Erika Mustermann" }),
          tx("max", 833_300, { bookingDate: "2026-06-01", counterpartyName: "Max Mustermann", remittanceText: "Stammeinlage Max Mustermann" }),
          tx("eva", 833_300, { bookingDate: "2026-06-01", counterpartyName: "Eva Beispiel", remittanceText: "Stammeinlage Eva Beispiel" }),
        ],
      }),
    );
    for (const [id, cents] of [["erika", 833_400], ["max", 833_300], ["eva", 833_300]] as const) {
      const draft = draftFor(result, `tx:${id}`);
      expect(draft).toMatchObject({ origin: "rule", originReason: "rule:rule-stammeinlage" });
      expect(booked(draft)).toEqual([
        ["1800", cents, null, null],
        ["2900", -cents, null, null],
      ]);
    }
    expect(result.unproposed).toEqual([]);
  });

  it("A2: a payment matched to a document without an open-item account falls back to the contact's own account", async () => {
    const settlement = doc("meta-x6", { kind: "platform_settlement", direction: "unknown", platform: null, invoiceNumber: "X6TUJ3AHS4", totalAmountCents: 10_000, contactId: META, contactName: "Meta" });
    const result = await plan(
      snapshot({
        documents: [{ ...settlement, confirmedTransactions: [{ transactionId: "topup", allocatedAmountCents: 10_000 }] }],
        transactions: [tx("topup", -10_000, { counterpartyName: "Meta Platforms Ireland", resolvedContactId: META })],
      }),
    );
    expect(booked(draftFor(result, "tx:topup"))).toEqual([
      ["1800", -10_000, null, null],
      ["1461", 10_000, null, null],
    ]);
  });

  it("B8: a full cancellation of 0,50 at 19 % plus 1,50 at 7 % nets every tax account to zero", async () => {
    const lines = [
      { quantity: "1", unitPrice: "0.50", category: "S", ratePercent: 19 },
      { quantity: "1", unitPrice: "1.50", category: "S", ratePercent: 7 },
    ];
    const negated = lines.map((line) => ({ ...line, quantity: "-1" }));
    const result = await plan(
      snapshot({
        invoices: [
          { id: "inv", number: "RE-1", type: "invoice", issueDate: "2026-07-10", serviceDate: null, contactId: null, buyerName: "Kunde GmbH", buyerCountry: "DE", documentId: null, groups: invoiceVatGroups(lines, { netCents: 200, vatCents: 21 }) },
          // The stored totals of the cancellation as the invoicing module rounds them.
          { id: "storno", number: "RE-2", type: "cancellation", cancelsInvoiceId: "inv", issueDate: "2026-07-11", serviceDate: null, contactId: null, buyerName: "Kunde GmbH", buyerCountry: "DE", documentId: null, groups: invoiceVatGroups(negated, { netCents: -200, vatCents: -19 }) },
        ],
      }),
    );
    const sums = new Map<string, number>();
    for (const key of ["invoice:inv", "invoice:storno"]) for (const [account, cents] of booked(draftFor(result, key))) sums.set(account, (sums.get(account) ?? 0) + cents);
    expect(Object.fromEntries(sums)).toEqual({ "1200": 0, "4400": 0, "4300": 0, "3806": 0, "3801": 0 });
  });

  it("B8: invoiceVatGroups rounds half away from zero, so a negated invoice gives the negated groups", () => {
    const positive = invoiceVatGroups([{ quantity: "1", unitPrice: "0.50", category: "S", ratePercent: 19 }], { netCents: 50, vatCents: 10 });
    const negative = invoiceVatGroups([{ quantity: "-1", unitPrice: "0.50", category: "S", ratePercent: 19 }], { netCents: -50, vatCents: -10 });
    expect(negative).toEqual(positive.map((group) => ({ ...group, netCents: -group.netCents, vatCents: -group.vatCents })));
  });

  it("B9: only Apple and Google reports get the commissionaire template; Stripe gets no proposal and a problem code", async () => {
    const result = await plan(
      snapshot({
        accounts: [...referenceChart(), account("1372", "Forderung Stripe", { ownerType: "platform", ownerPlatform: "stripe" })],
        documents: [doc("stripe-07", { kind: "platform_settlement", direction: "unknown", platform: "stripe", totalAmountCents: null, servicePeriodTo: "2026-07-31" })],
        settlementLines: [
          { id: "s1", documentId: "stripe-07", platform: "stripe", type: "revenue", grossCents: 5000, feeCents: null, netCents: null, bookingDate: "2026-07-15" },
          { id: "s2", documentId: "stripe-07", platform: "stripe", type: "fee", grossCents: null, feeCents: -150, netCents: null, bookingDate: "2026-07-15" },
        ],
      }),
    );
    expect(result.drafts.map((draft) => draft.sourceKey)).toEqual([]);
    expect(result.unproposed).toEqual(["settlement:stripe-07:2026-07"]);
    expect(result.problems).toEqual([{ sourceKey: "settlement:stripe-07:2026-07", code: "unsupported_platform_settlement" }]);
  });

  it("B10: a document rule never books a refund; a no-document rule applies only in its money direction", async () => {
    const result = await plan(
      snapshot({
        accounts: referenceChart().filter((entry) => entry.number !== "1461"),
        rules: [
          { id: "rule-meta", contactId: META, counterpartyPattern: null, direction: "incoming", accountNumber: "6600", taxCode: "rc13b", paymentAccountNumber: null, noDocument: false },
          { id: "rule-fees", contactId: null, counterpartyPattern: "musterbank", direction: "incoming", accountNumber: "6855", taxCode: null, paymentAccountNumber: null, noDocument: true },
        ],
        transactions: [
          // A refund from Meta (money in), whose counterparty needs no document.
          tx("refund", 2_500, { counterpartyName: "Meta Platforms Ireland", resolvedContactId: META, noDocumentRule: true }),
          // Musterbank's fee (money out) and a Musterbank credit (money in).
          tx("fee", -990, { counterpartyName: "Musterbank", remittanceText: "Kontoführung" }),
          tx("credit", 500, { counterpartyName: "Musterbank", remittanceText: "Gutschrift" }),
        ],
      }),
    );
    expect(result.drafts.map((draft) => draft.sourceKey)).toEqual(["tx:fee"]);
    expect(draftFor(result, "tx:fee")).toMatchObject({ originReason: "rule:rule-fees" });
    expect(result.unproposed.sort()).toEqual(["tx:credit", "tx:refund"]);
  });

  it("B12: a domestic supplier printing German VAT and a reverse-charge note is booked as printed, with a warning", async () => {
    const result = await plan(
      snapshot({
        rules: [{ id: "rule-ionos", contactId: IONOS, counterpartyPattern: null, direction: "incoming", accountNumber: "6810", taxCode: null, paymentAccountNumber: null, noDocument: false }],
        documents: [doc("dom", { contactId: IONOS, contactName: "IONOS SE", contactCountry: "DE", contactVatId: "DE123456789", reverseCharge: true, totalAmountCents: 11_900, taxBreakdown: [{ ratePercent: 19, netCents: 10_000, taxCents: 1_900 }] })],
      }),
    );
    const draft = draftFor(result, "doc:dom");
    expect(draft.warnings).toContain("reverse_charge_conflict");
    expect(booked(draft)).toEqual([
      ["6810", 10_000, "vst19", null],
      ["1406", 1_900, "vst19", null],
      ["3300", -11_900, null, "dom"],
    ]);
  });
});
