// XXE and entity-expansion ("billion laughs") protection for the XML this service parses, moved
// from Digipost's `src/modules/intake/core/xml-safety.ts`. A bank statement is untrusted input and
// must never reach a parser that could resolve an external entity or expand a nested entity chain.
//
// `assertSafeXml` is the gate: a text scan BEFORE any parsing that rejects a DOCTYPE or a custom
// ENTITY declaration, the building blocks of both attacks. It is necessary, not defense in depth:
// `fast-xml-parser` does resolve a DTD-declared custom entity when entity processing is on, so the
// parser's own options protect nothing. A camt.053 export never has a DOCTYPE.
//
// `createSafeXmlParser` keeps `processEntities` on so the five predefined XML entities still
// decode: the only entity references a DOCTYPE-free document can contain.
import { XMLParser } from "fast-xml-parser";

export class UnsafeXmlError extends Error {
  override readonly name = "UnsafeXmlError";
}

// Matches `<!DOCTYPE` and `<!ENTITY` regardless of case or the whitespace that follows -
// both are illegal in any XML this application expects to receive (ISO 20022 messages and
// ZUGFeRD/Factur-X invoices never declare either).
const DOCTYPE_PATTERN = /<!DOCTYPE\b/i;
const ENTITY_DECLARATION_PATTERN = /<!ENTITY\b/i;

/**
 * Throws `UnsafeXmlError` when `xmlText` declares a DOCTYPE or a custom entity. Call this
 * before any other processing of untrusted XML - `parseCamt053` calls it first, so a malicious upload is rejected before a single byte of it reaches a parser.
 */
export function assertSafeXml(xmlText: string): void {
  if (DOCTYPE_PATTERN.test(xmlText)) {
    throw new UnsafeXmlError("XML document declares a DOCTYPE, which is never processed (XXE protection)");
  }
  if (ENTITY_DECLARATION_PATTERN.test(xmlText)) {
    throw new UnsafeXmlError("XML document declares a custom ENTITY, which is never processed (entity-expansion protection)");
  }
}

/**
 * A `fast-xml-parser` instance configured for this module's needs: attributes are kept
 * (`Ccy` on `<Amt>`, name-tree keys in a ZUGFeRD PDF's `/EmbeddedFiles`), tag values are left
 * as strings (amount parsing needs the original decimal text, never a float). Only ever
 * called after `assertSafeXml` (directly, or via `parseXmlSafely` below) - see this file's
 * own header comment for why that ordering, not a parser option, is what actually matters.
 */
export function createSafeXmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
  });
}

/** `assertSafeXml` followed by a parse with `createSafeXmlParser()` - the one call site every
 * XML entry point in this module should use rather than composing the two itself. */
export function parseXmlSafely(xmlText: string): unknown {
  assertSafeXml(xmlText);
  return createSafeXmlParser().parse(xmlText);
}
