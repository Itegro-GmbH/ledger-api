// Controls and the derived period status (decisions/0080 "Controls").
import { describe, expect, it } from "vitest";

import { compareBankBalances, computeControls, dayBefore, derivePeriodStatus, vatPeriodOf, vatPeriodsOfYear, yearPeriod, type ControlsInput } from "../src";

const august = { from: "2026-08-01", to: "2026-08-31" };

describe("periods", () => {
  it("lists months and quarters of a year", () => {
    const months = vatPeriodsOfYear(2026, "month");
    expect(months).toHaveLength(12);
    expect(months[1]).toEqual({ key: "2026-02", from: "2026-02-01", to: "2026-02-28" });
    expect(vatPeriodsOfYear(2028, "month")[1]!.to).toBe("2028-02-29");
    expect(vatPeriodsOfYear(2026, "quarter")[2]).toEqual({ key: "2026-Q3", from: "2026-07-01", to: "2026-09-30" });
  });

  it("finds the period of a date", () => {
    expect(vatPeriodOf("2026-08-19", "month").key).toBe("2026-08");
    expect(vatPeriodOf("2026-08-19", "quarter").key).toBe("2026-Q3");
    expect(yearPeriod(2026)).toEqual({ key: "2026", from: "2026-01-01", to: "2026-12-31" });
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
  });
});

describe("compareBankBalances", () => {
  // Hausbank in August: the Google Ads debit of 50,00 on 19.08. was never booked.
  const real = {
    openingCents: 0,
    movements: [
      { date: "2026-06-10", amountCents: 1250100 },
      { date: "2026-08-10", amountCents: -1000 },
      { date: "2026-08-19", amountCents: -5000 },
      { date: "2026-08-25", amountCents: -3657 },
    ],
  };

  it("passes when the ledger follows the bank to the cent", () => {
    const result = compareBankBalances({ accountNumber: "1800", ledger: real, real }, august);
    expect(result).toEqual({ accountNumber: "1800", ok: true, firstDivergenceDate: null, ledgerClosingCents: 1240443, realClosingCents: 1240443 });
  });

  it("names the first day the balances differ: the unbooked Google Ads debit on 19.08.", () => {
    const ledger = { openingCents: 0, movements: real.movements.filter((movement) => movement.date !== "2026-08-19") };
    const result = compareBankBalances({ accountNumber: "1800", ledger, real }, august);
    expect(result.ok).toBe(false);
    expect(result.firstDivergenceDate).toBe("2026-08-19");
    expect(result.ledgerClosingCents - result.realClosingCents).toBe(5000);
  });

  it("reports the period start when the balances already differ when it opens", () => {
    const ledger = { openingCents: 0, movements: [{ date: "2026-06-10", amountCents: 1250000 }, ...real.movements.slice(1)] };
    expect(compareBankBalances({ accountNumber: "1800", ledger, real }, august).firstDivergenceDate).toBe("2026-08-01");
  });

  it("a booking on the wrong day diverges on that day even if the month ends equal", () => {
    const ledger = { openingCents: 0, movements: [...real.movements.slice(0, 2), { date: "2026-08-20", amountCents: -5000 }, real.movements[3]!] };
    const result = compareBankBalances({ accountNumber: "1800", ledger, real }, august);
    expect(result.firstDivergenceDate).toBe("2026-08-19");
    expect(result.ok).toBe(false);
    expect(result.ledgerClosingCents).toBe(result.realClosingCents);
  });
});

const passing: ControlsInput = {
  bank: [{ accountNumber: "1800", ok: true, firstDivergenceDate: null, ledgerClosingCents: 0, realClosingCents: 0 }],
  unbookedBankTransactionIds: [],
  unbookedDocumentIds: [],
  openItemAccounts: [{ accountNumber: "1461", status: "explained", balanceCents: 4 }],
  proposalsWaiting: 0,
  unbalancedProposals: 0,
  advisorDifferences: null,
};

