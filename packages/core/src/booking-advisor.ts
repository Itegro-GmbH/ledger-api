// The AI booking advisor's pure half (decisions/0080 phase 3): validating an answer, its cache
// key, the form an answer is cached in, and the deterministic fake. "AI proposes, code verifies"
// like the payment arbiter (decisions/0023): an account outside the question's chart, a tax code
// that does not fit the direction, or a split that does not add up is rejected, never repaired,
// and the engine falls back to its template default with the `ai_unavailable` warning.
import { createHash } from "node:crypto";

import { z } from "zod";

import type { BookingAdvice, BookingAdviceQuestion, BookingAdviceRaw, LedgerBookingAdvisor } from "./ports";
import { isUnverifiedReverseCharge } from "./tax-evidence";
import { TAX_CODES, type TaxCode } from "./types";

/** The tax codes an answer may name, per direction. */
export const ADVICE_TAX_CODES: Record<BookingAdviceQuestion["direction"], readonly TaxCode[]> = {
  incoming: ["vst19", "vst7", "rc13b", "not_taxable", "tax_free", "pass_through"],
  outgoing: ["ust19", "ust7", "eu_not_taxable", "not_taxable", "tax_free"],
};

/** A split longer than this is not a booking suggestion any more. */
export const MAX_ADVICE_SPLIT_LINES = 5;
const MAX_REASON_LENGTH = 300;
const MAX_CACHED_REASON_LENGTH = 1000;

const rawLineSchema = z.object({ accountNumber: z.string(), taxCode: z.string().nullable(), amountCents: z.number() });
const rawAdviceSchema = z.object({
  accountNumber: z.string().nullable(),
  taxCode: z.string().nullable(),
  reason: z.string(),
  lines: z.array(rawLineSchema).nullable().optional(),
});

function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const match = /^[^.!?]{1,300}[.!?]/.exec(trimmed);
  return (match ? match[0] : trimmed.slice(0, MAX_REASON_LENGTH)).trim();
}

function taxCodeFor(value: string | null, direction: BookingAdviceQuestion["direction"]): TaxCode | null | undefined {
  if (value === null) return null;
  if (!(TAX_CODES as readonly string[]).includes(value)) return undefined;
  const code = value as TaxCode;
  return ADVICE_TAX_CODES[direction].includes(code) ? code : undefined;
}

/**
 * The answer as the engine may use it, or `null` when it must be discarded: an unparseable
 * shape, an empty reason, an account not offered in the question, a tax code outside
 * `ADVICE_TAX_CODES` for the direction, or a split whose parts are not all of the document's sign
 * or do not add up to its gross amount without the pass-through part. An `rc13b` the question's
 * figures do not back is kept with `taxUnverified` (`isUnverifiedReverseCharge`).
 */
export function validateBookingAdvice(raw: unknown, question: BookingAdviceQuestion): BookingAdvice | null {
  const parsed = rawAdviceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const allowed = new Set(question.accounts.map((account) => account.number));
  const { accountNumber, reason } = parsed.data;
  if (!accountNumber || !allowed.has(accountNumber)) return null;
  const taxCode = taxCodeFor(parsed.data.taxCode, question.direction);
  if (taxCode === undefined) return null;
  const sentence = firstSentence(reason);
  if (sentence.length === 0) return null;

  // An `rc13b` without a printed tax figure or a reverse-charge note is kept but marked, so the
  // engine flags the proposal `tax_unverified` instead of booking reverse charge silently.
  const marked = (advice: BookingAdvice): BookingAdvice =>
    isUnverifiedReverseCharge([advice.taxCode, ...(advice.split ?? []).map((line) => line.taxCode)], question) ? { ...advice, taxUnverified: true } : advice;

  const rawLines = parsed.data.lines ?? [];
  if (rawLines.length === 0) return marked({ accountNumber, taxCode, reason: sentence, split: null });
  if (rawLines.length > MAX_ADVICE_SPLIT_LINES) return null;
  const expected = question.totalAmountCents - (question.passThroughCents ?? 0);
  const split: NonNullable<BookingAdvice["split"]> = [];
  for (const line of rawLines) {
    if (!allowed.has(line.accountNumber) || !Number.isInteger(line.amountCents) || line.amountCents === 0) return null;
    if (Math.sign(line.amountCents) !== Math.sign(expected)) return null;
    const lineTax = taxCodeFor(line.taxCode, question.direction);
    if (lineTax === undefined) return null;
    split.push({ accountNumber: line.accountNumber, taxCode: lineTax, amountCents: line.amountCents });
  }
  if (split.reduce((sum, line) => sum + line.amountCents, 0) !== expected) return null;
  return marked({ accountNumber, taxCode, reason: sentence, split: split.length > 1 ? split : null });
}

