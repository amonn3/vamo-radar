import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseDetail } from "../../shared/types";
import { api, type CaseList, type ClockInfo, type Filters } from "./api";
import { CaseView } from "./components/CaseView";
import { DevBar } from "./components/DevBar";
import { HandoffModal, PodModal } from "./components/Modals";
import { Queue } from "./components/Queue";
import { SidePanel } from "./components/SidePanel";

const POLL_MS = 3000;

export function App() {
  const [clock, setClock] = useState<ClockInfo | null>(null);
  const [filters, setFilters] = useState<Filters>({ status: "active", cargo: "", type: "", q: "" });
  const [list, setList] = useState<CaseList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [podStopId, setPodStopId] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const resolveRef = useRef<HTMLSelectElement>(null);
  const approveRef = useRef<() => void>(() => {});

  const refresh = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([api.clock(), api.cases(filters)]);
      setClock(c);
      setList(l);
      setError(null);
      // Keep the operator's selection (even once resolved); default to the top of the queue.
      setSelectedId((cur) => cur ?? l.cases[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot reach the Radar API");
    }
  }, [filters]);

  const detailIdRef = useRef<string | null>(null);
  const loadDetail = useCallback(async (id: string | null) => {
    detailIdRef.current = id;
    if (!id) return setDetail(null);
    try {
      const d = await api.case(id);
      if (detailIdRef.current === id) setDetail(d);
    } catch {
      if (detailIdRef.current === id) setDetail(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    void loadDetail(selectedId);
  }, [selectedId, loadDetail, list]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  };

  /** Runs a mutation, then refreshes queue and detail. */
  const run = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      setBusy(true);
      try {
        await fn();
        if (success) flash(success);
      } catch (e) {
        flash(e instanceof Error ? e.message : "Something went wrong");
      } finally {
        setBusy(false);
        await refresh();
        await loadDetail(detailIdRef.current);
      }
    },
    [refresh, loadDetail],
  );

  const cases = list?.cases ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches("input, textarea, select")) {
        if (e.key === "Escape") target.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = cases.findIndex((c) => c.id === selectedId);
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const next = cases[Math.min(idx + 1, cases.length - 1)];
        if (next) setSelectedId(next.id);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const prev = cases[Math.max(idx - 1, 0)];
        if (prev) setSelectedId(prev.id);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "c" && selectedId) {
        void run(() => api.claim(selectedId), "Case claimed");
      } else if (e.key === "a") {
        approveRef.current();
      } else if (e.key === "r") {
        resolveRef.current?.focus();
      } else if (e.key === "t") {
        void run(() => api.advance(30), "Clock advanced 30 min");
      } else if (e.key === "m") {
        void run(() => api.simulateMessage(), "Inbound message received and triaged");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cases, selectedId, run]);

  return (
    <div className="app">
      <DevBar
        clock={clock}
        busy={busy}
        counts={list?.counts}
        critical={cases.filter((c) => c.level === "critical" && c.status !== "resolved").length}
        onAdvance={() => run(() => api.advance(30), "Clock advanced 30 min")}
        onMessage={() => run(() => api.simulateMessage(), "Inbound message received and triaged")}
        onReset={() => run(() => api.reset(), "Demo reset to seed")}
        onHandoff={() => setHandoffOpen(true)}
      />
      {error && <div className="banner error" role="alert">API unreachable: {error}. Is the server running on :8787?</div>}
      <main className="layout">
        <Queue
          list={list}
          filters={filters}
          onFilters={setFilters}
          selectedId={selectedId}
          onSelect={setSelectedId}
          now={clock?.now ?? 0}
          searchRef={searchRef}
        />
        {detail && clock ? (
          <>
            <CaseView detail={detail} now={clock.now} run={run} onPod={setPodStopId} resolveRef={resolveRef} />
            <SidePanel detail={detail} now={clock.now} run={run} approveRef={approveRef} />
          </>
        ) : (
          <section className="empty-detail">
            {list === null ? <p>Loading cases…</p> : cases.length === 0 ? <p>Nothing needs you right now. Radar is watching every active route.</p> : <p>Select a case.</p>}
          </section>
        )}
      </main>
      <footer className="keys">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>c</kbd> claim</span>
        <span><kbd>a</kbd> approve draft</span>
        <span><kbd>r</kbd> resolve</span>
        <span><kbd>/</kbd> search</span>
        <span className="dev"><kbd>t</kbd> +30 min</span>
        <span className="dev"><kbd>m</kbd> simulate message</span>
      </footer>
      {toast && <div className="toast" role="status">{toast}</div>}
      {podStopId && clock && <PodModal stopId={podStopId} onClose={() => setPodStopId(null)} />}
      {handoffOpen && <HandoffModal onClose={() => setHandoffOpen(false)} />}
    </div>
  );
}
