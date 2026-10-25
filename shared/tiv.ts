// Time-in-Vehicle model. There is no temperature telemetry at Vamo, so cold-chain risk is
// inferred from how long cargo has been out of cold storage versus a per-cargo budget.
// This is a proxy (no door-open events, vehicle climate or insulated-bag data), so the
// default budgets are deliberately conservative.
import type { CargoClass, Customer, RiskLevel, Route, RouteRisk, Stop, StopRisk } from "./types";

export const MINUTE = 60_000;

export const DEFAULT_TIV_BUDGET_MIN: Record<CargoClass, number | null> = {
  frozen: 60,
  chilled: 90,
  ambient: null, // window-only risk
};

export const WARN_PCT = 0.7;
export const CRITICAL_PCT = 0.9;

const LEVEL_RANK: Record<RiskLevel, number> = { ok: 0, warn: 1, critical: 2 };
export const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);
export const levelRank = (l: RiskLevel): number => LEVEL_RANK[l];

export function budgetFor(cargo: CargoClass, customer?: Customer): number | null {
  const override = customer?.tivBudgets?.[cargo];
  return override ?? DEFAULT_TIV_BUDGET_MIN[cargo];
}

export function levelForUsage(usedPct: number): RiskLevel {
  if (usedPct >= CRITICAL_PCT) return "critical";
  if (usedPct >= WARN_PCT) return "warn";
  return "ok";
}

export function tivElapsedMin(route: Route, now: number): number | null {
  if (route.loadedAt === null) return null;
  return Math.max(0, (now - route.loadedAt) / MINUTE);
}

function isPending(stop: Stop): boolean {
  return stop.status === "pending" || stop.status === "arrived";
}

/** TIV at the moment this stop is (or will be) handed over. */
export function tivAtStopMin(route: Route, stop: Stop, now: number): number | null {
  if (route.loadedAt === null) return null;
  if (stop.deliveredAt !== undefined) return (stop.deliveredAt - route.loadedAt) / MINUTE;
  // An ETA in the past means the driver is late and the app has not caught up; never project below now.
  const handover = Math.max(stop.eta ?? now, now);
  return (handover - route.loadedAt) / MINUTE;
}

export function assessStop(route: Route, stop: Stop, now: number, customer?: Customer): StopRisk {
  const budget = budgetFor(stop.cargo, customer);
  const tiv = tivAtStopMin(route, stop, now);
  if (budget === null || tiv === null) {
    return { stopId: stop.id, cargo: stop.cargo, budgetMin: budget, tivAtStopMin: tiv, marginMin: null, level: "ok", projectedBreach: false };
  }
  const margin = budget - tiv;
  if (!isPending(stop)) {
    const level: RiskLevel = margin < 0 ? "critical" : "ok";
    return { stopId: stop.id, cargo: stop.cargo, budgetMin: budget, tivAtStopMin: tiv, marginMin: margin, level, projectedBreach: false };
  }
  const elapsed = tivElapsedMin(route, now) ?? 0;
  const current = levelForUsage(elapsed / budget);
  const projectedBreach = margin < 0;
  // A projected breach is at least a warning even if the cargo is fine right now: that is
  // the window in which ops can still reorder, reassign or warn the customer.
  const level = projectedBreach ? maxLevel(current, "warn") : current;
  return { stopId: stop.id, cargo: stop.cargo, budgetMin: budget, tivAtStopMin: tiv, marginMin: margin, level, projectedBreach };
}

export function assessRoute(route: Route, stops: Stop[], now: number, customers: Map<string, Customer>): RouteRisk {
  const stopRisks = stops.map((s) => assessStop(route, s, now, customers.get(s.customerId)));
  const elapsed = tivElapsedMin(route, now);
  const pendingSensitive = stopRisks.filter((r, i) => r.budgetMin !== null && isPending(stops[i]!));

  const activeBudget = pendingSensitive.length ? Math.min(...pendingSensitive.map((r) => r.budgetMin!)) : null;
  const usedPct = elapsed !== null && activeBudget !== null ? elapsed / activeBudget : null;
  const currentLevel = usedPct === null ? "ok" : levelForUsage(usedPct);

  let worstMargin: number | null = null;
  let worstStopId: string | null = null;
  for (const r of pendingSensitive) {
    if (r.marginMin !== null && (worstMargin === null || r.marginMin < worstMargin)) {
      worstMargin = r.marginMin;
      worstStopId = r.stopId;
    }
  }

  return {
    elapsedMin: elapsed,
    activeBudgetMin: activeBudget,
    usedPct,
    minutesToBreach: elapsed !== null && activeBudget !== null ? activeBudget - elapsed : null,
    currentLevel,
    stops: stopRisks,
    worstMarginMin: worstMargin,
    worstStopId,
    atRiskStopIds: pendingSensitive.filter((r) => r.level !== "ok").map((r) => r.stopId),
  };
}
