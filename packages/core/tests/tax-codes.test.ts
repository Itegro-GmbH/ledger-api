// `expandTaxLines`: tax lines from base lines, on the real the reference company cases (decisions/0080).
import { describe, expect, it } from "vitest";

import { expandTaxLines, isBalanced, printedTaxIgnored, lineDifference, taxFromGross, taxFromNet, TAX_CODE_DEFINITIONS, TAX_CODES } from "../src";

describe("taxFromGross / taxFromNet", () => {
  it("rounds to the nearest cent in integer arithmetic", () => {
    expect(taxFromGross(150, 19)).toBe(24); // 1,50 gross: 1,26 + 0,24
    expect(taxFromGross(119, 19)).toBe(19);
    expect(taxFromGross(107, 7)).toBe(7);
    expect(taxFromGross(1, 19)).toBe(0);
    expect(taxFromGross(3, 19)).toBe(0); // 0.479 cents
    expect(taxFromGross(4, 19)).toBe(1); // 0.639 cents
    expect(taxFromNet(9657, 19)).toBe(1835); // 1834.83
    expect(taxFromNet(250, 19)).toBe(48); // 47.5 rounds half away from zero
  });

  it("keeps the sign of a credit note", () => {
    expect(taxFromGross(-150, 19)).toBe(-24);
    expect(taxFromNet(-250, 19)).toBe(-48);
  });

  it("is zero for a rate of zero", () => {
    expect(taxFromGross(1000, 0)).toBe(0);
    expect(taxFromNet(1000, 0)).toBe(0);
  });
});

