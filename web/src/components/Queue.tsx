import { useEffect, useRef, type RefObject } from "react";
import { CATEGORY_LABEL } from "../../../shared/labels";
import { SIGNAL_LABEL } from "../../../shared/score";
import type { CaseSummary, SignalType } from "../../../shared/types";
import type { CaseList, Filters } from "../api";
import { ago, CARGO_LABEL, LEVEL_LABEL } from "../format";
import { TivBar } from "./TivBar";

const TYPE_OPTIONS: SignalType[] = [
  "tiv_projected", "tiv_current", "tiv_breached", "driver_quiet", "driver_stalled", "unassigned", "driver_cancelled",
  "late_pickup", "eta_past_window", "far_delivery", "inbound",
];

interface Props {
  list: CaseList | null;
  filters: Filters;
  onFilters: (f: Filters) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number;
  searchRef: RefObject<HTMLInputElement | null>;
}

export function Queue({ list, filters, onFilters, selectedId, onSelect, now, searchRef }: Props) {
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const statusTabs: Array<[Filters["status"], string, number | undefined]> = [
    ["active", "Active", list ? list.counts.open + list.counts.in_progress : undefined],
    ["open", "Unclaimed", list?.counts.open],
    ["in_progress", "Claimed", list?.counts.in_progress],
    ["resolved", "Resolved", list?.counts.resolved],
  ];

  return (
    <aside className="queue" aria-label="Case queue">
      <div className="queue-controls">
        <input
          ref={searchRef}
          type="search"
          placeholder="Search route, driver, customer, order  ( / )"
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
        />
        <div className="tabs" role="tablist">
          {statusTabs.map(([value, label, n]) => (
            <button key={value} role="tab" aria-selected={filters.status === value} className={filters.status === value ? "active" : ""} onClick={() => set({ status: value })}>
              {label} {n !== undefined && <span className="count">{n}</span>}
            </button>
          ))}
        </div>
        <div className="selects">
          <select value={filters.cargo} onChange={(e) => set({ cargo: e.target.value })} aria-label="Cargo class">
            <option value="">All cargo</option>
            <option value="frozen">Frozen</option>
            <option value="chilled">Chilled</option>
            <option value="ambient">Ambient</option>
          </select>
          <select value={filters.type} onChange={(e) => set({ type: e.target.value })} aria-label="Case type">
            <option value="">All case types</option>
            {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{SIGNAL_LABEL[t]}</option>)}
          </select>
        </div>
      </div>

      <ol className="queue-list">
        {list === null && <li className="queue-empty">Loading…</li>}
        {list?.cases.length === 0 && <li className="queue-empty">No cases match these filters.</li>}
        {list?.cases.map((c, i) => (
          <QueueItem key={c.id} c={c} rank={i + 1} now={now} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
        ))}
      </ol>
    </aside>
  );
}

function QueueItem({ c, rank, now, selected, onSelect }: { c: CaseSummary; rank: number; now: number; selected: boolean; onSelect: () => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const extra = c.signals.length - 1;
  const primary = c.signals.find((s) => s.type === c.primaryType);
  const title = primary?.messageCategory ? CATEGORY_LABEL[primary.messageCategory] : SIGNAL_LABEL[c.primaryType];
  return (
    <li ref={ref} className={`case-item level-${c.level} ${selected ? "selected" : ""} ${c.status}`} onClick={onSelect} aria-current={selected}>
      <div className="row">
        <span className={`badge ${c.level}`}>{LEVEL_LABEL[c.level]}</span>
        <span className="case-title">
          <b>{c.routeCode}</b> · {title}
          {extra > 0 && <span className="muted"> +{extra}</span>}
        </span>
        <span className="score" title="Priority score: urgency × cargo weight × at-risk stops × staleness">#{rank} · {c.priority}</span>
      </div>
      <div className="row meta">
        <span>{c.customerNames.join(", ")}</span>
        <span>·</span>
        <span>{c.driverName ?? <em>no driver</em>}</span>
        <span className={`cargo ${c.cargo}`}>{CARGO_LABEL[c.cargo]}</span>
      </div>
      <TivBar risk={c.risk} compact />
      <p className="reason" title={c.reason}>{c.reason}</p>
      <div className="row meta small">
        <span>{c.affectedStopIds.length} stop{c.affectedStopIds.length === 1 ? "" : "s"} affected</span>
        {c.pendingMessages > 0 && <span className="pill msg">{c.pendingMessages} msg awaiting reply</span>}
        {c.claimedBy ? <span className="pill claimed">{c.status === "resolved" ? "resolved" : `claimed · ${c.claimedBy}`}</span> : <span className="muted">opened {ago(now, c.openedAt)}</span>}
      </div>
    </li>
  );
}
