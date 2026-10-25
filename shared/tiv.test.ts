import { describe, expect, it } from "vitest";
import { assessRoute, assessStop, budgetFor, levelForUsage, MINUTE, tivElapsedMin } from "./tiv";
import type { CargoClass, Customer, Route, Stop } from "./types";

const NOW = Date.parse("2026-10-23T19:30:00Z");
const at = (min: number) => NOW + min * MINUTE;

const route = (loadedMin: number | null): Route => ({
  id: "r", code: "R", driverId: "d", pickupSite: "x", scheduledPickupAt: at(-30), loadedAt: loadedMin === null ? null : at(loadedMin),
  status: "in_progress", stopIds: [], position: { kind: "none" }, lastPingAt: NOW, lastMovedAt: NOW, lastDriverMessageAt: null, sim: "normal",
});

const stop = (id: string, cargo: CargoClass, etaMin: number, extra: Partial<Stop> = {}): Stop => ({
  id, routeId: "r", seq: 1, orderId: "FF-1", customerId: "c", recipient: "x", recipientPhone: "x", address: "x", cargo, bags: 1,
  windowStart: at(-60), windowEnd: at(120), eta: at(etaMin), status: "pending", ...extra,
});

describe("budgets", () => {
  it("uses defaults per cargo class and per-customer overrides", () => {
    expect(budgetFor("frozen")).toBe(60);
    expect(budgetFor("chilled")).toBe(90);
    expect(budgetFor("ambient")).toBeNull();
    const strict: Customer = { id: "c", name: "PrepPal", kind: "meal-prep", tivBudgets: { frozen: 50 } };
    expect(budgetFor("frozen", strict)).toBe(50);
    expect(budgetFor("chilled", strict)).toBe(90);
  });

  it("maps usage to levels at 70% and 90%", () => {
    expect(levelForUsage(0.69)).toBe("ok");
    expect(levelForUsage(0.7)).toBe("warn");
    expect(levelForUsage(0.9)).toBe("critical");
  });
});

describe("assessStop", () => {
  it("flags a projected breach while current usage is still fine", () => {
    const r = assessStop(route(-22), stop("s5", "frozen", 44), NOW);
    expect(r.tivAtStopMin).toBe(66);
    expect(r.marginMin).toBe(-6);
    expect(r.projectedBreach).toBe(true);
    expect(r.level).toBe("warn"); // 22/60 used is ok, but the projection lifts it
  });

  it("reports current risk from elapsed time", () => {
    expect(assessStop(route(-55), stop("s", "frozen", 1), NOW).level).toBe("critical"); // 92%
    expect(assessStop(route(-45), stop("s", "frozen", 1), NOW).level).toBe("warn"); // 75%
    expect(assessStop(route(-20), stop("s", "frozen", 10), NOW).level).toBe("ok");
  });

  it("never projects a stale ETA earlier than now", () => {
    const r = assessStop(route(-40), stop("s", "chilled", -10), NOW);
    expect(r.tivAtStopMin).toBe(40);
  });

  it("has no TIV risk for ambient cargo", () => {
    const r = assessStop(route(-200), stop("s", "ambient", 30), NOW);
    expect(r.budgetMin).toBeNull();
    expect(r.level).toBe("ok");
  });

  it("uses actual hand-over time for delivered stops", () => {
    const r = assessStop(route(-80), stop("s", "frozen", 0, { status: "delivered", eta: null, deliveredAt: at(-10) }), NOW);
    expect(r.tivAtStopMin).toBe(70);
    expect(r.level).toBe("critical");
    expect(r.projectedBreach).toBe(false);
  });

  it("has no TIV before cargo is loaded", () => {
    expect(tivElapsedMin(route(null), NOW)).toBeNull();
    expect(assessStop(route(null), stop("s", "frozen", 30), NOW).marginMin).toBeNull();
  });
});

describe("assessRoute", () => {
  it("computes per-stop risk and finds the most exposed stop", () => {
    const stops = [
      stop("s1", "frozen", 5, { seq: 1 }),
      stop("s2", "chilled", 20, { seq: 2 }),
      stop("s3", "frozen", 44, { seq: 3 }),
    ];
    const risk = assessRoute(route(-22), stops, NOW, new Map());
    expect(risk.elapsedMin).toBe(22);
    expect(risk.activeBudgetMin).toBe(60);
    expect(risk.minutesToBreach).toBe(38);
    expect(risk.worstStopId).toBe("s3");
    expect(risk.worstMarginMin).toBe(-6);
    expect(risk.atRiskStopIds).toEqual(["s3"]);
  });

  it("only counts budgets of cargo still aboard", () => {
    const stops = [
      stop("s1", "frozen", 0, { status: "delivered", eta: null, deliveredAt: at(-30) }),
      stop("s2", "chilled", 10),
    ];
    const risk = assessRoute(route(-50), stops, NOW, new Map());
    expect(risk.activeBudgetMin).toBe(90);
    expect(risk.currentLevel).toBe("ok");
  });
});
