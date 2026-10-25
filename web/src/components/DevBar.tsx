import type { CaseStatus } from "../../../shared/types";
import { clock as fmtClock } from "../format";

interface Props {
  clock: { now: number; aiEnabled: boolean } | null;
  busy: boolean;
  counts?: Record<CaseStatus, number>;
  critical: number;
  onAdvance: () => void;
  onMessage: () => void;
  onReset: () => void;
  onHandoff: () => void;
}

export function DevBar({ clock, busy, counts, critical, onAdvance, onMessage, onReset, onHandoff }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden>◉</span>
        <strong>Vamo Radar</strong>
        <span className="muted">Miami ops</span>
      </div>
      <div className="stats" aria-label="Queue summary">
        <span className="stat critical"><b>{critical}</b> critical</span>
        <span className="stat"><b>{counts?.open ?? "–"}</b> unclaimed</span>
        <span className="stat"><b>{counts?.in_progress ?? "–"}</b> in progress</span>
        <span className="stat muted"><b>{counts?.resolved ?? "–"}</b> resolved</span>
        <button className="ghost" onClick={onHandoff}>Shift handoff</button>
      </div>
      <div className="devbar" aria-label="Simulation controls">
        <span className="sim-clock" title="Simulated clock, Eastern Time">
          <span className="muted">SIM</span> {clock ? fmtClock(clock.now) : "--:--"} <span className="muted">ET</span>
        </span>
        <span className={`engine ${clock?.aiEnabled ? "ai" : "rules"}`} title={clock?.aiEnabled ? "Triage uses the LLM, with rules fallback" : "No ANTHROPIC_API_KEY: triage uses deterministic rules"}>
          {clock?.aiEnabled ? "AI triage" : "Rules triage"}
        </span>
        <button onClick={onAdvance} disabled={busy} title="Shortcut: t">Advance 30 min</button>
        <button onClick={onMessage} disabled={busy} title="Shortcut: m">Simulate message</button>
        <button className="ghost" onClick={onReset} disabled={busy}>Reset</button>
      </div>
    </header>
  );
}
