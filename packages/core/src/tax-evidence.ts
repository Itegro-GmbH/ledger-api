// Whether a document's own figures back a reverse-charge booking (decisions/0080, notes after
// production use, "No reverse charge guessed"). Pure and free of Node imports, because the
// proposal engine, the advisor's answer validation and (through `core/proposals.ts`) the
// client-side editor all import it.
import type { TaxCode } from "./types";

/** Whether a document prints any tax figure at all: a breakdown entry with an amount, or a tax
 * total. Without one, nothing on the document says whether German VAT is charged or reverse
 * charge applies, so `rc13b` is a guess (decisions/0080's notes, "No reverse charge guessed"). */
export function hasPrintedTaxFigures(fields: { taxBreakdown: readonly { netCents: number | null; taxCents: number | null }[] | null; taxTotalCents: number | null }): boolean {
  if ((fields.taxBreakdown ?? []).some((entry) => entry.netCents !== null || entry.taxCents !== null)) return true;
  return fields.taxTotalCents !== null;
}

/** `rc13b` chosen with neither a printed tax figure nor a reverse-charge note to back it. */
export function isUnverifiedReverseCharge(codes: readonly (TaxCode | null)[], fields: Parameters<typeof hasPrintedTaxFigures>[0] & { reverseCharge: boolean | null }): boolean {
  return codes.includes("rc13b") && fields.reverseCharge !== true && !hasPrintedTaxFigures(fields);
}
