// The AI booking advisor's pure half (decisions/0080 phase 3): "AI proposes, code verifies",
// the answer cache key, the cached form, and the deterministic fake.
import { describe, expect, it } from "vitest";

import { bookingAdviceCacheKey, createFakeLedgerBookingAdvisor, toCacheableBookingAdvice, validateBookingAdvice, type BookingAdviceQuestion } from "../src";

function question(overrides: Partial<BookingAdviceQuestion> = {}): BookingAdviceQuestion {
  return {
    documentId: "doc-1",
    direction: "incoming",
    senderName: "IONOS SE",
    country: "DE",
    vatId: "DE123456789",
    title: "Rechnung Webhosting",
    summary: "Webhosting Juli",
    invoiceNumber: "RE-1",
    documentDate: "2026-07-01",
    totalAmountCents: 150,
    currency: "EUR",
    netTotalCents: 126,
    taxTotalCents: 24,
    passThroughCents: null,
    reverseCharge: false,
    taxBreakdown: [{ ratePercent: 19, netCents: 126, taxCents: 24 }],
    accounts: [
      { number: "6300", name: "Sonstige betriebliche Aufwendungen" },
      { number: "6810", name: "Internetkosten" },
      { number: "6825", name: "Rechts- und Beratungskosten" },
    ],
    ...overrides,
  };
}

describe("validateBookingAdvice: reverse charge without tax figures", () => {
  const noFigures = { country: "IE", vatId: "IE9700053D", netTotalCents: null, taxTotalCents: null, reverseCharge: null, taxBreakdown: null };

  it("keeps an rc13b answer but marks it unverified when the question has no tax figures and no reverse-charge note", () => {
    expect(validateBookingAdvice({ accountNumber: "6810", taxCode: "rc13b", reason: "Ausländischer Anbieter." }, question(noFigures))).toMatchObject({ taxCode: "rc13b", taxUnverified: true });
  });

  it("marks a split naming rc13b the same way", () => {
    const advice = validateBookingAdvice(
      { accountNumber: "6810", taxCode: null, reason: "Zwei Kostenarten.", lines: [{ accountNumber: "6810", taxCode: "rc13b", amountCents: 100 }, { accountNumber: "6300", taxCode: "not_taxable", amountCents: 50 }] },
      question(noFigures),
    );
    expect(advice).toMatchObject({ taxUnverified: true });
  });

  it("does not mark it when the document notes reverse charge or prints tax figures", () => {
    expect(validateBookingAdvice({ accountNumber: "6810", taxCode: "rc13b", reason: "Reverse Charge." }, question({ ...noFigures, reverseCharge: true }))!.taxUnverified).toBeUndefined();
    expect(
      validateBookingAdvice({ accountNumber: "6810", taxCode: "rc13b", reason: "Ohne USt." }, question({ ...noFigures, taxBreakdown: [{ ratePercent: 0, netCents: 150, taxCents: 0 }] }))!.taxUnverified,
    ).toBeUndefined();
    expect(validateBookingAdvice({ accountNumber: "6810", taxCode: "vst19", reason: "Deutsche USt." }, question(noFigures))!.taxUnverified).toBeUndefined();
  });
});

