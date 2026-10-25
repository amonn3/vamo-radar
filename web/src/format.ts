import type { CargoClass, RiskLevel } from "../../shared/types";

const TZ = "America/New_York";

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
}

export function dur(min: number): string {
  const a = Math.abs(Math.round(min));
  return a >= 60 ? `${Math.floor(a / 60)}h${String(a % 60).padStart(2, "0")}m` : `${a}m`;
}

export function ago(now: number, at: number): string {
  const m = Math.round((now - at) / 60_000);
  if (m <= 0) return "just now";
  return `${dur(m)} ago`;
}

export function until(now: number, at: number): string {
  const m = Math.round((at - now) / 60_000);
  return m >= 0 ? `in ${dur(m)}` : `${dur(m)} ago`;
}

export const LEVEL_LABEL: Record<RiskLevel, string> = { critical: "Critical", warn: "Warning", ok: "Low" };
export const CARGO_LABEL: Record<CargoClass, string> = { frozen: "Frozen", chilled: "Chilled", ambient: "Ambient" };
