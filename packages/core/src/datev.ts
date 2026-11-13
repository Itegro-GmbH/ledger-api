// The DATEV export (decisions/0001-ledger-api.md, "DATEV export"): booked entries of one period
// as a DATEV "Buchungsstapel" (EXTF, format category 21, version 13), the CSV a tax advisor
// imports into DATEV Rechnungswesen. Pure: entries and settings in, text and warnings out; the
// caller encodes the text as Windows-1252 (`encodeWindows1252`).
//
// The layout follows DATEV's format description as practitioners document it (header of 31
// fields, 125 columns per record, Windows-1252, ";" separated, CRLF, decimal comma, amounts
// positive with "S"/"H" relative to the Konto column, Belegdatum TTMM, text in double quotes with
// inner quotes doubled). It must be confirmed by a test import at a tax advisor before the first
// real use; the parts most likely to need adjusting are settings, not code: the tax keys
// (BU-Schlüssel) per tax code and the advisor's automatic accounts.
//
// How an entry becomes rows:
// - A line with a tax code and a tax key is exported as one gross row carrying the key; DATEV
//   computes the tax itself, so the generated tax lines are left out. Reverse charge (13b) is
//   exported net with its key; its two tax lines cancel and are left out too.
// - A line on one of the advisor's automatic accounts (Automatikkonten, which carry their own
//   tax) is exported gross without a key: an automatic account and a key exclude each other.
// - A line whose tax code has no key is exported as it is booked: the net line and its tax lines
//   as separate rows without a key, and the export reports it (`tax_without_key`).
// - DATEV rows have two sides; an entry with several lines on both sides is split into pairs,
//   debit lines against credit lines in order, so every row's amount is covered exactly once.
import type { TaxCode } from "./types";

export const DATEV_FORMAT_VERSION = 13;
export const DATEV_COLUMN_COUNT = 125;
export const DATEV_MAX_ROWS = 99_999;

/** The tax codes that produce tax and therefore need a key or an automatic account. */
const TAXED_CODES: readonly TaxCode[] = ["vst19", "vst7", "ust19", "ust7", "rc13b"];

/** Defaults for SKR03 and SKR04 alike. 9 and 8 are documented for input tax; 3 and 2 are DATEV's
 * output tax keys; reverse charge has no default on purpose (its key depends on the kind of
 * 13b case and must come from the advisor). */
export const DEFAULT_DATEV_TAX_KEYS: Readonly<Partial<Record<TaxCode, string>>> = { vst19: "9", vst7: "8", ust19: "3", ust7: "2" };

/** The revenue accounts DATEV's standard charts carry as automatic accounts. A tenant's advisor
 * may have more; the setting replaces this default. */
export const DEFAULT_DATEV_AUTOMATIC_ACCOUNTS: Readonly<Record<"skr03" | "skr04", readonly string[]>> = {
  skr03: ["8300", "8400"],
  skr04: ["4300", "4400"],
};

export type DatevSettings = {
  consultantNumber: number;
  clientNumber: number;
  /** First day of the fiscal year the export lies in (YYYY-MM-DD). */
  fiscalYearStart: string;
  accountLength: number;
  chart: "skr03" | "skr04";
  taxKeys: Readonly<Partial<Record<TaxCode, string | null>>>;
  automaticAccounts: readonly string[];
};

export type DatevLine = {
  position: number;
  accountNumber: string;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: "base" | "tax" | null;
  generatedFromLinePosition: number | null;
};

export type DatevEntry = {
  id: string;
  bookingDate: string;
  text: string;
  /** Belegfeld 1: the invoice number, the same on an invoice and its payment. */
  documentNumber: string | null;
  lines: readonly DatevLine[];
};

export const DATEV_WARNINGS = ["tax_without_key", "document_number_changed", "text_shortened", "account_longer_than_length"] as const;
export type DatevWarningCode = (typeof DATEV_WARNINGS)[number];
export type DatevWarning = { entryId: string; code: DatevWarningCode; detail?: string };

export const DATEV_ERRORS = ["period_outside_fiscal_year", "entry_outside_period", "too_many_rows", "invalid_settings"] as const;
export type DatevErrorCode = (typeof DATEV_ERRORS)[number];

