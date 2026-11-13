// The SKR 04 subset a workspace starts with (decisions/0080, spec section 6), and the number
// ranges accounts owned by a bank account, platform, contact or person are created in. Names
// and descriptions are German data shown as they are; they are not UI copy keys, because a
// workspace may rename an account and the stored name is what the books show from then on.
import type { LedgerAccountGroup, LedgerAccountKind } from "./types";

export type SeedAccount = {
  number: string;
  name: string;
  kind: LedgerAccountKind;
  group: LedgerAccountGroup;
  openItems: boolean;
  description: string;
};

const seed = (number: string, name: string, kind: LedgerAccountKind, group: LedgerAccountGroup, description: string, openItems = false): SeedAccount => ({
  number,
  name,
  kind,
  group,
  openItems,
  description,
});

/** Sorted by number. Every tax account `expandTaxLines` can generate a line on is part of it. */
export const SKR04_SEED_ACCOUNTS: readonly SeedAccount[] = [
  seed("1200", "Forderungen aus Lieferungen und Leistungen", "asset", "open_items", "Rechnungen, die Sie geschrieben haben und deren Zahlung noch aussteht.", true),
  seed("1360", "Geldtransit", "asset", "other", "Geld unterwegs zwischen zwei eigenen Konten, zum Beispiel eine Umbuchung von der Bank auf ein anderes eigenes Konto.", true),
  seed("1401", "Abziehbare Vorsteuer 7 %", "asset", "taxes", "Die Umsatzsteuer mit 7 % auf Ihre Einkäufe, die Ihnen das Finanzamt erstattet."),
  seed("1406", "Abziehbare Vorsteuer 19 %", "asset", "taxes", "Die Umsatzsteuer mit 19 % auf Ihre Einkäufe, die Ihnen das Finanzamt erstattet."),
  seed(
    "1407",
    "Abziehbare Vorsteuer nach § 13b UStG 19 %",
    "asset",
    "taxes",
    "Die Steuer auf Leistungen ausländischer Anbieter, die Sie selbst schulden und im selben Zug als Vorsteuer wieder abziehen.",
  ),
  seed("1421", "Umsatzsteuerforderungen", "asset", "taxes", "Ein Guthaben beim Finanzamt aus einer Umsatzsteuer-Voranmeldung."),
  seed("1800", "Bank", "asset", "bank", "Ihr Geschäftskonto. Der Stand muss an jedem Tag mit dem Kontoauszug übereinstimmen."),
  seed("2900", "Gezeichnetes Kapital", "equity", "equity", "Das im Gesellschaftsvertrag vereinbarte Stammkapital der Gesellschaft."),
  seed(
    "2970",
    "Gewinnvortrag vor Verwendung",
    "equity",
    "equity",
    "Gewinne und Verluste früherer Jahre, solange die Gesellschafter nicht über ihre Verwendung entschieden haben. Die Summen- und Saldenliste trägt das Ergebnis der Vorjahre hier vor.",
  ),
  seed("3300", "Verbindlichkeiten aus Lieferungen und Leistungen", "liability", "open_items", "Rechnungen, die Sie erhalten und noch nicht bezahlt haben.", true),
  seed("3500", "Sonstige Verbindlichkeiten", "liability", "other", "Schulden, die zu keinem anderen Konto passen, zum Beispiel gegenüber einer Behörde."),
  seed(
    "3510",
    "Verbindlichkeiten gegenüber Gesellschaftern",
    "liability",
    "open_items",
    "Auslagen, die ein Gesellschafter privat bezahlt hat und die ihm die Gesellschaft noch erstattet.",
    true,
  ),
  seed("3801", "Umsatzsteuer 7 %", "liability", "taxes", "Die Umsatzsteuer mit 7 % auf Ihre Verkäufe, die Sie an das Finanzamt abführen."),
  seed("3806", "Umsatzsteuer 19 %", "liability", "taxes", "Die Umsatzsteuer mit 19 % auf Ihre Verkäufe, die Sie an das Finanzamt abführen."),
  seed("3820", "Umsatzsteuer-Vorauszahlungen", "liability", "taxes", "Was Sie mit der Umsatzsteuer-Voranmeldung an das Finanzamt zahlen oder von ihm erstattet bekommen."),
  seed(
    "3837",
    "Umsatzsteuer nach § 13b UStG 19 %",
    "liability",
    "taxes",
    "Die Umsatzsteuer, die Sie für einen ausländischen Anbieter schulden. Sie steht immer zusammen mit der Vorsteuer auf 1407.",
  ),
  seed("4200", "Erlöse", "revenue", "revenue", "Einnahmen aus Verkäufen, die zu keinem genaueren Erlöskonto passen."),
  seed("4300", "Erlöse 7 % USt", "revenue", "revenue", "Einnahmen aus Verkäufen mit 7 % Umsatzsteuer."),
  seed("4338", "Nicht steuerbare Umsätze Drittland", "revenue", "revenue", "Einnahmen von Kunden außerhalb der EU, für die in Deutschland keine Umsatzsteuer anfällt."),
  seed("4339", "Nicht steuerbare Umsätze EU-Land", "revenue", "revenue", "Einnahmen von Unternehmen in einem anderen EU-Land, die dort versteuert werden."),
  seed("4400", "Erlöse 19 % USt", "revenue", "revenue", "Einnahmen aus Verkäufen mit 19 % Umsatzsteuer."),
  seed("4830", "Sonstige betriebliche Erträge", "revenue", "revenue", "Einnahmen, die keine Verkäufe sind, zum Beispiel eine Erstattung oder eine Gutschrift."),
  seed("6300", "Sonstige betriebliche Aufwendungen", "expense", "costs", "Ausgaben, die zu keinem genaueren Kostenkonto passen."),
  seed("6400", "Versicherungen", "expense", "costs", "Beiträge für betriebliche Versicherungen, zum Beispiel die Betriebshaftpflicht."),
  seed("6420", "Beiträge", "expense", "costs", "Beiträge an Kammern und Verbände, zum Beispiel die IHK."),
  seed("6495", "Wartungskosten für Hard- und Software", "expense", "costs", "Wartung und Pflege von Geräten und Programmen."),
  seed("6600", "Werbekosten", "expense", "costs", "Anzeigen und Werbung, zum Beispiel bei Meta oder Google Ads."),
  seed("6640", "Bewirtungskosten", "expense", "costs", "Essen mit Geschäftspartnern. Es gelten besondere Regeln für den Abzug."),
  seed("6650", "Reisekosten", "expense", "costs", "Fahrten, Übernachtungen und Verpflegung auf Geschäftsreisen."),
  seed("6805", "Telefon", "expense", "costs", "Telefon und Mobilfunk."),
  seed("6810", "Internetkosten", "expense", "costs", "Internetzugang, Domains und Hosting, zum Beispiel bei IONOS."),
  seed("6815", "Bürobedarf", "expense", "costs", "Papier, Schreibwaren und anderes Verbrauchsmaterial für das Büro."),
  seed("6825", "Rechts- und Beratungskosten", "expense", "costs", "Notar, Rechtsanwalt, Gericht und andere Beratung."),
  seed("6827", "Abschluss- und Prüfungskosten", "expense", "costs", "Die Kosten für den Jahresabschluss durch Ihre Steuerberatung."),
  seed("6830", "Buchführungskosten", "expense", "costs", "Die laufende Buchhaltung durch Ihre Steuerberatung."),
  seed(
    "6837",
    "Aufwendungen für die zeitlich befristete Überlassung von Rechten (Lizenzen)",
    "expense",
    "costs",
    "Software im Abonnement und andere Lizenzen, die Sie für eine bestimmte Zeit nutzen.",
  ),
  seed("6850", "Sonstiger Betriebsbedarf", "expense", "costs", "Kleinere Anschaffungen für den Betrieb, die kein Bürobedarf sind."),
  seed("6855", "Nebenkosten des Geldverkehrs", "expense", "costs", "Kontoführung, Überweisungsgebühren und Gebühren von Zahlungsanbietern."),
  seed("7600", "Körperschaftsteuer", "expense", "taxes", "Die Steuer auf den Gewinn der Gesellschaft."),
  seed("7610", "Gewerbesteuer", "expense", "taxes", "Die Gewerbesteuer der Gemeinde auf den Gewinn."),
  seed("9000", "Saldenvorträge", "equity", "other", "Die Gegenbuchung für Anfangsbestände, wenn Sie die Buchhaltung mitten im Jahr beginnen."),
];

