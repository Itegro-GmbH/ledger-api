// The accounts page's view model (decisions/0080 UI concept B, screen A): grouping in a fixed
// order, plain-language signs, accounts without movement, mixed groups without a "Stand".
import { describe, expect, it } from "vitest";

import { buildBalanceGroups, isCreditNormal, openItemAccountType, type BalanceRow, type LedgerAccountView } from "../src";

function account(number: string, name: string, kind: LedgerAccountView["kind"], group: LedgerAccountView["group"], overrides: Partial<LedgerAccountView> = {}): LedgerAccountView {
  return {
    id: `id-${number}`,
    number,
    name,
    kind,
    group,
    openItems: false,
    ownerType: null,
    ownerBankAccountId: null,
    ownerContactId: null,
    ownerPlatform: null,
    ownerPersonName: null,
    description: `Erklärung ${name}`,
    archived: false,
    ...overrides,
  };
}

function row(a: LedgerAccountView, debit: number, credit: number, opening = 0): BalanceRow {
  return { accountId: a.id, number: a.number, name: a.name, kind: a.kind, group: a.group, openItems: a.openItems, openingCents: opening, debitCents: debit, creditCents: credit, closingCents: opening + debit - credit };
}

const bank = account("1800", "Bank", "asset", "bank");
const capital = account("2900", "Gezeichnetes Kapital", "equity", "equity");
const internet = account("6810", "Internetkosten", "expense", "costs");
const office = account("6815", "Bürobedarf", "expense", "costs");
const inputTax = account("1406", "Vorsteuer 19 %", "asset", "taxes");
const outputTax = account("3837", "Umsatzsteuer 13b", "liability", "taxes");
const archived = account("6300", "Sonstiges", "expense", "costs", { archived: true });
const ACCOUNTS = [bank, capital, internet, office, inputTax, outputTax, archived];

describe("buildBalanceGroups", () => {
  const rows = [row(internet, 126, 0), row(bank, 416700, 150), row(capital, 0, 416700), row(inputTax, 24, 0), row(outputTax, 0, 19)];

  it("orders the groups like the chart (bank first) and the accounts by number", () => {
    const groups = buildBalanceGroups(rows, ACCOUNTS, { showEmpty: false });
    expect(groups.map((group) => group.group)).toEqual(["bank", "costs", "taxes", "equity"]);
    expect(groups.find((group) => group.group === "taxes")!.rows.map((r) => r.number)).toEqual(["1406", "3837"]);
  });

  it("shows credit-normal accounts as positive amounts in the plain view", () => {
    const groups = buildBalanceGroups(rows, ACCOUNTS, { showEmpty: false });
    const equity = groups.find((group) => group.group === "equity")!;
    expect(equity.rows[0]).toMatchObject({ naturalCents: 416700, inCents: 416700, outCents: 0, closingCents: -416700 });
    expect(equity.naturalCents).toBe(416700);
    const bankRow = groups[0]!.rows[0]!;
    expect(bankRow).toMatchObject({ naturalCents: 416550, inCents: 416700, outCents: 150, description: "Erklärung Bank" });
  });

  it("leaves the Stand of a mixed group open (Vorsteuer and Umsatzsteuer do not add up)", () => {
    const taxes = buildBalanceGroups(rows, ACCOUNTS, { showEmpty: false }).find((group) => group.group === "taxes")!;
    expect(taxes.naturalCents).toBeNull();
    expect(taxes.totals).toMatchObject({ debitCents: 24, creditCents: 19, closingCents: 5 });
  });

  it("adds the accounts without movement on request, never archived ones", () => {
    const groups = buildBalanceGroups(rows, ACCOUNTS, { showEmpty: true });
    const costs = groups.find((group) => group.group === "costs")!;
    expect(costs.rows.map((r) => r.number)).toEqual(["6810", "6815"]);
    expect(costs.rows[1]).toMatchObject({ debitCents: 0, creditCents: 0, naturalCents: 0 });
  });

  it("drops groups without a row", () => {
    expect(buildBalanceGroups([], ACCOUNTS, { showEmpty: false })).toEqual([]);
  });
});

describe("isCreditNormal and openItemAccountType", () => {
  it("knows which kinds sit on the Haben side", () => {
    expect(["liability", "equity", "revenue"].every((kind) => isCreditNormal(kind as LedgerAccountView["kind"]))).toBe(true);
    expect(isCreditNormal("asset")).toBe(false);
    expect(isCreditNormal("expense")).toBe(false);
  });

  it("explains each kind of open-item account", () => {
    expect(openItemAccountType(account("1461", "Meta", "asset", "open_items", { ownerType: "contact" }))).toBe("prepaid");
    expect(openItemAccountType(account("1370", "Apple", "asset", "open_items", { ownerType: "platform" }))).toBe("receivable");
    expect(openItemAccountType(account("3511", "Erika", "liability", "open_items", { ownerType: "person" }))).toBe("shareholder");
    expect(openItemAccountType(account("3510", "Gesellschafter", "liability", "open_items"))).toBe("shareholder");
    expect(openItemAccountType(account("3300", "Verbindlichkeiten", "liability", "open_items"))).toBe("payable");
    expect(openItemAccountType(account("1200", "Forderungen", "asset", "open_items"))).toBe("receivable");
    expect(openItemAccountType(account("1360", "Geldtransit", "asset", "other"))).toBe("generic");
  });
});