describe("validateBookingAdvice", () => {
  it("accepts an account from the chart with a fitting tax code and keeps only the first sentence", () => {
    expect(validateBookingAdvice({ accountNumber: "6810", taxCode: "vst19", reason: "Hosting ist Internet. Zweiter Satz." }, question())).toEqual({
      accountNumber: "6810",
      taxCode: "vst19",
      reason: "Hosting ist Internet.",
      split: null,
    });
  });

  it.each([
    ["an account outside the chart", { accountNumber: "4400", taxCode: "vst19", reason: "Erlös." }],
    ["an unknown tax code", { accountNumber: "6810", taxCode: "vat20", reason: "Steuer." }],
    ["an output tax code on a purchase", { accountNumber: "6810", taxCode: "ust19", reason: "Steuer." }],
    ["an empty reason", { accountNumber: "6810", taxCode: "vst19", reason: "   " }],
    ["no account", { accountNumber: null, taxCode: "vst19", reason: "Nichts." }],
    ["a wrong shape", { account: "6810" }],
    ["a split that does not add up", { accountNumber: "6825", taxCode: "not_taxable", reason: "Geteilt.", lines: [{ accountNumber: "6825", taxCode: "not_taxable", amountCents: 100 }, { accountNumber: "6300", taxCode: "not_taxable", amountCents: 10 }] }],
    ["a split onto an unknown account", { accountNumber: "6825", taxCode: "not_taxable", reason: "Geteilt.", lines: [{ accountNumber: "6825", taxCode: null, amountCents: 100 }, { accountNumber: "9999", taxCode: null, amountCents: 50 }] }],
    ["a split part of the wrong sign", { accountNumber: "6825", taxCode: "not_taxable", reason: "Geteilt.", lines: [{ accountNumber: "6825", taxCode: null, amountCents: 200 }, { accountNumber: "6300", taxCode: null, amountCents: -50 }] }],
  ])("rejects %s", (_label, raw) => {
    expect(validateBookingAdvice(raw, question())).toBeNull();
  });

  it("accepts a split that adds up to the gross without the pass-through part", () => {
    const advice = validateBookingAdvice(
      { accountNumber: "6825", taxCode: "not_taxable", reason: "Gericht und Mahnung.", lines: [{ accountNumber: "6825", taxCode: "not_taxable", amountCents: 100 }, { accountNumber: "6300", taxCode: null, amountCents: 40 }] },
      question({ passThroughCents: 10 }),
    );
    expect(advice?.split).toEqual([
      { accountNumber: "6825", taxCode: "not_taxable", amountCents: 100 },
      { accountNumber: "6300", taxCode: null, amountCents: 40 },
    ]);
  });
});

describe("bookingAdviceCacheKey", () => {
  it("is stable under property order, and changes with the question or the advisor version", () => {
    const q = question();
    const reordered = Object.fromEntries(Object.entries(q).reverse()) as BookingAdviceQuestion;
    expect(bookingAdviceCacheKey(reordered, "fake:1")).toBe(bookingAdviceCacheKey(q, "fake:1"));
    expect(bookingAdviceCacheKey(q, "fake:2")).not.toBe(bookingAdviceCacheKey(q, "fake:1"));
    expect(bookingAdviceCacheKey(question({ totalAmountCents: 151 }), "fake:1")).not.toBe(bookingAdviceCacheKey(q, "fake:1"));
    expect(bookingAdviceCacheKey(question({ accounts: [{ number: "6300", name: "Sonstige" }] }), "fake:1")).not.toBe(bookingAdviceCacheKey(q, "fake:1"));
  });

  it("stores a malformed answer as an empty one, which validation rejects the same way", () => {
    const stored = toCacheableBookingAdvice("kein json");
    expect(stored).toEqual({ accountNumber: null, taxCode: null, reason: "", lines: null });
    expect(validateBookingAdvice(stored, question())).toBeNull();
    expect(toCacheableBookingAdvice({ accountNumber: "6810", taxCode: "vst19", reason: "x".repeat(5000) }).reason).toHaveLength(1000);
  });
});

describe("createFakeLedgerBookingAdvisor", () => {
  const advisor = createFakeLedgerBookingAdvisor();

  it("answers by keyword, within the chart, deterministically", async () => {
    const answer = await advisor.advise(question());
    expect(answer).toMatchObject({ accountNumber: "6810", taxCode: "vst19" });
    expect(await advisor.advise(question())).toEqual(answer);
    expect(validateBookingAdvice(answer, question())).not.toBeNull();
  });

  it("falls back to an offered account and to reverse charge for a foreign supplier without VAT", async () => {
    const answer = await advisor.advise(question({ senderName: "Meta Platforms Ireland", title: "Werbung", country: "IE", taxBreakdown: null, taxTotalCents: null }));
    expect(answer.taxCode).toBe("rc13b");
    expect(answer.accountNumber).toBe("6300");
  });

  it("splits a court letter with a dunning fee", async () => {
    const answer = await advisor.advise(question({ senderName: "Amtsgericht Berlin", summary: "Gerichtskosten 300,00 EUR, Mahngebühr 5,00 EUR", totalAmountCents: 30_500, taxBreakdown: null, taxTotalCents: null, netTotalCents: null }));
    expect(answer.lines).toEqual([
      { accountNumber: "6825", taxCode: "not_taxable", amountCents: 30_000 },
      { accountNumber: "6300", taxCode: "not_taxable", amountCents: 500 },
    ]);
    expect(validateBookingAdvice(answer, question({ totalAmountCents: 30_500 }))?.split).toHaveLength(2);
  });
});
