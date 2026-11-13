// Which counterparty a bank movement's name refers to, copied from Digipost's contacts and
// payments modules (`normalizeName`, `nameSimilarity`, `counterpartyNameSimilarity`,
// `aliasKeyForCounterparty`, `applyAliases`, `resolveContactForCounterparty`) because the proposal
// engine resolves each movement's contact before it drafts an entry. Pure functions, no I/O.
//
// Conservative by construction: a learned payment name wins outright, otherwise only a single
// best name match at or above `NAME_MATCH_THRESHOLD` counts; an ambiguous name resolves to
// nothing, and nothing means the movement stays unexplained and visible, which is the safe
// failure.

/** Legal-form suffixes stripped from the end of a company name for matching, longest first so
 * "GmbH & Co. KG" is removed as one unit. Written the way `normalizeName` sees them: lowercased,
 * with "&" and periods already turned into spaces. */
const LEGAL_FORM_SUFFIXES = [
  "gmbh co kg",
  "gmbh co",
  "gmbh",
  "mbh",
  "ag co kg",
  "ag",
  "kg",
  "ohg",
  "ug haftungsbeschraenkt",
  "ug",
  "e k",
  "ek",
  "e v",
  "ev",
  "co kg",
].sort((a, b) => b.length - a.length);

/**
 * Name normalization for matching: lowercase, strip punctuation, collapse whitespace, then strip
 * trailing legal-form suffixes (repeatedly). German umlauts and ß are kept intact: a formatting
 * normalization, not a transliteration.
 *
 * `normalizeName("Musterwerk GmbH") === normalizeName("musterwerk") === "musterwerk"`.
 */
export function normalizeName(raw: string): string {
  let s = raw
    .toLowerCase()
    // Keep letters (umlauts and ß included), digits and spaces; "&" separates like a space.
    .replace(/[.,;:!?'"()/\\_&-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let strippedSomething = true;
  while (strippedSomething) {
    strippedSomething = false;
    for (const suffix of LEGAL_FORM_SUFFIXES) {
      if (s === suffix) {
        s = "";
        strippedSomething = true;
        break;
      }
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        strippedSomething = true;
        break;
      }
    }
  }

  return s;
}

/**
 * Token-based Jaccard similarity between two already normalized names, in `[0, 1]`: `1` for
 * identical strings (both empty included), `0` when exactly one side is empty. Simple and
 * deterministic on purpose.
 */
export function nameSimilarity(normalizedA: string, normalizedB: string): number {
  if (normalizedA === normalizedB) return 1;
  const tokensA = new Set(normalizedA.split(" ").filter(Boolean));
  const tokensB = new Set(normalizedB.split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersectionSize++;
  }
  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * How similar two counterparty names are. Card payments carry the merchant name, then a comma and
 * a location or URL ("NETZHOST,MONTABAUR"); the part before the first comma is compared too and
 * the better score wins, so this can only raise a similarity, never lower it.
 */
export function counterpartyNameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const full = nameSimilarity(normalizeName(a), normalizeName(b));
  const merchantA = a.split(",")[0]!.trim();
  const merchantB = b.split(",")[0]!.trim();
  if (merchantA === a.trim() && merchantB === b.trim()) return full;
  return Math.max(full, nameSimilarity(normalizeName(merchantA), normalizeName(merchantB)), nameSimilarity(normalizeName(merchantA), normalizeName(b)));
}

/** The bar a name match must reach (Digipost's payment matching uses the same one). */
export const NAME_MATCH_THRESHOLD = 0.4;

/** Keyed by `aliasKeyForCounterparty` (or, for older aliases, `normalizeName`) of a counterparty
 * name, valued by the contact id a human confirmed it refers to. */
export type ContactAliasMap = ReadonlyMap<string, string>;

/** The key an alias is stored and looked up under. Card debits carry the merchant, then a comma
 * and a location or URL, and often a per-payment reference after an asterisk
 * ("WERBENETZ *AB12CD34EF,werbenetz.example"); keyed by the full name, an alias would never match
 * the next month's debit. The key is the part before the first comma, with an asterisk reference
 * that mixes letters and digits removed ("werbenetz"). A plain name keys like `normalizeName`. */
export function aliasKeyForCounterparty(counterpartyName: string): string {
  const merchant = counterpartyName.split(",")[0] ?? counterpartyName;
  const withoutReference = merchant.replace(/\*\s*([A-Za-z0-9]+)/g, (_match, code: string) => (/[0-9]/.test(code) && /[A-Za-z]/.test(code) ? " " : ` ${code}`));
  return normalizeName(withoutReference);
}

/** A learned alias for the counterparty name: the stable merchant key first, then the full name
 * older aliases were keyed by. `null` when the name is absent or nothing was learned. */
export function applyAliases(counterpartyName: string | null | undefined, aliases: ContactAliasMap): string | null {
  if (!counterpartyName) return null;
  return aliases.get(aliasKeyForCounterparty(counterpartyName)) ?? aliases.get(normalizeName(counterpartyName)) ?? null;
}

export type ContactForResolution = { id: string; name: string };

/**
 * The contact `counterpartyName` refers to, or `null`:
 *
 * 1. A learned payment name wins outright (`applyAliases`).
 * 2. Otherwise the single best contact whose name is at least `NAME_MATCH_THRESHOLD` similar. A
 *    tie at the best score is ambiguous and resolves to `null`.
 */
export function resolveContactForCounterparty(counterpartyName: string | null | undefined, contacts: readonly ContactForResolution[], aliases: ContactAliasMap): string | null {
  const aliased = applyAliases(counterpartyName, aliases);
  if (aliased) return aliased;
  if (!counterpartyName) return null;

  const scored = contacts
    .map((contact) => ({ id: contact.id, score: counterpartyNameSimilarity(counterpartyName, contact.name) }))
    .filter((candidate) => candidate.score >= NAME_MATCH_THRESHOLD);
  if (scored.length === 0) return null;

  const best = Math.max(...scored.map((candidate) => candidate.score));
  const winners = scored.filter((candidate) => candidate.score === best);
  return winners.length === 1 ? winners[0]!.id : null;
}
