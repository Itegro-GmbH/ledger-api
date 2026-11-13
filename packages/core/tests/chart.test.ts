// The SKR 04 seed chart and the number ranges for owned accounts.
import { describe, expect, it } from "vitest";

import {
  BANK_ACCOUNT_NUMBERS,
  CONTACT_CLEARING_NUMBERS,
  contactLedgerAccountText,
  nextFreeNumber,
  PLATFORM_RECEIVABLE_NUMBERS,
  platformLedgerAccountText,
  SKR04_SEED_ACCOUNTS,
  TAX_ACCOUNT_NUMBERS,
  TAX_CODE_DEFINITIONS,
} from "../src";

describe("SKR04_SEED_ACCOUNTS", () => {
  it("has unique, sorted four-digit numbers", () => {
    const numbers = SKR04_SEED_ACCOUNTS.map((account) => account.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect([...numbers].sort()).toEqual(numbers);
    expect(numbers.every((number) => /^\d{4}$/.test(number))).toBe(true);
  });

  it("contains every account a generated tax line can land on", () => {
    const numbers = new Set(SKR04_SEED_ACCOUNTS.map((account) => account.number));
    for (const number of TAX_ACCOUNT_NUMBERS) expect(numbers.has(number)).toBe(true);
    for (const def of Object.values(TAX_CODE_DEFINITIONS)) {
      if (def.taxAccountNumber) expect(numbers.has(def.taxAccountNumber)).toBe(true);
      if (def.reverseChargeAccounts) {
        expect(numbers.has(def.reverseChargeAccounts.input)).toBe(true);
        expect(numbers.has(def.reverseChargeAccounts.output)).toBe(true);
      }
    }
  });

  it("marks the open-item accounts the brief needs", () => {
    const openItems = SKR04_SEED_ACCOUNTS.filter((account) => account.openItems).map((account) => account.number);
    expect(openItems).toEqual(expect.arrayContaining(["1200", "1360", "3300", "3510"]));
  });

  it("describes every account in one German sentence without dashes", () => {
    for (const account of SKR04_SEED_ACCOUNTS) {
      expect(account.description.length).toBeGreaterThan(10);
      expect(account.description).toMatch(/\.$/);
      expect(account.description + account.name).not.toMatch(/[–—]/);
    }
  });

  it("keeps the ranges for owned accounts free of seeded numbers (1800 aside, which the first bank account takes over)", () => {
    const seeded = new Set(SKR04_SEED_ACCOUNTS.map((account) => account.number));
    for (const number of [...BANK_ACCOUNT_NUMBERS.slice(1), ...PLATFORM_RECEIVABLE_NUMBERS, ...CONTACT_CLEARING_NUMBERS]) expect(seeded.has(number)).toBe(false);
  });
});

describe("nextFreeNumber", () => {
  it("returns the first number not taken, or null when the range is full", () => {
    expect(nextFreeNumber(["1370", "1371"], new Set(["1370"]))).toBe("1371");
    expect(nextFreeNumber(["1370"], new Set(["1370"]))).toBeNull();
  });
});

describe("owned account texts", () => {
  it("names platform and contact accounts plainly", () => {
    expect(platformLedgerAccountText("apple").name).toBe("Forderung Apple");
    expect(platformLedgerAccountText("google").name).toBe("Forderung Google Play");
    expect(contactLedgerAccountText("Meta Platforms Ireland").name).toBe("Verrechnungskonto Meta Platforms Ireland");
  });
});