describe("expandTaxLines", () => {
  it("IONOS 1,50 paid by bank: 6810 1,26 + 1406 0,24 against 1800 1,50", () => {
    const lines = expandTaxLines([
      { accountNumber: "6810", amountCents: 150, taxCode: "vst19" },
      { accountNumber: "1800", amountCents: -150 },
    ]);
    expect(lines).toEqual([
      { position: 1, accountNumber: "6810", amountCents: 126, taxCode: "vst19", taxRole: "base", generatedFromLinePosition: null, documentId: null, text: null },
      { position: 2, accountNumber: "1406", amountCents: 24, taxCode: "vst19", taxRole: "tax", generatedFromLinePosition: 1, documentId: null, text: null },
      { position: 3, accountNumber: "1800", amountCents: -150, taxCode: null, taxRole: null, generatedFromLinePosition: null, documentId: null, text: null },
    ]);
    expect(isBalanced(lines)).toBe(true);
  });

  it("a net amount adds the tax on top, so the counter side must carry the gross", () => {
    const lines = expandTaxLines([
      { accountNumber: "6810", amountCents: 126, taxCode: "vst19", amountMode: "net" },
      { accountNumber: "1800", amountCents: -150 },
    ]);
    expect(lines.map((line) => line.amountCents)).toEqual([126, 24, -150]);
    expect(lineDifference(lines)).toBe(0);
  });

  it("Google Ads 96,57 under § 13b: the base stays, 1407 and 3837 cancel each other out", () => {
    const lines = expandTaxLines([
      { accountNumber: "6600", amountCents: 9657, taxCode: "rc13b" },
      { accountNumber: "1462", amountCents: -9657 },
    ]);
    expect(lines.map((line) => [line.accountNumber, line.amountCents, line.taxRole])).toEqual([
      ["6600", 9657, "base"],
      ["1407", 1835, "tax"],
      ["3837", -1835, "tax"],
      ["1462", -9657, null],
    ]);
    expect(lines[1]!.generatedFromLinePosition).toBe(1);
    expect(lines[2]!.generatedFromLinePosition).toBe(1);
    expect(isBalanced(lines)).toBe(true);
  });

  it("ignores the amount mode for § 13b: a foreign invoice carries no German VAT", () => {
    const gross = expandTaxLines([{ accountNumber: "6600", amountCents: 1300, taxCode: "rc13b", amountMode: "gross" }]);
    const net = expandTaxLines([{ accountNumber: "6600", amountCents: 1300, taxCode: "rc13b", amountMode: "net" }]);
    expect(gross).toEqual(net);
    expect(gross[0]!.amountCents).toBe(1300);
  });

  it("generates no tax lines for a Meta invoice of 0,02 EUR (tax rounds to zero)", () => {
    const lines = expandTaxLines([{ accountNumber: "6600", amountCents: 2, taxCode: "rc13b" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.taxRole).toBe("base");
  });

  it("outgoing invoice 119,00 with 19 %: revenue 100 and USt 19 on the credit side", () => {
    const lines = expandTaxLines([
      { accountNumber: "1200", amountCents: 11900 },
      { accountNumber: "4400", amountCents: -11900, taxCode: "ust19" },
    ]);
    expect(lines.map((line) => [line.accountNumber, line.amountCents])).toEqual([
      ["1200", 11900],
      ["4400", -10000],
      ["3806", -1900],
    ]);
    expect(isBalanced(lines)).toBe(true);
  });

  it("notary 815,83 paid by the shareholder: fee with input VAT, 9,00 pass-through without", () => {
    const lines = expandTaxLines([
      { accountNumber: "6825", amountCents: 80683, taxCode: "vst19" },
      { accountNumber: "6825", amountCents: 900, taxCode: "pass_through", text: "Gerichtskosten" },
      { accountNumber: "3511", amountCents: -81583 },
    ]);
    expect(lines.map((line) => [line.accountNumber, line.amountCents, line.taxCode, line.taxRole])).toEqual([
      ["6825", 67801, "vst19", "base"],
      ["1406", 12882, "vst19", "tax"],
      ["6825", 900, "pass_through", "base"],
      ["3511", -81583, null, null],
    ]);
    expect(isBalanced(lines)).toBe(true);
  });

  it("court letter 300 + 5 is one split entry without tax", () => {
    const lines = expandTaxLines([
      { accountNumber: "6825", amountCents: 30000, taxCode: "not_taxable", text: "Gerichtskosten" },
      { accountNumber: "6300", amountCents: 500, taxCode: "not_taxable", text: "Mahngebühr" },
      { accountNumber: "1800", amountCents: -30500 },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line.taxRole === "tax")).toHaveLength(0);
    expect(isBalanced(lines)).toBe(true);
  });

  it("ignores a printed tax that would leave no base on a gross amount, and says so", () => {
    const line = { accountNumber: "6810", amountCents: 119, taxCode: "vst19" as const, taxCents: 119 };
    expect(expandTaxLines([line]).map((expanded) => [expanded.accountNumber, expanded.amountCents])).toEqual([
      ["6810", 100],
      ["1406", 19],
    ]);
    expect(printedTaxIgnored([line])).toBe(true);
    expect(printedTaxIgnored([{ ...line, taxCents: 19 }])).toBe(false);
    // On a net amount the printed tax comes on top, the base stays.
    expect(printedTaxIgnored([{ ...line, amountMode: "net" as const }])).toBe(false);
  });

  it("numbers positions from 1 with each tax line right after its base line", () => {
    const lines = expandTaxLines([
      { accountNumber: "6810", amountCents: 119, taxCode: "vst19" },
      { accountNumber: "6815", amountCents: 107, taxCode: "vst7" },
      { accountNumber: "1800", amountCents: -226 },
    ]);
    expect(lines.map((line) => [line.position, line.accountNumber, line.generatedFromLinePosition])).toEqual([
      [1, "6810", null],
      [2, "1406", 1],
      [3, "6815", null],
      [4, "1401", 3],
      [5, "1800", null],
    ]);
  });
});

describe("isBalanced", () => {
  it("needs two lines and a zero sum", () => {
    expect(isBalanced([])).toBe(false);
    expect(isBalanced([{ amountCents: 0 }])).toBe(false);
    expect(isBalanced([{ amountCents: 100 }, { amountCents: -99 }])).toBe(false);
    expect(isBalanced([{ amountCents: 100 }, { amountCents: -100 }])).toBe(true);
  });
});

describe("TAX_CODE_DEFINITIONS", () => {
  it.each(TAX_CODES)("%s has a definition with its own label and hint key", (code) => {
    const def = TAX_CODE_DEFINITIONS[code];
    expect(def.code).toBe(code);
    expect(def.labelKey).toBe(`taxCodes.${code}.label`);
    expect(def.hintKey).toBe(`taxCodes.${code}.hint`);
  });

  it("maps the USt-VA base fields", () => {
    expect(TAX_CODE_DEFINITIONS.ust19.baseKennzahl).toBe("81");
    expect(TAX_CODE_DEFINITIONS.ust7.baseKennzahl).toBe("86");
    expect(TAX_CODE_DEFINITIONS.rc13b.baseKennzahl).toBe("46");
    expect(TAX_CODE_DEFINITIONS.eu_not_taxable.baseKennzahl).toBe("21");
    expect(TAX_CODE_DEFINITIONS.not_taxable.baseKennzahl).toBeNull();
  });
});
