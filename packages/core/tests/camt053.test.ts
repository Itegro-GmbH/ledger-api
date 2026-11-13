// The camt.053 parser moved from Digipost: both party shapes (.001.02 and .001.08), balances,
// signed amounts, remittance text, the v2 idempotency key (placeholders never collide, identical
// entries are told apart), and the XXE gate. Invented data only.
import { describe, expect, it } from "vitest";

import { Camt053Error, camt053StatementReconciles, parseCamt053, UnsafeXmlError } from "../src";
import { camt053, entry, IBAN } from "./fixtures/camt053";

describe("parseCamt053", () => {
  it("reads both party shapes, balances and signed amounts", () => {
    for (const version of ["02", "08"] as const) {
      const result = parseCamt053(
        camt053(version, [
          entry({ amount: "11.90", indicator: "DBIT", date: "2026-07-20", name: "Muster Hosting GmbH", iban: "DE89370400440532013000", e2e: "MH-2026-0007", text: "Rechnung MH-2026-0007", v8: version === "08" }),
        ]),
      );
      expect(result.version).toBe(version);
      const [statement] = result.statements;
      expect(statement).toMatchObject({ statementId: "STMT-2026-07", accountIban: IBAN, currency: "EUR", openingBalance: { type: "OPBD", amountCents: 10_000 }, closingBalance: { type: "CLBD", amountCents: 8810 } });
      expect(statement!.transactions).toEqual([
        expect.objectContaining({
          bookingDate: "2026-07-20",
          amountCents: -1190,
          creditDebit: "debit",
          counterpartyName: "Muster Hosting GmbH",
          counterpartyIban: "DE89370400440532013000",
          remittanceInformation: "Rechnung MH-2026-0007",
          endToEndId: "MH-2026-0007",
          bankTransactionCode: "PMNT/RCDT/ESCT",
        }),
      ]);
      expect(statement!.transactions[0]!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
      expect(camt053StatementReconciles(statement!)).toBe(true);
    }
  });

  it("keys identical entries apart and placeholder references never as one; the same file gives the same keys", () => {
    const fee = entry({ amount: "5.00", indicator: "DBIT", date: "2026-07-31", name: "Hausbank", iban: IBAN });
    const xml = camt053("08", [fee, fee, entry({ amount: "5.00", indicator: "DBIT", date: "2026-07-31", name: "Hausbank", iban: IBAN, text: "Kontoführung" })], { opening: "100.00", closing: "85.00" });
    const keys = parseCamt053(xml).statements[0]!.transactions.map((tx) => tx.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(parseCamt053(xml).statements[0]!.transactions.map((tx) => tx.idempotencyKey)).toEqual(keys);
  });

  it("refuses a DOCTYPE and anything that is not camt.053", () => {
    expect(() => parseCamt053(`<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"/>`)).toThrow(UnsafeXmlError);
    expect(() => parseCamt053(`<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"/>`)).toThrow(Camt053Error);
  });
});