export type DatevRow = {
  amountCents: number;
  side: "S" | "H";
  account: string;
  contraAccount: string;
  taxKey: string | null;
  bookingDate: string;
  documentNumber: string | null;
  text: string;
};

export type DatevExport = { ok: true; text: string; fileName: string; rows: DatevRow[]; warnings: DatevWarning[] } | { ok: false; error: DatevErrorCode; detail?: string };

/** The 125 column names of a version 13 record, in order. DATEV reads columns by position. */
export const DATEV_COLUMNS: readonly string[] = [
  "Umsatz (ohne Soll/Haben-Kz)", "Soll/Haben-Kennzeichen", "WKZ Umsatz", "Kurs", "Basis-Umsatz", "WKZ Basis-Umsatz", "Konto", "Gegenkonto (ohne BU-Schlüssel)", "BU-Schlüssel", "Belegdatum",
  "Belegfeld 1", "Belegfeld 2", "Skonto", "Buchungstext", "Postensperre", "Diverse Adressnummer", "Geschäftspartnerbank", "Sachverhalt", "Zinssperre", "Beleglink",
  ...Array.from({ length: 8 }, (_, i) => [`Beleginfo - Art ${i + 1}`, `Beleginfo - Inhalt ${i + 1}`]).flat(),
  "KOST1 - Kostenstelle", "KOST2 - Kostenstelle", "Kost-Menge", "EU-Land u. UStID", "EU-Steuersatz", "Abw. Versteuerungsart", "Sachverhalt L+L", "Funktionsergänzung L+L", "BU 49 Hauptfunktionstyp", "BU 49 Hauptfunktionsnummer", "BU 49 Funktionsergänzung",
  ...Array.from({ length: 20 }, (_, i) => [`Zusatzinformation - Art ${i + 1}`, `Zusatzinformation- Inhalt ${i + 1}`]).flat(),
  "Stück", "Gewicht", "Zahlweise", "Forderungsart", "Veranlagungsjahr", "Zugeordnete Fälligkeit", "Skontotyp", "Auftragsnummer", "Buchungstyp", "Ust-Schlüssel (Anzahlungen)",
  "EU-Land (Anzahlungen)", "Sachverhalt L+L (Anzahlungen)", "EU-Steuersatz (Anzahlungen)", "Erlöskonto (Anzahlungen)", "Herkunft-Kz", "Leerfeld DATEV intern", "KOST-Datum", "SEPA-Mandatsreferenz", "Skontosperre", "Gesellschaftername",
  "Beteiligtennummer", "Identifikationsnummer", "Zeichnernummer", "Postensperre bis", "Bezeichnung SoBil-Sachverhalt", "Kennzeichnung SoBil-Buchung", "Festschreibung", "Leistungsdatum", "Datum Zuord. Steuerperiode", "Fälligkeit",
  "Generalumkehr (GU)", "Steuersatz", "Land", "Abrechnungsreferenz", "BVV-Position", "EU-Mitgliedstaat u. UStID (Ursprung)", "EU-Steuersatz (Ursprung)",
  // Version 13's added column. Its name is not confirmed; DATEV reads by position.
  "Abw. Skontokonto",
];

const COL = { festschreibung: DATEV_COLUMNS.indexOf("Festschreibung") };

// --- Splitting entries into rows ---------------------------------------------------------------

type ExportLine = { accountNumber: string; amountCents: number; taxKey: string | null };

/** The lines as DATEV should see them: keyed lines gross (or net for reverse charge) with their
 * generated tax lines folded in, everything else as booked. */
