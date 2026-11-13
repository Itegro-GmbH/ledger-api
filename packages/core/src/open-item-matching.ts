// Matching open items (decisions/0080 phase 4, the automatic part): which booked lines of an
// open-item account settle each other. Pure; the use case reads the unmatched booked lines and
// writes the matches.
//
// - `findAutoMatches`: the only matches made without a human: every unmatched line of an
//   account that carries the same document (the invoice's line and its payment's lines, both
//   written by the proposal engine) when together they sum to exactly zero.
// - `suggestMatchGroups`: candidates for the UI, never applied by themselves: the same-document
//   groups, and combinations of opposite lines that add up to one line (Google Ads: charges of
//   10,00 + 50,00 + 36,57 against one invoice of 96,57; a platform payout against its report).
import type { MatchSuggestion } from "./types";

export type OpenItemLine = {
  lineId: string;
  accountId: string;
  amountCents: number;
  documentId: string | null;
  bookingDate: string;
};

export type AutoMatch = { accountId: string; documentId: string; lineIds: string[] };

/** Most lines one subset may combine, and how many candidates a subset is searched in. */
export const MAX_SUBSET_SIZE = 4;
export const MAX_SUBSET_CANDIDATES = 24;
export const MAX_SUGGESTIONS = 50;
/** The largest lines a combination is searched for (each costs a sort of the candidates). */
export const MAX_ANCHORS = 200;
/** Lines tried across every subset search of one call: a bound on the whole call, whatever the
 * account holds (3000 open lines stay well under a second). */
export const MAX_SEARCH_STEPS = 50_000;

function groupKey(lineIds: readonly string[]): string {
  return [...lineIds].sort().join(",");
}

/** Same account, same document, both signs, sum zero. */
export function findAutoMatches(lines: readonly OpenItemLine[]): AutoMatch[] {
  const groups = new Map<string, OpenItemLine[]>();
  for (const line of lines) {
    if (!line.documentId) continue;
    const key = `${line.accountId}|${line.documentId}`;
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }
  const matches: AutoMatch[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (!group.some((line) => line.amountCents > 0) || !group.some((line) => line.amountCents < 0)) continue;
    if (group.reduce((sum, line) => sum + line.amountCents, 0) !== 0) continue;
    matches.push({ accountId: group[0]!.accountId, documentId: group[0]!.documentId!, lineIds: group.map((line) => line.lineId).sort() });
  }
  return matches;
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** A subset of `candidates` (at most `maxSize` lines) summing to `target`, or `null`. Depth
 * first in candidate order (closest dates first), so the first hit is the most plausible. Every
 * line tried uses one step of `budget`; an exhausted budget ends the search without a hit. */
function findSubset(candidates: readonly OpenItemLine[], target: number, maxSize: number, budget: { steps: number }): OpenItemLine[] | null {
  const chosen: OpenItemLine[] = [];
  const search = (start: number, remaining: number): boolean => {
    if (remaining === 0 && chosen.length > 0) return true;
    if (chosen.length === maxSize) return false;
    for (let index = start; index < candidates.length; index++) {
      if (budget.steps <= 0) return false;
      const candidate = candidates[index]!;
      // Every candidate has the target's sign: overshooting can never come back.
      if (Math.abs(candidate.amountCents) > Math.abs(remaining)) continue;
      budget.steps--;
      chosen.push(candidate);
      if (search(index + 1, remaining - candidate.amountCents)) return true;
      chosen.pop();
    }
    return false;
  };
  return search(0, target) ? [...chosen] : null;
}

/**
 * Candidate groups over the unmatched lines of ONE account: first every same-document group
 * summing to zero, then, for each line not yet in a group (largest first, at most `MAX_ANCHORS`),
 * the closest-dated single opposite line of exactly its amount, else the closest-dated
 * combination of up to `MAX_SUBSET_SIZE` opposite lines that settles it. A line is used in at
 * most one suggestion, so the suggestions can be applied together. Bounded: at most
 * `MAX_SUGGESTIONS` suggestions and `MAX_SEARCH_STEPS` lines tried in all.
 */
export function suggestMatchGroups(lines: readonly OpenItemLine[], options: { maxSize?: number; maxCandidates?: number; maxSteps?: number } = {}): MatchSuggestion[] {
  const maxSize = options.maxSize ?? MAX_SUBSET_SIZE;
  const maxCandidates = options.maxCandidates ?? MAX_SUBSET_CANDIDATES;
  const budget = { steps: options.maxSteps ?? MAX_SEARCH_STEPS };
  const suggestions: MatchSuggestion[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();
  const byId = new Map(lines.map((line) => [line.lineId, line]));

  const push = (reason: MatchSuggestion["reason"], group: readonly OpenItemLine[]) => {
    const lineIds = group.map((line) => line.lineId).sort();
    const key = groupKey(lineIds);
    if (seen.has(key)) return;
    seen.add(key);
    for (const id of lineIds) used.add(id);
    suggestions.push({ accountId: group[0]!.accountId, reason, lineIds, amountCents: group.reduce((sum, line) => (line.amountCents > 0 ? sum + line.amountCents : sum), 0) });
  };

  for (const match of findAutoMatches(lines)) {
    if (suggestions.length >= MAX_SUGGESTIONS) return suggestions;
    push(
      "same_document",
      match.lineIds.map((id) => byId.get(id)!),
    );
  }

  // Lines by account and amount, for the exact single counterpart.
  const byAmount = new Map<string, OpenItemLine[]>();
  for (const line of lines) {
    const key = `${line.accountId}|${line.amountCents}`;
    const list = byAmount.get(key) ?? [];
    list.push(line);
    byAmount.set(key, list);
  }
  const closest = (anchor: OpenItemLine) => (a: OpenItemLine, b: OpenItemLine) => dayDistance(a.bookingDate, anchor.bookingDate) - dayDistance(b.bookingDate, anchor.bookingDate) || (a.lineId < b.lineId ? -1 : 1);

  const anchors = lines
    .filter((line) => !used.has(line.lineId))
    .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents) || (a.lineId < b.lineId ? -1 : 1))
    .slice(0, MAX_ANCHORS);
  for (const anchor of anchors) {
    if (suggestions.length >= MAX_SUGGESTIONS || budget.steps <= 0) break;
    if (used.has(anchor.lineId)) continue;
    const exact = (byAmount.get(`${anchor.accountId}|${-anchor.amountCents}`) ?? []).filter((line) => !used.has(line.lineId) && line.lineId !== anchor.lineId).sort(closest(anchor));
    if (exact.length > 0 && maxSize >= 1) {
      push("subset_sum", [anchor, exact[0]!]);
      continue;
    }
    const candidates = lines
      .filter((line) => !used.has(line.lineId) && line.lineId !== anchor.lineId && line.accountId === anchor.accountId && Math.sign(line.amountCents) === -Math.sign(anchor.amountCents))
      .sort(closest(anchor))
      .slice(0, maxCandidates);
    const subset = findSubset(candidates, -anchor.amountCents, maxSize, budget);
    if (subset) push("subset_sum", [anchor, ...subset]);
  }
  return suggestions;
}
