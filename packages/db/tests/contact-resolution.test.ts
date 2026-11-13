// The name matching copied from Digipost's contacts and payments modules
// (`src/sources/contact-resolution.ts`): which contact a bank movement's counterparty name refers
// to, built only from learned payment names and a conservative name comparison. A card debit's
// descriptor ("WERBENETZ *QX7MNP41KD,werbenetz.example") shares nothing with the supplier's
// registered name, so without a learned payment name it MUST stay unresolved (the safe failure).
import { describe, expect, it } from "vitest";

import { aliasKeyForCounterparty, applyAliases, counterpartyNameSimilarity, nameSimilarity, normalizeName, resolveContactForCounterparty, type ContactAliasMap } from "../src";

const WERBENETZ = { id: "contact-werbenetz", name: "Werbenetz Europe Limited" };
const NETZHOST = { id: "contact-netzhost", name: "Netzhost SE" };
const NO_ALIASES: ContactAliasMap = new Map();

describe("normalizeName", () => {
  it.each([
    ["Musterwerk GmbH", "musterwerk"],
    ["musterwerk", "musterwerk"],
    ["MUSTERWERK", "musterwerk"],
    ["Musterwerk GmbH & Co. KG", "musterwerk"],
    ["Müller & Söhne GmbH", "müller söhne"],
    ["Bäckerei Schäfer e. K.", "bäckerei schäfer"],
    ["Schmidt AG", "schmidt"],
    ["Schmidt UG", "schmidt"],
    ["  Extra   Spaces   GmbH  ", "extra spaces"],
    ["Kein Rechtsform Suffix", "kein rechtsform suffix"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeName(raw)).toBe(expected);
  });

  it("keeps German umlauts and ß intact", () => {
    expect(normalizeName("Straße")).toBe("straße");
    expect(normalizeName("Grün GmbH")).toBe("grün");
  });
});

describe("nameSimilarity", () => {
  it("is 1 for identical normalized names", () => {
    expect(nameSimilarity("musterwerk", "musterwerk")).toBe(1);
  });

  it("is 0 when one side is empty and the other is not", () => {
    expect(nameSimilarity("", "musterwerk")).toBe(0);
    expect(nameSimilarity("musterwerk", "")).toBe(0);
  });

  it("scores a near-miss below a full match", () => {
    const similarity = nameSimilarity("musterwerk", "musterwerk handel");
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });

  it("is 0 for completely unrelated names", () => {
    expect(nameSimilarity("musterwerk", "ganz anderes unternehmen")).toBe(0);
  });
});

describe("counterpartyNameSimilarity", () => {
  it("compares a card payment's merchant part before the comma too, never lowering the score", () => {
    expect(counterpartyNameSimilarity("NETZHOST SE,MONTABAUR", "Netzhost SE")).toBe(1);
    expect(counterpartyNameSimilarity("Netzhost SE", "Netzhost SE")).toBe(1);
    expect(counterpartyNameSimilarity(null, "Netzhost SE")).toBe(0);
  });
});

describe("aliasKeyForCounterparty / applyAliases", () => {
  it("keys a card debit by its merchant, without the per-payment reference", () => {
    expect(aliasKeyForCounterparty("WERBENETZ *QX7MNP41KD,werbenetz.example")).toBe("werbenetz");
    expect(aliasKeyForCounterparty("Musterwerk GmbH")).toBe("musterwerk");
  });

  it("finds an alias by the merchant key, or by the full normalized name it was stored under before", () => {
    expect(applyAliases("WERBENETZ *ZK3L8RT6YB,werbenetz.example", new Map([["werbenetz", "c1"]]))).toBe("c1");
    expect(applyAliases("MUSTERWERK GMBH", new Map([["musterwerk", "c2"]]))).toBe("c2");
    expect(applyAliases(null, new Map([["musterwerk", "c2"]]))).toBeNull();
    expect(applyAliases("Musterwerk GmbH", new Map())).toBeNull();
  });
});

describe("resolveContactForCounterparty", () => {
  it("resolves a card debit through a learned payment name, ignoring the per-payment reference", () => {
    const aliases: ContactAliasMap = new Map([[aliasKeyForCounterparty("WERBENETZ"), WERBENETZ.id]]);

    expect(resolveContactForCounterparty("WERBENETZ *QX7MNP41KD,werbenetz.example", [WERBENETZ, NETZHOST], aliases)).toBe(WERBENETZ.id);
    expect(resolveContactForCounterparty("WERBENETZ *ZK3L8RT6YB,werbenetz.example", [WERBENETZ, NETZHOST], aliases)).toBe(WERBENETZ.id);
  });

  it("resolves by the contact's own name with the card-merchant tolerance", () => {
    expect(resolveContactForCounterparty("NETZHOST SE,MONTABAUR", [WERBENETZ, NETZHOST], NO_ALIASES)).toBe(NETZHOST.id);
  });

  it("resolves nothing for a merchant name that matches no contact", () => {
    expect(resolveContactForCounterparty("WERBENETZ *QX7MNP41KD,werbenetz.example", [WERBENETZ, NETZHOST], NO_ALIASES)).toBeNull();
  });

  it("resolves nothing for a missing counterparty name", () => {
    expect(resolveContactForCounterparty(null, [WERBENETZ, NETZHOST], NO_ALIASES)).toBeNull();
    expect(resolveContactForCounterparty("", [WERBENETZ, NETZHOST], NO_ALIASES)).toBeNull();
  });

  it("resolves nothing when two contacts are equally similar", () => {
    const first = { id: "c1", name: "Bauwerk Bau" };
    const second = { id: "c2", name: "Bauwerk Bau" };

    expect(resolveContactForCounterparty("Bauwerk Bau", [first, second], NO_ALIASES)).toBeNull();
  });

  it("prefers a learned payment name over any name similarity", () => {
    const aliases: ContactAliasMap = new Map([[aliasKeyForCounterparty("NETZHOST SE"), WERBENETZ.id]]);

    expect(resolveContactForCounterparty("NETZHOST SE,MONTABAUR", [WERBENETZ, NETZHOST], aliases)).toBe(WERBENETZ.id);
  });
});