/** Bumped whenever the hashed payload's shape changes. */
const ADVICE_CACHE_KEY_FORMAT = 1;

type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical };

/** Sorted keys at every depth, `undefined` dropped, so property order never changes the hash. */
function canonical(value: unknown): Canonical {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const out: { [key: string]: Canonical } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = canonical(inner);
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

/** The whole question plus the advisor's version: the same key means the same question asked of
 * the same model and prompt (the pattern of decisions/0077's arbiter cache). */
export function bookingAdviceCacheKey(question: BookingAdviceQuestion, advisorVersion: string): string {
  const payload = JSON.stringify({ format: ADVICE_CACHE_KEY_FORMAT, advisorVersion, question: canonical(question) });
  return createHash("sha256").update(payload).digest("hex");
}

/** The form an answer is stored in: a malformed answer becomes an empty one (which validation
 * rejects the same way), the reason is shortened to what validation can use. */
export function toCacheableBookingAdvice(raw: unknown): BookingAdviceRaw {
  const parsed = rawAdviceSchema.safeParse(raw);
  if (!parsed.success) return { accountNumber: null, taxCode: null, reason: "", lines: null };
  return {
    accountNumber: parsed.data.accountNumber,
    taxCode: parsed.data.taxCode,
    reason: parsed.data.reason.slice(0, MAX_CACHED_REASON_LENGTH),
    lines: parsed.data.lines?.slice(0, MAX_ADVICE_SPLIT_LINES + 1) ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// The deterministic fake
// ---------------------------------------------------------------------------------------------

type KeywordRule = { keywords: readonly string[]; account: string; label: string; taxCode?: TaxCode };

/** First match wins. Plain lowercase substrings over sender, title and summary. */
const FAKE_KEYWORDS: readonly KeywordRule[] = [
  { keywords: ["gericht", "gerichtskasse", "justiz"], account: "6825", label: "Gerichtskosten", taxCode: "not_taxable" },
  { keywords: ["notar", "rechtsanwalt", "kanzlei"], account: "6825", label: "Rechts- und Beratungskosten" },
  { keywords: ["steuerberat"], account: "6830", label: "Buchführungskosten" },
  { keywords: ["finanzamt", "behörde", "stadtkasse", "gebührenbescheid"], account: "6300", label: "Behördengebühren", taxCode: "not_taxable" },
  { keywords: ["meta platforms", "facebook", "google ads", "werbung", "anzeige"], account: "6600", label: "Werbekosten" },
  { keywords: ["ionos", "hosting", "domain", "server", "hetzner", "cloud"], account: "6810", label: "Internetkosten" },
  { keywords: ["telekom", "vodafone", "mobilfunk", "telefon"], account: "6805", label: "Telefonkosten" },
  { keywords: ["versicherung"], account: "6400", label: "Versicherungen" },
  { keywords: ["ihk", "kammer", "mitgliedsbeitrag"], account: "6420", label: "Beiträge" },
  { keywords: ["kontoführung", "bankgebühr", "musterbank", "transaktionsgebühr"], account: "6855", label: "Nebenkosten des Geldverkehrs" },
  { keywords: ["lizenz", "abonnement", "subscription", "software", "github", "figma", "notion", "adobe", "apple"], account: "6837", label: "Softwarelizenzen" },
  { keywords: ["bürobedarf", "schreibwaren", "papier"], account: "6815", label: "Bürobedarf" },
];

const DUNNING_PATTERN = /mahngeb(?:ühr|uehr)\w*\D{0,20}?(\d{1,3}(?:\.\d{3})*,\d{2})/i;

function germanAmountToCents(text: string): number | null {
  const match = /^(\d{1,3}(?:\.\d{3})*),(\d{2})$/.exec(text);
  if (!match) return null;
  return Number(match[1]!.replace(/\./g, "")) * 100 + Number(match[2]);
}

function hasGermanVat(question: BookingAdviceQuestion): number | null {
  const rates = (question.taxBreakdown ?? []).filter((entry) => (entry.taxCents ?? 0) !== 0).map((entry) => entry.ratePercent);
  if (rates.includes(19)) return 19;
  if (rates.includes(7)) return 7;
  if ((question.taxTotalCents ?? 0) !== 0) return 19;
  return null;
}

/**
 * Keyword-based, no randomness, no clock: what every test and every development run without a
 * Mistral key gets. Account by the first matching keyword (else 6300), tax code from the printed
 * figures (German VAT, reverse charge, a foreign supplier without VAT), a court letter with a
 * dunning fee is split into the fee (6300) and the rest. Always answers within the chart: an
 * account the workspace does not have falls back to the first one offered.
 */
export function createFakeLedgerBookingAdvisor(): LedgerBookingAdvisor {
  return {
    version: "fake:1",
    async advise(question) {
      const offered = new Set(question.accounts.map((account) => account.number));
      const pick = (number: string) => (offered.has(number) ? number : (question.accounts[0]?.number ?? number));
      const haystack = [question.senderName, question.title, question.summary].filter(Boolean).join(" ").toLowerCase();

      if (question.direction === "outgoing") {
        return { accountNumber: pick("4400"), taxCode: "ust19", reason: "Ausgangsrechnung mit dem Regelsteuersatz." };
      }

      const rule = FAKE_KEYWORDS.find((candidate) => candidate.keywords.some((keyword) => haystack.includes(keyword)));
      const vatRate = hasGermanVat(question);
      const foreign = Boolean(question.country && question.country.toUpperCase() !== "DE");
      let taxCode: TaxCode;
      if (question.reverseCharge || (foreign && vatRate === null)) taxCode = "rc13b";
      else if (vatRate === 19) taxCode = "vst19";
      else if (vatRate === 7) taxCode = "vst7";
      else taxCode = rule?.taxCode ?? "vst19";

      const accountNumber = pick(rule?.account ?? "6300");
      const reason = rule ? `Der Beleg nennt ${rule.label}, daher das Konto ${accountNumber}.` : "Kein eindeutiger Hinweis auf dem Beleg, daher sonstige betriebliche Aufwendungen.";

      const dunning = DUNNING_PATTERN.exec(question.summary ?? "");
      const feeCents = dunning ? germanAmountToCents(dunning[1]!) : null;
      const gross = question.totalAmountCents - (question.passThroughCents ?? 0);
      if (feeCents && feeCents > 0 && feeCents < gross) {
        return {
          accountNumber,
          taxCode,
          reason: `Der Beleg enthält ${rule?.label ?? "Kosten"} und eine Mahngebühr, daher zwei Konten.`,
          lines: [
            { accountNumber, taxCode, amountCents: gross - feeCents },
            { accountNumber: pick("6300"), taxCode: "not_taxable", amountCents: feeCents },
          ],
        };
      }
      return { accountNumber, taxCode, reason };
    },
  };
}
