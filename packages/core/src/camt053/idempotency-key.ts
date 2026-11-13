// The "v2" idempotency key of an imported bank movement, moved unchanged from Digipost's
// `src/modules/intake/core/idempotency-key.ts`: a statement imported here gets exactly the keys
// Digipost gave the same movements, so after the switch a re-import adds nothing.
//
// Two parts, both required (v1 lost data): `normalizeReference` maps every "no reference"
// placeholder (`NOTPROVIDED`, ...) and an empty value to `null` before hashing, so a placeholder
// can never stand in for a reference; and the key hashes a composite of EVERY discriminator, never
// "the first non-empty one". Entries identical in every field (a batch of equal bank fees) are
// told apart by an occurrence index (`OccurrenceCounter`) within one file. `ALGORITHM_VERSION` is
// part of the hashed input, so a future v3 gets a disjoint key space.
import { createHash } from "node:crypto";

const ALGORITHM_VERSION = "v2";

/** Placeholder values ISO 20022 / German banks routinely emit in a reference field to mean
 * "no reference provided" - never a real reference, so never allowed to stand in for one (or
 * to collide with every other transaction that also has none). Matched case-insensitively
 * after trimming and whitespace-collapsing. */
const PLACEHOLDER_REFERENCES = new Set(["NOTPROVIDED", "NOT PROVIDED", "NONREF", "NOREF"]);

/**
 * Normalizes a reference-like field (`EndToEndId`, `AcctSvcrRef`, `NtryRef`, a mapped
 * reference/remittance column, ...) before it is used in an idempotency-key composite:
 * collapses internal whitespace, trims, and maps a known placeholder or an empty/
 * whitespace-only value to `null` ("no reference"). Two references that differ only in
 * whitespace or letter case (` NOTPROVIDED`, `notprovided `, `NotProvided`) always normalize
 * identically, so neither can accidentally produce a different idempotency key than the
 * other, and neither can accidentally differ from a genuinely absent (`null`) reference.
 */
export function normalizeReference(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (PLACEHOLDER_REFERENCES.has(collapsed.toUpperCase())) return null;
  return collapsed;
}

/** Every composite field, in the caller's own documented order. `null` is mapped to an
 * explicit empty slot (never dropped) so the field count/order is always stable and two
 * composites that differ only by one field shifting position can never accidentally collide.
 * `` (ASCII "unit separator") is used as the join delimiter since it cannot appear in
 * any of these fields' normal text content, unlike "|" or ";" which both do (remittance text,
 * a bank transaction code). */
function joinComposite(fields: readonly (string | number | null)[]): string {
  return fields.map((field) => (field === null ? "" : String(field))).join("");
}

/**
 * Hashes a composite of transaction discriminators into a stable v2 idempotency key. Never
 * called with "the most specific reference" alone - always the full field list the caller's
 * own header comment documents. `occurrenceIndex` (from `OccurrenceCounter`, 0 for the first
 * occurrence of an otherwise-identical composite within one file/import, 1/2/... for the
 * next) disambiguates transactions that are genuinely indistinguishable by every other field,
 * so they still get distinct keys and both survive the idempotent import.
 */
export function computeIdempotencyKeyV2(fields: readonly (string | number | null)[], occurrenceIndex: number): string {
  const composite = joinComposite(fields);
  const input = occurrenceIndex > 0 ? `${ALGORITHM_VERSION}${composite}occurrence:${occurrenceIndex}` : `${ALGORITHM_VERSION}${composite}`;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Tracks how many times an identical composite (pre-hash, pre-occurrence-index) has already
 * been seen within a single file/import, so the caller can pass the right `occurrenceIndex`
 * to `computeIdempotencyKeyV2` for each transaction in encounter order. Create exactly one
 * instance per parse/validate call and never share it across files: occurrence numbering is
 * only meaningful, and only deterministic, within the boundary of one file (overlapping partial exports of the same period may number a repeated entry
 * differently across two separate imports, an accepted trade-off versus the original silent
 * data loss).
 */
export class OccurrenceCounter {
  private readonly seen = new Map<string, number>();

  next(fields: readonly (string | number | null)[]): number {
    const key = joinComposite(fields);
    const occurrenceIndex = this.seen.get(key) ?? 0;
    this.seen.set(key, occurrenceIndex + 1);
    return occurrenceIndex;
  }
}