export function datevLinesOf(entry: DatevEntry, settings: Pick<DatevSettings, "taxKeys" | "automaticAccounts">): { lines: ExportLine[]; warnings: DatevWarning[] } {
  const warnings: DatevWarning[] = [];
  const folded = new Set<number>();
  const out: ExportLine[] = [];
  const taxOf = (base: DatevLine) => entry.lines.filter((line) => line.taxRole === "tax" && line.generatedFromLinePosition === base.position);

  for (const line of entry.lines) {
    if (line.taxRole === "tax") continue;
    const code = line.taxCode;
    const taxLines = taxOf(line);
    if (!code || !TAXED_CODES.includes(code) || taxLines.length === 0) {
      out.push({ accountNumber: line.accountNumber, amountCents: line.amountCents, taxKey: null });
      continue;
    }
    const automatic = settings.automaticAccounts.includes(line.accountNumber);
    const key = automatic ? null : (settings.taxKeys[code] ?? null);
    if (automatic || key) {
      const reverseCharge = code === "rc13b";
      const amount = reverseCharge ? line.amountCents : line.amountCents + taxLines.reduce((sum, tax) => sum + tax.amountCents, 0);
      out.push({ accountNumber: line.accountNumber, amountCents: amount, taxKey: key });
      for (const tax of taxLines) folded.add(tax.position);
      continue;
    }
    warnings.push({ entryId: entry.id, code: "tax_without_key", detail: code });
    out.push({ accountNumber: line.accountNumber, amountCents: line.amountCents, taxKey: null });
  }
  for (const line of entry.lines) {
    if (line.taxRole === "tax" && !folded.has(line.position)) out.push({ accountNumber: line.accountNumber, amountCents: line.amountCents, taxKey: null });
  }
  return { lines: out.filter((line) => line.amountCents !== 0), warnings };
}

/** Debit lines against credit lines in order: every row has an account and a contra account, and
 * every cent of every line is in exactly one row. The keyed line is put in the Konto column, so
 * its key applies to it; otherwise the debit line is the Konto ("S"). */
export function pairLines(lines: readonly ExportLine[]): { amountCents: number; side: "S" | "H"; account: string; contraAccount: string; taxKey: string | null }[] {
  const debits = lines.filter((line) => line.amountCents > 0).map((line) => ({ ...line, left: line.amountCents }));
  const credits = lines.filter((line) => line.amountCents < 0).map((line) => ({ ...line, left: -line.amountCents }));
  const rows: ReturnType<typeof pairLines> = [];
  let i = 0;
  let j = 0;
  while (i < debits.length && j < credits.length) {
    const debit = debits[i]!;
    const credit = credits[j]!;
    const amount = Math.min(debit.left, credit.left);
    if (credit.taxKey && !debit.taxKey) rows.push({ amountCents: amount, side: "H", account: credit.accountNumber, contraAccount: debit.accountNumber, taxKey: credit.taxKey });
    else rows.push({ amountCents: amount, side: "S", account: debit.accountNumber, contraAccount: credit.accountNumber, taxKey: debit.taxKey });
    debit.left -= amount;
    credit.left -= amount;
    if (debit.left === 0) i += 1;
    if (credit.left === 0) j += 1;
  }
  return rows;
}

// --- Formatting ------------------------------------------------------------------------------

