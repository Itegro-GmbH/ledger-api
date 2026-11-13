// Tax codes are code constants, not a table (decisions/0080, spec section 2): each one says
// which tax lines a base line generates and which USt-VA fields ("Kennzahlen") it feeds.
// `expandTaxLines` is the one place tax lines are computed; the editor, the proposal engine
// and the use case all go through it, so a booked entry's tax lines are always reproducible
// from its base lines.
import type { AmountMode, TaxCode, TaxRole, VatKennzahl } from "./types";

/** `input`: Vorsteuer on a purchase. `output`: Umsatzsteuer on a sale. `reverse_charge`: § 13b,
 * the buyer owes the tax and deducts it again (two tax lines that cancel each other out). */
export type TaxCodeKind = "input" | "output" | "reverse_charge" | "none";

export type TaxCodeDefinition = {
  code: TaxCode;
  ratePercent: number;
  kind: TaxCodeKind;
  /** The account the generated tax line goes to (input or output tax). */
  taxAccountNumber: string | null;
  /** Only for `reverse_charge`: the input tax (Vorsteuer 13b) and output tax (USt 13b) accounts. */
  reverseChargeAccounts: { input: string; output: string } | null;
  /** The USt-VA field the base amount (Bemessungsgrundlage) is reported in. */
  baseKennzahl: VatKennzahl | null;
  /** `+1` when the base is a debit (a purchase), `-1` when it is a credit (a sale). The USt-VA
   * shows both as positive amounts. */
  baseSign: 1 | -1;
  /** Under `Ledger.taxCodes.<code>` in `de.json`. */
  labelKey: string;
  hintKey: string;
};

function definition(code: TaxCode, rest: Omit<TaxCodeDefinition, "code" | "labelKey" | "hintKey">): TaxCodeDefinition {
  return { code, ...rest, labelKey: `taxCodes.${code}.label`, hintKey: `taxCodes.${code}.hint` };
}

export const TAX_CODE_DEFINITIONS: Record<TaxCode, TaxCodeDefinition> = {
  vst19: definition("vst19", { ratePercent: 19, kind: "input", taxAccountNumber: "1406", reverseChargeAccounts: null, baseKennzahl: null, baseSign: 1 }),
  vst7: definition("vst7", { ratePercent: 7, kind: "input", taxAccountNumber: "1401", reverseChargeAccounts: null, baseKennzahl: null, baseSign: 1 }),
  rc13b: definition("rc13b", {
    ratePercent: 19,
    kind: "reverse_charge",
    taxAccountNumber: null,
    reverseChargeAccounts: { input: "1407", output: "3837" },
    baseKennzahl: "46",
    baseSign: 1,
  }),
  ust19: definition("ust19", { ratePercent: 19, kind: "output", taxAccountNumber: "3806", reverseChargeAccounts: null, baseKennzahl: "81", baseSign: -1 }),
  ust7: definition("ust7", { ratePercent: 7, kind: "output", taxAccountNumber: "3801", reverseChargeAccounts: null, baseKennzahl: "86", baseSign: -1 }),
  eu_not_taxable: definition("eu_not_taxable", { ratePercent: 0, kind: "none", taxAccountNumber: null, reverseChargeAccounts: null, baseKennzahl: "21", baseSign: -1 }),
  not_taxable: definition("not_taxable", { ratePercent: 0, kind: "none", taxAccountNumber: null, reverseChargeAccounts: null, baseKennzahl: null, baseSign: 1 }),
  tax_free: definition("tax_free", { ratePercent: 0, kind: "none", taxAccountNumber: null, reverseChargeAccounts: null, baseKennzahl: null, baseSign: 1 }),
  pass_through: definition("pass_through", { ratePercent: 0, kind: "none", taxAccountNumber: null, reverseChargeAccounts: null, baseKennzahl: null, baseSign: 1 }),
};

/** Which USt-VA tax field a tax account feeds. Tax amounts are read from these accounts, not
 * from tax codes, so a tax line typed by hand in the expert editor is reported as well. */
