import type { RouteRisk } from "../../../shared/types";
import { dur } from "../format";

/** Fill = TIV already used of the tightest budget aboard; tick = projected TIV at the worst stop. */
export function TivBar({ risk, compact = false }: { risk: RouteRisk; compact?: boolean }) {
  if (risk.usedPct === null || risk.activeBudgetMin === null) {
    const label = risk.elapsedMin === null ? "Cargo not loaded" : "No TIV budget (ambient)";
    return <div className={`tiv ${compact ? "compact" : ""}`}><span className="tiv-text muted">{label}</span></div>;
  }
  const used = Math.min(risk.usedPct, 1.25);
  const worst = risk.stops.find((s) => s.stopId === risk.worstStopId);
  const projectedPct = worst?.tivAtStopMin != null && worst.budgetMin ? Math.min(worst.tivAtStopMin / worst.budgetMin, 1.25) : null;
  const tone = risk.usedPct >= 0.9 ? "critical" : risk.usedPct >= 0.7 ? "warn" : projectedPct !== null && projectedPct > 1 ? "warn" : "ok";
  const breach = risk.minutesToBreach!;
  const text =
    breach > 0 ? `${Math.round(risk.usedPct * 100)}% used · breaches in ${dur(breach)}` : `${Math.round(risk.usedPct * 100)}% used · over by ${dur(breach)}`;
  const proj = risk.worstMarginMin !== null && risk.worstMarginMin < 0 ? `proj. ${dur(-risk.worstMarginMin)} over` : null;

  return (
    <div className={`tiv ${compact ? "compact" : ""}`} aria-label={`Time in vehicle: ${text}${proj ? `, ${proj}` : ""}`}>
      <div className="tiv-track">
        <div className={`tiv-fill ${tone}`} style={{ width: `${(used / 1.25) * 100}%` }} />
        <div className="tiv-budget" style={{ left: `${(1 / 1.25) * 100}%` }} title={`Budget ${risk.activeBudgetMin}m`} />
        {projectedPct !== null && <div className="tiv-proj" style={{ left: `${(projectedPct / 1.25) * 100}%` }} title="Projected TIV at the most exposed stop" />}
      </div>
      <span className="tiv-text">
        {text}
        {proj && <b className="proj"> · {proj}</b>}
      </span>
    </div>
  );
}
