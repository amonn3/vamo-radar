import { useEffect, useState, type ReactNode } from "react";
import { api, type PodPack } from "../api";
import { CARGO_LABEL, clock, dur } from "../format";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="card-head"><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="Close">Esc</button></div>
        {children}
      </div>
    </div>
  );
}

function useLoad<T>(load: () => Promise<T>): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load().then(setData, (e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);
  return { data, error };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="primary" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function podText(p: PodPack): string {
  return [
    `Proof of delivery · ${p.orderId} (${p.customer})`,
    `Delivered ${clock(p.deliveredAt)} ET to ${p.recipient}, ${p.address}`,
    `Booked window ${clock(p.window.start)}–${clock(p.window.end)}: ${p.inWindow ? "on time" : "outside window"}`,
    `GPS fix ${p.distanceM ?? "?"}m from address${p.distanceOk ? "" : " (flagged: far from address)"}`,
    p.tiv.budgetMin !== null && p.tiv.atDeliveryMin !== null
      ? `Cold chain: ${Math.round(p.tiv.atDeliveryMin)} min in vehicle vs ${p.tiv.budgetMin} min ${p.cargo} budget (${p.tiv.withinBudget ? "within budget" : "over budget"})`
      : `Cold chain: ${p.cargo} cargo, no TIV budget`,
    `Driver: ${p.driver} · Photo: ${p.photo ? "attached" : "none"}`,
  ].join("\n");
}

export function PodModal({ stopId, onClose }: { stopId: string; onClose: () => void }) {
  const { data: p, error } = useLoad(() => api.pod(stopId));
  return (
    <Modal title="Proof of delivery pack" onClose={onClose}>
      {error && <p className="bad">{error}</p>}
      {!p && !error && <p className="muted">Loading…</p>}
      {p && (
        <>
          <div className="pod">
            <div className="pod-photo" aria-label="Delivery photo (mock)">
              <svg viewBox="0 0 160 110" width="160" height="110" aria-hidden>
                <rect width="160" height="110" rx="6" fill="#1e293b" />
                <rect x="55" y="30" width="50" height="45" rx="3" fill="#334155" stroke="#64748b" />
                <path d="M55 45 H105" stroke="#64748b" />
                <text x="80" y="98" fill="#94a3b8" fontSize="10" textAnchor="middle">{clock(p.deliveredAt)} · door photo</text>
              </svg>
            </div>
            <dl>
              <dt>Order</dt><dd>{p.orderId} · {p.customer} · {p.routeCode}</dd>
              <dt>Recipient</dt><dd>{p.recipient}, {p.address}</dd>
              <dt>Delivered</dt><dd>{clock(p.deliveredAt)} ET by {p.driver}</dd>
              <dt>Window</dt><dd className={p.inWindow ? "good" : "bad"}>{clock(p.window.start)}–{clock(p.window.end)} · {p.inWindow ? "on time" : "outside window"}</dd>
              <dt>Location</dt><dd className={p.distanceOk ? "good" : "bad"}>{p.distanceM ?? "?"}m from address{p.distanceOk ? "" : " · do not use as proof without driver confirmation"}</dd>
              <dt>Cold chain</dt>
              <dd className={p.tiv.withinBudget ? "good" : "bad"}>
                {p.tiv.budgetMin !== null && p.tiv.atDeliveryMin !== null
                  ? `${CARGO_LABEL[p.cargo as keyof typeof CARGO_LABEL]}: ${dur(p.tiv.atDeliveryMin)} in vehicle of ${p.tiv.budgetMin}m budget${p.tiv.loadedAt ? ` (loaded ${clock(p.tiv.loadedAt)})` : ""}`
                  : "Ambient, no TIV budget"}
              </dd>
            </dl>
          </div>
          <pre className="copyable">{podText(p)}</pre>
          <div className="row buttons"><CopyButton text={podText(p)} /><span className="muted small">Share link is out of scope; copy goes to clipboard.</span></div>
        </>
      )}
    </Modal>
  );
}

export function HandoffModal({ onClose }: { onClose: () => void }) {
  const { data, error } = useLoad(() => api.handoff());
  return (
    <Modal title="Shift handoff summary" onClose={onClose}>
      {error && <p className="bad">{error}</p>}
      {!data && !error && <p className="muted">Building summary…</p>}
      {data && (
        <>
          <pre className="copyable">{data.text}</pre>
          <div className="row buttons"><CopyButton text={data.text} /><span className="muted small">Paste into #ops-handoff for the next shift (US / PH / LatAm).</span></div>
        </>
      )}
    </Modal>
  );
}