/** Where a second, third ... bank account's ledger account goes: 1800 is the first. */
export const BANK_ACCOUNT_NUMBERS: readonly string[] = ["1800", "1810", "1820", "1830", "1840", "1850", "1860", "1870", "1880", "1890"];

const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

/** Receivables against a platform (Apple, Google Play, ...), one each. */
export const PLATFORM_RECEIVABLE_NUMBERS: readonly string[] = range(1370, 1379);
/** Clearing accounts of a supplier billed by threshold or prepaid (Meta, Google Ads, ...). */
export const CONTACT_CLEARING_NUMBERS: readonly string[] = range(1461, 1499);
/** One account per shareholder for expenses paid privately (3510 is the shared one). */
export const PERSON_ACCOUNT_NUMBERS: readonly string[] = range(3511, 3519);

/** The first candidate not taken yet, or `null` when the range is full. */
export function nextFreeNumber(candidates: readonly string[], taken: ReadonlySet<string>): string | null {
  return candidates.find((candidate) => !taken.has(candidate)) ?? null;
}

const PLATFORM_NAMES: Record<string, string> = {
  apple: "Apple",
  google: "Google Play",
  stripe: "Stripe",
  paypal: "PayPal",
  amazon: "Amazon",
};

/** The display name of a settlement platform (`documents.platform`, `accounts.platform`). */
export function platformDisplayName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? "Plattform";
}

/** Name and description of the ledger account a bank `accounts` row gets. */
export function bankLedgerAccountText(bankAccountName: string): { name: string; description: string } {
  return {
    name: `Bank ${bankAccountName}`.trim(),
    description: `Das Bankkonto ${bankAccountName}. Der Stand muss an jedem Tag mit dem Kontoauszug übereinstimmen.`,
  };
}

export function platformLedgerAccountText(platform: string): { name: string; description: string } {
  const name = platformDisplayName(platform);
  return {
    name: `Forderung ${name}`,
    description: `Was ${name} Ihnen aus Verkäufen schuldet, bis die Auszahlung auf der Bank eingeht.`,
  };
}

export function contactLedgerAccountText(contactName: string): { name: string; description: string } {
  return {
    name: `Verrechnungskonto ${contactName}`,
    description: `Guthaben, Abbuchungen und Rechnungen von ${contactName} gleichen sich hier aus. Am Ende steht es auf null oder auf einem erklärten Guthaben.`,
  };
}

export function personLedgerAccountText(personName: string): { name: string; description: string } {
  return {
    name: `Auslagen ${personName}`,
    description: `Was ${personName} privat für die Gesellschaft bezahlt hat und noch erstattet bekommt.`,
  };
}
