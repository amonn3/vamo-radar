import { useState, type RefObject } from "react";
import { SIGNAL_LABEL } from "../../../shared/score";
import type { CaseDetail, EventSource, ResolutionCode, Stop, StopRisk } from "../../../shared/types";
import { api } from "../api";
import { ago, CARGO_LABEL, clock, dur, LEVEL_LABEL, until } from "../format";
import { TivBar } from "./TivBar";

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<void>;

const RESOLUTIONS: Array<[ResolutionCode, string]> = [
  ["delivered_ok", "Delivered OK"],
  ["customer_notified", "Customer notified"],
  ["reassigned", "Reassigned"],
  ["redelivery_scheduled", "Redelivery scheduled"],
  ["escalated", "Escalated"],
  ["false_alarm", "False alarm"],
  ["other", "Other"],
];

interface Props {
  detail: CaseDetail;
  now: number;
  run: Run;
  onPod: (stopId: string) => void;
  resolveRef: RefObject<HTMLSelectElement | null>;
}

export function CaseView({ detail: d, now, run, onPod, resolveRef }: Props) {
  const [code, setCode] = useState<ResolutionCode | "">("");
  const resolved = d.status === "resolved";

  return (
    <section className="detail" aria-label={`Case ${d.routeCode}`}>
      <header className="detail-head">
        <div className="title-row">
          <span className={`badge ${d.level}`}>{LEVEL_LABEL[d.level]}</span>
          <h1>{d.routeCode}</h1>
          <span className="muted">{d.customers.map((c) => c.name).join(", ")} · {d.route.pickupSite}</span>
          <span className="spacer" />
          <span className="score big" title="Priority score">P {d.priority}</span>
        </div>
        <p className="why"><b>Why it's ranked here:</b> {d.reason}</p>
        <div className="head-actions">
          {resolved ? (
            <span className="pill claimed">Resolved {d.resolution ? `· ${d.resolution.code.replace(/_/g, " ")} · ${ago(now, d.resolution.at)}` : ""}</span>
          ) : d.status === "in_progress" ? (
            <>
              <span className="pill claimed">Claimed by {d.claimedBy}</span>
              <button className="ghost" onClick={() => run(() => api.release(d.id), "Released to queue")}>Release</button>
            </>
          ) : (
            <button className="primary" onClick={() => run(() => api.claim(d.id), "Case claimed")}>Claim <kbd>c</kbd></button>
          )}
          {!resolved && (
            <form
              className="resolve"
              onSubmit={(e) => {
                e.preventDefault();
                if (code) void run(() => api.resolve(d.id, code), `${d.routeCode} resolved`).then(() => setCode(""));
              }}
            >
              <select ref={resolveRef} value={code} onChange={(e) => setCode(e.target.value as ResolutionCode)} aria-label="Resolution reason">
                <option value="">Resolve with reason… (r)</option>
                {RESOLUTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <button type="submit" disabled={!code}>Resolve</button>
            </form>
          )}
        </div>
        <ul className="signals">
          {d.signals.map((s) => (
            <li key={s.key}><span className="sig-type">{SIGNAL_LABEL[s.type]}</span> {s.detail}</li>
          ))}
        </ul>
      </header>

      <div className="card">
        <div className="card-head">
          <h2>Cold chain · Time in vehicle</h2>
          <span className="muted">
            {d.route.loadedAt ? `Loaded ${clock(d.route.loadedAt)} (${ago(now, d.route.loadedAt)})` : `Pickup ${clock(d.route.scheduledPickupAt)} (${until(now, d.route.scheduledPickupAt)})`}
            {d.risk.activeBudgetMin && ` · budget ${d.risk.activeBudgetMin}m`}
          </span>
        </div>
        <TivBar risk={d.risk} />
        <RouteStrip d={d} />
        <p className="footnote">TIV is a proxy (no temperature sensors): minutes since cargo left cold storage, projected to each stop from the live ETA.</p>
      </div>

      <div className="card">
        <div className="card-head"><h2>Stops</h2><span className="muted">{d.stops.filter((s) => s.status === "delivered").length}/{d.stops.length} delivered</span></div>
        <table className="stops">
          <thead>
            <tr><th>#</th><th>Recipient / address</th><th>Cargo</th><th>Window</th><th>ETA / done</th><th>TIV at stop</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {d.stops.map((s) => (
              <StopRow key={s.id} s={s} risk={d.risk.stops.find((r) => r.stopId === s.id)} affected={d.affectedStopIds.includes(s.id)} now={now} onPod={() => onPod(s.id)} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head"><h2>Timeline</h2><span className="muted">GPS, status, alerts, SMS, calls, Slack · newest first</span></div>
        <ol className="timeline">
          {d.timeline.map((e) => (
            <li key={e.id} className={`src-${e.source}`}>
              <time>{clock(e.at)}</time>
              <span className={`src ${e.source}`}>{SOURCE_LABEL[e.source]}{e.direction === "in" ? " ←" : e.direction === "out" ? " →" : ""}</span>
              <span className="actor">{e.actor}</span>
              <span className="text">{e.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const SOURCE_LABEL: Record<EventSource, string> = {
  gps: "GPS", status: "STATUS", alert: "ALERT", sms: "SMS", call: "CALL", slack: "SLACK", operator: "OPS", system: "SYSTEM",
};

function StopRow({ s, risk, affected, now, onPod }: { s: Stop; risk?: StopRisk; affected: boolean; now: number; onPod: () => void }) {
  const late = s.eta !== null && Math.max(s.eta, now) > s.windowEnd;
  const lateDelivered = s.deliveredAt !== undefined && s.deliveredAt > s.windowEnd;
  return (
    <tr className={`${affected ? "affected" : ""} ${s.status}`}>
      <td className="seq">{s.seq}</td>
      <td>
        <div>{s.recipient} <span className="muted">· {s.orderId} · {s.bags} bag{s.bags > 1 ? "s" : ""}</span></div>
        <div className="muted small">{s.address}{s.handedTo && <b className="handed"> · handed to {s.handedTo}</b>}</div>
      </td>
      <td><span className={`cargo ${s.cargo}`}>{CARGO_LABEL[s.cargo]}</span></td>
      <td className="nowrap">{clock(s.windowStart)}–{clock(s.windowEnd)}</td>
      <td className={`nowrap ${late || lateDelivered ? "bad" : ""}`}>
        {s.deliveredAt ? `✓ ${clock(s.deliveredAt)}` : s.eta ? `${clock(Math.max(s.eta, now))}${late ? " (late)" : ""}` : "–"}
      </td>
      <td className="nowrap"><TivCell risk={risk} /></td>
      <td>
        <span className={`status ${s.status}`}>{s.status}</span>
        {s.deliveredDistanceM !== undefined && s.deliveredDistanceM > 150 && <span className="pill bad" title="GPS fix far from address">{s.deliveredDistanceM}m away</span>}
      </td>
      <td>
        {s.status === "delivered" && (
          <button className="link" onClick={onPod} title="Proof of delivery pack">{s.hasPhoto && <PhotoThumb />} POD</button>
        )}
      </td>
    </tr>
  );
}

function TivCell({ risk }: { risk?: StopRisk }) {
  if (!risk || risk.budgetMin === null) return <span className="muted">n/a</span>;
  if (risk.tivAtStopMin === null) return <span className="muted">not loaded</span>;
  const margin = risk.marginMin!;
  const cls = margin < 0 ? "critical" : risk.level === "warn" ? "warn" : risk.level === "critical" ? "critical" : "ok";
  return (
    <span className={`tiv-chip ${cls}`} title={`${Math.round(risk.tivAtStopMin)} of ${risk.budgetMin} min`}>
      {Math.round(risk.tivAtStopMin)}/{risk.budgetMin}m · {margin < 0 ? `${dur(-margin)} over` : `${dur(margin)} left`}
    </span>
  );
}

function PhotoThumb() {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden>
      <rect x="0.5" y="0.5" width="17" height="13" rx="2" fill="#1e293b" stroke="#475569" />
      <path d="M2 12 L7 6 L10 9 L12 7 L16 12 Z" fill="#64748b" />
      <circle cx="13" cy="4" r="1.6" fill="#94a3b8" />
    </svg>
  );
}

/** Pickup → stops strip with the driver's last known position. Deliberately not a map. */
function RouteStrip({ d }: { d: CaseDetail }) {
  const pos = d.route.position;
  const lastPing = d.route.lastPingAt;
  const driverLabel = `${d.driver?.name.split(" ")[0] ?? "Driver"}${lastPing ? ` · ping ${clock(lastPing)}` : ""}`;
  const marker = <span className="driver-marker" title={driverLabel}>▲<span>{driverLabel}</span></span>;

  return (
    <div className="strip" aria-label="Route progress">
      <div className="node pickup">
        <span className="dot">P</span>
        <span className="lbl">Pickup</span>
        {pos.kind === "pickup" && marker}
      </div>
      {d.stops.map((s) => {
        const risk = d.risk.stops.find((r) => r.stopId === s.id);
        const tone = s.status === "delivered" ? (risk?.marginMin != null && risk.marginMin < 0 ? "critical" : "done") : risk?.level ?? "ok";
        return (
          <div key={s.id} className="seg-wrap">
            <div className="seg">
              {pos.kind === "enroute" && pos.toStopId === s.id && <span className="on-seg" style={{ left: `${pos.progress * 100}%` }}>{marker}</span>}
            </div>
            <div className={`node ${tone} ${s.status}`}>
              <span className="dot">{s.status === "delivered" ? "✓" : s.seq}</span>
              <span className="lbl">{CARGO_LABEL[s.cargo].slice(0, 1)} · {s.eta ? clock(s.eta) : s.deliveredAt ? clock(s.deliveredAt) : ""}</span>
              {pos.kind === "at_stop" && pos.stopId === s.id && marker}
            </div>
          </div>
        );
      })}
    </div>
  );
}