export const TAX_ACCOUNT_KENNZAHLEN: Record<string, { kennzahl: VatKennzahl; side: "input" | "output" }> = {
  "3806": { kennzahl: "81", side: "output" },
  "3801": { kennzahl: "86", side: "output" },
  "3837": { kennzahl: "47", side: "output" },
  "1406": { kennzahl: "66", side: "input" },
  "1401": { kennzahl: "66", side: "input" },
  "1407": { kennzahl: "67", side: "input" },
};

/** Every account a generated tax line may land on; the chart must contain each of them. */
export const TAX_ACCOUNT_NUMBERS: readonly string[] = Object.keys(TAX_ACCOUNT_KENNZAHLEN);

export function taxCodeDefinition(code: TaxCode): TaxCodeDefinition {
  return TAX_CODE_DEFINITIONS[code];
}

/** `numerator / denominator` rounded to the nearest integer, halves away from zero, in pure
 * integer arithmetic (no floating point drift on amounts like 1,50 EUR). Both arguments are
 * non-negative integers. */
function divideRounded(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/** The tax contained in a gross amount: `round(gross - gross / (1 + rate))`, sign kept. */
export function taxFromGross(grossCents: number, ratePercent: number): number {
  if (ratePercent === 0 || grossCents === 0) return 0;
  const sign = grossCents < 0 ? -1 : 1;
  return sign * divideRounded(Math.abs(grossCents) * ratePercent, 100 + ratePercent);
}

/** The tax on a net amount: `round(net * rate)`, sign kept. */
export function taxFromNet(netCents: number, ratePercent: number): number {
  if (ratePercent === 0 || netCents === 0) return 0;
  const sign = netCents < 0 ? -1 : 1;
  return sign * divideRounded(Math.abs(netCents) * ratePercent, 100);
}

/** A line as the editor or the proposal engine describes it: an account, a signed amount,
 * optionally a tax code, and whether that amount is gross or net. */
export type BaseLineInput = {
  accountNumber: string;
  amountCents: number;
  taxCode?: TaxCode | null;
  /** Default `gross`: what an invoice prints as its total. Ignored for `rc13b` (a foreign
   * supplier's invoice carries no German VAT, so its amount is the net). */
  amountMode?: AmountMode;
  /** The tax printed on the document, used instead of the computed one for an input or output
   * tax code (the proposal engine books an invoice's exact printed figures). Ignored when its
   * sign differs from the amount's or it exceeds the amount. */
  taxCents?: number | null;
  /** The open item this line belongs to (the document it books or pays), for matching. */
  documentId?: string | null;
  text?: string | null;
};

export type ExpandedLine = {
  position: number;
  accountNumber: string;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
  generatedFromLinePosition: number | null;
  /** Copied from the base line onto its generated tax lines. */
  documentId: string | null;
  text: string | null;
};

/** A printed tax amount that can stand in for the computed one: same sign, not larger, and on a
 * gross amount smaller than it (a tax as large as the gross would leave a base of zero). */
function usablePrintedTax(taxCents: number | null | undefined, amountCents: number, mode: AmountMode): taxCents is number {
  if (taxCents === null || taxCents === undefined || !Number.isInteger(taxCents)) return false;
  if (taxCents === 0) return true;
  if (Math.sign(taxCents) !== Math.sign(amountCents)) return false;
  return mode === "gross" ? Math.abs(taxCents) < Math.abs(amountCents) : Math.abs(taxCents) <= Math.abs(amountCents);
}

/** Whether `expandTaxLines` drops a printed tax amount of these lines for the computed one (the
 * editor tells the user, since the document's figure is not what gets booked). */
export function printedTaxIgnored(lines: readonly BaseLineInput[]): boolean {
  return lines.some((line) => {
    if (!line.taxCode || line.taxCents === null || line.taxCents === undefined) return false;
    const kind = TAX_CODE_DEFINITIONS[line.taxCode].kind;
    return (kind === "input" || kind === "output") && !usablePrintedTax(line.taxCents, line.amountCents, line.amountMode ?? "gross");
  });
}

/**
 * Base lines to base plus generated tax lines, positions numbered from 1, each tax line right
 * after its base line.
 *
 * - Input/output tax (`vst19`, `vst7`, `ust19`, `ust7`): a gross amount is split into the base
 *   (net) and the tax line, both with the base's sign; a net amount keeps its value and the tax
 *   is added on top, so the entry's other side must carry the gross.
 * - Reverse charge (`rc13b`): the base stays as typed; 19 % of it is added on 1407 (Vorsteuer
 *   13b) and the same amount, opposite sign, on 3837 (USt 13b). The pair sums to zero, so the
 *   entry balances without touching the other side.
 * - Codes without tax (`not_taxable`, `tax_free`, `pass_through`, `eu_not_taxable`) only mark
 *   the base line.
 */
export function expandTaxLines(lines: readonly BaseLineInput[]): ExpandedLine[] {
  const out: ExpandedLine[] = [];
  for (const line of lines) {
    const code = line.taxCode ?? null;
    const text = line.text ?? null;
    const documentId = line.documentId ?? null;
    if (!code) {
      out.push({ position: out.length + 1, accountNumber: line.accountNumber, amountCents: line.amountCents, taxCode: null, taxRole: null, generatedFromLinePosition: null, documentId, text });
      continue;
    }
    const def = TAX_CODE_DEFINITIONS[code];
    const mode = line.amountMode ?? "gross";

    if (def.kind === "reverse_charge" && def.reverseChargeAccounts) {
      const base = { position: out.length + 1, accountNumber: line.accountNumber, amountCents: line.amountCents, taxCode: code, taxRole: "base" as const, generatedFromLinePosition: null, documentId, text };
      out.push(base);
      const tax = taxFromNet(line.amountCents, def.ratePercent);
      if (tax !== 0) {
        out.push({ position: out.length + 1, accountNumber: def.reverseChargeAccounts.input, amountCents: tax, taxCode: code, taxRole: "tax", generatedFromLinePosition: base.position, documentId, text: null });
        out.push({ position: out.length + 1, accountNumber: def.reverseChargeAccounts.output, amountCents: -tax, taxCode: code, taxRole: "tax", generatedFromLinePosition: base.position, documentId, text: null });
      }
      continue;
    }

    if ((def.kind === "input" || def.kind === "output") && def.taxAccountNumber) {
      const computed = mode === "gross" ? taxFromGross(line.amountCents, def.ratePercent) : taxFromNet(line.amountCents, def.ratePercent);
      const tax = usablePrintedTax(line.taxCents, line.amountCents, mode) ? line.taxCents : computed;
      const baseCents = mode === "gross" ? line.amountCents - tax : line.amountCents;
      const base = { position: out.length + 1, accountNumber: line.accountNumber, amountCents: baseCents, taxCode: code, taxRole: "base" as const, generatedFromLinePosition: null, documentId, text };
      out.push(base);
      if (tax !== 0) {
        out.push({ position: out.length + 1, accountNumber: def.taxAccountNumber, amountCents: tax, taxCode: code, taxRole: "tax", generatedFromLinePosition: base.position, documentId, text: null });
      }
      continue;
    }

    out.push({ position: out.length + 1, accountNumber: line.accountNumber, amountCents: line.amountCents, taxCode: code, taxRole: "base", generatedFromLinePosition: null, documentId, text });
  }
  return out;
}

/** Debit minus credit of a set of lines; zero means balanced. */
export function lineDifference(lines: readonly { amountCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amountCents, 0);
}

/** A booked entry needs at least two lines, no zero line, and a zero sum. */
export function isBalanced(lines: readonly { amountCents: number }[]): boolean {
  return lines.length >= 2 && lineDifference(lines) === 0;
}

/** The debit side of an entry: what it moves, shown as its amount in lists. */
export function debitTotal(lines: readonly { amountCents: number }[]): number {
  return lines.reduce((sum, line) => (line.amountCents > 0 ? sum + line.amountCents : sum), 0);
}
