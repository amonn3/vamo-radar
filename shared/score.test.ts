import { describe, expect, it } from "vitest";
import { scoreCase, stalenessFactor, tivUrgency } from "./score";
import { MINUTE } from "./tiv";
import type { RouteRisk, Signal } from "./types";

const NOW = Date.parse("2026-10-23T19:30:00Z");

const risk = (worstMarginMin: number | null, atRisk: number, currentLevel: RouteRisk["currentLevel"] = "ok"): RouteRisk => ({
  elapsedMin: 20, activeBudgetMin: 60, usedPct: 0.3, minutesToBreach: 40, currentLevel, stops: [],
  worstMarginMin, worstStopId: null, atRiskStopIds: Array.from({ length: atRisk }, (_, i) => `s${i}`),
});

const signal = (type: Signal["type"], urgency = 0): Signal => ({ type, key: type, stopIds: [], detail: `${type} detail`, urgency });

describe("tivUrgency", () => {
  it("rises as margin shrinks and keeps rising past a breach", () => {
    expect(tivUrgency(30)).toBeLessThan(tivUrgency(10));
    expect(tivUrgency(10)).toBeLessThan(tivUrgency(0));
    expect(tivUrgency(0)).toBe(10);
    expect(tivUrgency(-12)).toBeGreaterThan(10);
  });
});

describe("stalenessFactor", () => {
  it("grows with time since last touch and caps at 2x", () => {
    expect(stalenessFactor(0)).toBe(1);
    expect(stalenessFactor(60)).toBe(1.5);
    expect(stalenessFactor(600)).toBe(2);
  });
});

describe("scoreCase", () => {
  const base = { openedAt: NOW, lastTouchedAt: null, now: NOW };

  it("ranks a projected frozen breach above an ambient where's-my-order", () => {
    const cold = scoreCase({ ...base, signals: [signal("tiv_projected")], risk: risk(-6, 1), cargo: "frozen" });
    const wismo = scoreCase({ ...base, signals: [signal("inbound", 3)], risk: risk(null, 0), cargo: "ambient" });
    expect(cold.priority).toBeGreaterThan(wismo.priority * 4);
    expect(wismo.level).toBe("ok");
    expect(wismo.reason).toContain("ambient cargo");
  });

  it("multiplies by the number of at-risk perishable stops", () => {
    const one = scoreCase({ ...base, signals: [signal("tiv_current")], risk: risk(10, 1), cargo: "chilled" });
    const three = scoreCase({ ...base, signals: [signal("tiv_current")], risk: risk(10, 3), cargo: "chilled" });
    expect(three.priority).toBeGreaterThan(one.priority);
    expect(three.reason).toContain("3 sensitive stops at risk");
  });

  it("lets untouched cases climb and resets on touch", () => {
    const input = { signals: [signal("driver_stalled", 5)], risk: risk(null, 0), cargo: "chilled" as const, openedAt: NOW - 60 * MINUTE, now: NOW };
    const untouched = scoreCase({ ...input, lastTouchedAt: null });
    const touched = scoreCase({ ...input, lastTouchedAt: NOW });
    expect(untouched.priority).toBeGreaterThan(touched.priority);
    expect(untouched.reason).toContain("untouched 1h00m");
  });

  it("never shows a critical TIV route below critical", () => {
    const r = scoreCase({ ...base, signals: [signal("far_delivery", 1)], risk: risk(20, 0, "critical"), cargo: "ambient" });
    expect(r.level).toBe("critical");
  });

  it("picks the most urgent signal as the primary reason", () => {
    const r = scoreCase({ ...base, signals: [signal("far_delivery", 4), signal("tiv_projected")], risk: risk(-5, 1), cargo: "frozen" });
    expect(r.primary.type).toBe("tiv_projected");
  });
});