describe("computeControls", () => {
  it("returns every control in a fixed order", () => {
    const controls = computeControls(passing);
    expect(controls.map((control) => control.id)).toEqual([
      "bank_matches_statement",
      "unbooked_bank_transactions",
      "unbooked_documents",
      "open_item_accounts",
      "unbalanced_entries",
      "proposals_waiting",
      "advisor_differences",
    ]);
    expect(controls.map((control) => control.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "not_applicable"]);
  });

  it("reports failures with counts, subjects and the message key", () => {
    const controls = computeControls({
      bank: [{ accountNumber: "1800", ok: false, firstDivergenceDate: "2026-08-19", ledgerClosingCents: 5000, realClosingCents: 0 }],
      unbookedBankTransactionIds: ["tx1", "tx2"],
      unbookedDocumentIds: ["doc1"],
      openItemAccounts: [
        { accountNumber: "1462", status: "open", balanceCents: -5000 },
        { accountNumber: "1461", status: "zero", balanceCents: 0 },
      ],
      proposalsWaiting: 3,
      unbalancedProposals: 1,
      advisorDifferences: 2,
    });
    const byId = new Map(controls.map((control) => [control.id, control]));
    expect(byId.get("bank_matches_statement")).toMatchObject({ status: "failed", subjects: ["1800"], message: { key: "controls.bank_matches_statement.failed", params: { account: "1800", date: "2026-08-19", count: 1 } } });
    expect(byId.get("unbooked_bank_transactions")).toMatchObject({ status: "failed", count: 2, subjects: ["tx1", "tx2"] });
    expect(byId.get("unbooked_documents")).toMatchObject({ status: "warning", count: 1 });
    expect(byId.get("open_item_accounts")).toMatchObject({ status: "failed", count: 1, subjects: ["1462"] });
    expect(byId.get("unbalanced_entries")).toMatchObject({ status: "failed", count: 1 });
    expect(byId.get("proposals_waiting")).toMatchObject({ status: "warning", count: 3 });
    expect(byId.get("advisor_differences")).toMatchObject({ status: "warning", count: 2 });
  });

  it("is not applicable without bank accounts or open-item activity", () => {
    const controls = computeControls({ ...passing, bank: [], openItemAccounts: [] });
    expect(controls[0]!.status).toBe("not_applicable");
    expect(controls[3]!.status).toBe("not_applicable");
  });
});

describe("derivePeriodStatus", () => {
  const ok = computeControls(passing);
  const failing = computeControls({ ...passing, unbookedBankTransactionIds: ["tx"] });

  it("orders submitted > handed over > ready > in progress > open", () => {
    expect(derivePeriodStatus({ submitted: true, handover: { changesSince: 2 }, controls: failing, bookedCount: 1, proposedCount: 0 }).status).toBe("submitted");
    expect(derivePeriodStatus({ submitted: false, handover: { changesSince: 2 }, controls: failing, bookedCount: 1, proposedCount: 0 })).toMatchObject({ status: "handed_over", changesSince: 2 });
    expect(derivePeriodStatus({ submitted: false, handover: null, controls: ok, bookedCount: 5, proposedCount: 0 }).status).toBe("ready");
    expect(derivePeriodStatus({ submitted: false, handover: null, controls: failing, bookedCount: 5, proposedCount: 0 })).toMatchObject({ status: "in_progress", failingControls: ["unbooked_bank_transactions"] });
    expect(derivePeriodStatus({ submitted: false, handover: null, controls: ok, bookedCount: 0, proposedCount: 2 }).status).toBe("in_progress");
    expect(derivePeriodStatus({ submitted: false, handover: null, controls: ok, bookedCount: 0, proposedCount: 0 }).status).toBe("open");
  });

  it("does not let the tax advisor comparison hold back ready", () => {
    const withAdvisor = computeControls({ ...passing, advisorDifferences: 3 });
    expect(derivePeriodStatus({ submitted: false, handover: null, controls: withAdvisor, bookedCount: 1, proposedCount: 0 }).status).toBe("ready");
  });
});