/** 1428,00: no sign, no thousands separator, decimal comma, two decimals. */
export function datevAmount(cents: number): string {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** TTMM. */
export function datevDate(isoDate: string): string {
  return `${isoDate.slice(8, 10)}${isoDate.slice(5, 7)}`;
}

/** Belegfeld 1 allows letters, digits and `$&%*+-/`, up to 36 characters. */
export function datevDocumentNumber(value: string | null): { value: string; changed: boolean } {
  if (!value) return { value: "", changed: false };
  const cleaned = value.replace(/[^A-Za-z0-9$&%*+\-/]/g, "").slice(0, 36);
  return { value: cleaned, changed: cleaned !== value };
}

/** Characters Windows-1252 cannot hold, mapped to readable replacements, before quoting. */
function plain(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .trim();
}

function quote(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** Buchungstext: at most 60 characters. */
export function datevText(text: string): { value: string; shortened: boolean } {
  const cleaned = plain(text);
  return { value: cleaned.slice(0, 60), shortened: cleaned.length > 60 };
}

function compactDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

function createdStamp(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}`;
}

function addYear(isoDate: string): string {
  return `${Number(isoDate.slice(0, 4)) + 1}${isoDate.slice(4)}`;
}

/** The 31 header fields, the first line of the file. */
export function datevHeader(settings: DatevSettings, period: { from: string; to: string }, description: string, createdAt: Date): string {
  const fields = [
    quote("EXTF"), "700", "21", quote("Buchungsstapel"), String(DATEV_FORMAT_VERSION), createdStamp(createdAt), "", quote("LG"), quote("ledger-api"), quote(""),
    String(settings.consultantNumber), String(settings.clientNumber), compactDate(settings.fiscalYearStart), String(settings.accountLength), compactDate(period.from), compactDate(period.to),
    quote(plain(description).slice(0, 30)), quote(""), "1", "0", "0", quote("EUR"), "", quote(""), "", "", quote(settings.chart === "skr03" ? "03" : "04"), "", "", quote(""), quote(""),
  ];
  return fields.join(";");
}

function recordLine(row: DatevRow): string {
  const cells: string[] = new Array<string>(DATEV_COLUMN_COUNT).fill("");
  cells[0] = datevAmount(row.amountCents);
  cells[1] = quote(row.side);
  cells[2] = quote("EUR");
  cells[6] = row.account;
  cells[7] = row.contraAccount;
  cells[8] = row.taxKey ? quote(row.taxKey) : "";
  cells[9] = datevDate(row.bookingDate);
  cells[10] = quote(row.documentNumber ?? "");
  cells[13] = quote(row.text);
  cells[COL.festschreibung] = "0";
  return cells.join(";");
}

// --- The export ------------------------------------------------------------------------------

export function validateDatevSettings(settings: DatevSettings): string | null {
  if (!Number.isInteger(settings.consultantNumber) || settings.consultantNumber < 1001 || settings.consultantNumber > 9_999_999) return "consultantNumber";
  if (!Number.isInteger(settings.clientNumber) || settings.clientNumber < 1 || settings.clientNumber > 99_999) return "clientNumber";
  if (!Number.isInteger(settings.accountLength) || settings.accountLength < 4 || settings.accountLength > 8) return "accountLength";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.fiscalYearStart)) return "fiscalYearStart";
  return null;
}

/**
 * The Buchungsstapel for `period` from booked `entries`. One file covers one fiscal year at most:
 * `period` must lie inside the fiscal year starting at `settings.fiscalYearStart`, and every
 * entry inside `period`.
 */
export function buildDatevExport(input: { settings: DatevSettings; period: { from: string; to: string }; entries: readonly DatevEntry[]; description: string; createdAt: Date }): DatevExport {
  const { settings, period } = input;
  const invalid = validateDatevSettings(settings);
  if (invalid) return { ok: false, error: "invalid_settings", detail: invalid };
  if (period.from < settings.fiscalYearStart || period.to >= addYear(settings.fiscalYearStart) || period.from > period.to) return { ok: false, error: "period_outside_fiscal_year" };

  const rows: DatevRow[] = [];
  const warnings: DatevWarning[] = [];
  for (const entry of [...input.entries].sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id))) {
    if (entry.bookingDate < period.from || entry.bookingDate > period.to) return { ok: false, error: "entry_outside_period", detail: entry.id };
    const { lines, warnings: lineWarnings } = datevLinesOf(entry, settings);
    warnings.push(...lineWarnings);
    const number = datevDocumentNumber(entry.documentNumber);
    if (number.changed) warnings.push({ entryId: entry.id, code: "document_number_changed", detail: number.value });
    const text = datevText(entry.text);
    if (text.shortened) warnings.push({ entryId: entry.id, code: "text_shortened" });
    for (const line of lines) {
      if (line.accountNumber.length > settings.accountLength + 1) warnings.push({ entryId: entry.id, code: "account_longer_than_length", detail: line.accountNumber });
    }
    for (const pair of pairLines(lines)) rows.push({ ...pair, bookingDate: entry.bookingDate, documentNumber: number.value || null, text: text.value });
  }
  if (rows.length > DATEV_MAX_ROWS) return { ok: false, error: "too_many_rows" };

  const text = [datevHeader(settings, period, input.description, input.createdAt), DATEV_COLUMNS.join(";"), ...rows.map(recordLine)].join("\r\n") + "\r\n";
  const fileName = `EXTF_Buchungsstapel_${compactDate(period.from)}_${compactDate(period.to)}.csv`;
  return { ok: true, text, fileName, rows, warnings };
}

// --- Windows-1252 --------------------------------------------------------------------------------

/** The characters 0x80 to 0x9F of Windows-1252 (the rest of 0x00 to 0xFF equals Latin-1). */
const CP1252_HIGH: Readonly<Record<string, number>> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** The text as Windows-1252 bytes; a character it cannot hold becomes `?`. */
export function encodeWindows1252(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else bytes.push(CP1252_HIGH[char] ?? 0x3f);
  }
  return Uint8Array.from(bytes);
}

export function isTaxedCode(code: TaxCode | null): boolean {
  return code !== null && TAXED_CODES.includes(code);
}
