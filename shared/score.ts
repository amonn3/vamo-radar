// Queue priority. Kept multiplicative and small so every rank can be explained in one line:
//   priority = urgency x cargo weight x (1 + 0.25 per at-risk sensitive stop) x staleness
import { fmtMin } from "./detect";
import { MINUTE, levelRank, maxLevel } from "./tiv";
import type { CargoClass, RiskLevel, RouteRisk, Signal, SignalType } from "./types";

export const CARGO_WEIGHT: Record<CargoClass, number> = { frozen: 1, chilled: 0.9, ambient: 0.4 };

/** Inverse of TIV margin on a 0-15 scale: 10 at zero margin, halves every 10 minutes of slack, >10 once breached. */
export function tivUrgency(marginMin: number): number {
  if (marginMin <= 0) return 10 + Math.min(-marginMin, 30) / 6;
  return 10 / (1 + marginMin / 10);
}

/** Untouched cases climb slowly: +50% per hour without an operator touch, capped at 2x. */
export function stalenessFactor(sinceMin: number): number {
  return 1 + Math.min(Math.max(sinceMin, 0) / 120, 1);
}

export const SIGNAL_LABEL: Record<SignalType, string> = {
  tiv_current: "TIV running out",
  tiv_projected: "Projected TIV breach",
  tiv_breached: "Delivered over TIV",
  driver_stalled: "Driver stalled",
  driver_quiet: "Driver quiet",
  late_pickup: "Late pickup",
  unassigned: "Unassigned route",
  eta_past_window: "Late vs window",
  far_delivery: "Delivered far from address",
  driver_cancelled: "Driver cancelled",
  inbound: "Inbound message",
};

export interface ScoreInput {
  signals: Signal[];
  risk: RouteRisk;
  cargo: CargoClass;
  openedAt: number;
  lastTouchedAt: number | null;
  now: number;
}

export interface ScoreResult {
  priority: number;
  level: RiskLevel;
  primary: Signal;
  reason: string;
}

function signalUrgency(s: Signal, risk: RouteRisk): number {
  if ((s.type === "tiv_current" || s.type === "tiv_projected") && risk.worstMarginMin !== null) {
    return tivUrgency(risk.worstMarginMin);
  }
  return s.urgency;
}

export function scoreCase(input: ScoreInput): ScoreResult {
  const { signals, risk, cargo, now } = input;
  if (signals.length === 0) throw new Error("scoreCase requires at least one signal");

  const ranked = [...signals].sort((a, b) => signalUrgency(b, risk) - signalUrgency(a, risk));
  const primary = ranked[0]!;
  const urgency = signalUrgency(primary, risk);

  // Only perishable stops multiply priority; ambient work still shows up, just lower.
  const atRisk = risk.atRiskStopIds.length;
  const stopsFactor = 1 + 0.25 * atRisk;
  const sinceTouch = (now - (input.lastTouchedAt ?? input.openedAt)) / MINUTE;
  const staleness = stalenessFactor(sinceTouch);
  const priority = Math.round(urgency * CARGO_WEIGHT[cargo] * stopsFactor * staleness * 10);

  let level: RiskLevel = priority >= 120 ? "critical" : priority >= 50 ? "warn" : "ok";
  // Never show a breaching cold-chain case as less than its TIV level.
  level = maxLevel(level, risk.currentLevel);
  if (risk.worstMarginMin !== null && risk.worstMarginMin < 0) level = maxLevel(level, "warn");

  const parts = [primary.detail];
  if (atRisk > 0) parts.push(`${atRisk} ${cargoLabel(risk)} stop${atRisk > 1 ? "s" : ""} at risk`);
  else if (cargo === "ambient") parts.push("ambient cargo, no TIV risk");
  if (sinceTouch >= 15) parts.push(input.lastTouchedAt === null ? `untouched ${fmtMin(sinceTouch)}` : `last touched ${fmtMin(sinceTouch)} ago`);

  return { priority, level, primary, reason: parts.join(" · ") };
}

function cargoLabel(risk: RouteRisk): string {
  const classes = new Set(risk.stops.filter((s) => risk.atRiskStopIds.includes(s.stopId)).map((s) => s.cargo));
  return classes.size === 1 ? [...classes][0]! : "sensitive";
}

export const compareLevel = (a: RiskLevel, b: RiskLevel) => levelRank(b) - levelRank(a);
