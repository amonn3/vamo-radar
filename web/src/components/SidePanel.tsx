import { useEffect, useState, type RefObject } from "react";
import { CATEGORY_LABEL } from "../../../shared/labels";
import type { CaseDetail, InboundMessage, SuggestedAction } from "../../../shared/types";
import { api } from "../api";
import { ago } from "../format";

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<void>;

interface Props {
  detail: CaseDetail;
  now: number;
  run: Run;
  approveRef: RefObject<() => void>;
}

export function SidePanel({ detail: d, now, run, approveRef }: Props) {
  const pending = d.messages.filter((m) => m.status === "pending");
  const handled = d.messages.filter((m) => m.status !== "pending");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftOf = (m: InboundMessage) => drafts[m.id] ?? m.triage?.draft.text ?? "";

  // Keyboard "a" approves the top pending draft as currently edited.
  useEffect(() => {
    const first = pending[0];
    approveRef.current = first?.triage
      ? () => void run(() => api.sendReply(first.id, draftOf(first)), `Reply sent to ${first.triage!.draft.to}`)
      : () => {};
  });

  return (
    <aside className="side" aria-label="Triage and actions">
      <section className="card">
        <div className="card-head">
          <h2>Inbound triage</h2>
          <span className="muted">{pending.length ? `${pending.length} awaiting approval` : "nothing waiting"}</span>
        </div>
        {pending.length === 0 && <p className="muted small">No unanswered messages on this route. Use “Simulate message” to inject one.</p>}
        {pending.map((m, i) => (
          <TriageCard
            key={m.id}
            m={m}
            now={now}
            first={i === 0}
            text={draftOf(m)}
            onText={(t) => setDrafts((x) => ({ ...x, [m.id]: t }))}
            onSend={() => run(() => api.sendReply(m.id, draftOf(m)), `Reply sent to ${m.triage!.draft.to}`)}
            onDismiss={() => run(() => api.dismiss(m.id), "Message dismissed")}
            onRedraft={() =>
              run(async () => {
                await api.redraft(m.id);
                setDrafts((x) => {
                  const { [m.id]: _drop, ...rest } = x;
                  return rest;
                });
              }, "Draft regenerated")
            }
          />
        ))}
        {handled.length > 0 && (
          <details className="handled">
            <summary>{handled.length} handled message{handled.length > 1 ? "s" : ""}</summary>
            {handled.map((m) => (
              <p key={m.id} className="small"><b>{m.fromName}</b> <span className="muted">{ago(now, m.at)} · {m.status}</span><br />{m.text}</p>
            ))}
          </details>
        )}
      </section>

      {d.actions.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Suggested actions</h2><span className="muted">ranked · you approve</span></div>
          <ol className="actions">
            {d.actions.map((a) => <ActionItem key={a.id} a={a} onApply={(text) => run(() => api.applyAction(d.id, a.id, text), `${a.label}: done`)} />)}
          </ol>
        </section>
      )}

      {d.driver && (
        <section className="card">
          <div className="card-head"><h2>Driver · {d.driver.name}</h2><span className="muted">{d.driver.phone}</span></div>
          <div className="driver-stats">
            <div><b>{Math.round(d.driver.stats.onTimeRate * 100)}%</b><span>on time</span></div>
            <div><b>{d.driver.stats.routesLast30d}</b><span>routes 30d</span></div>
            <div className={d.driver.stats.incidentsLast30d >= 2 ? "bad" : ""}><b>{d.driver.stats.incidentsLast30d}</b><span>incidents 30d</span></div>
            <div><b>{d.driver.stats.avgRating.toFixed(1)}</b><span>rating</span></div>
          </div>
          <ul className="history">
            {d.driver.history.map((h) => (
              <li key={h.routeCode}>
                <span className="muted">{h.date.slice(5)}</span> {h.routeCode} · {h.stops} stops
                <span className={`pill ${h.outcome === "clean" ? "" : "bad"}`}>{h.outcome}</span>
                {h.note && <div className="small muted">{h.note}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Notes d={d} now={now} run={run} />
    </aside>
  );
}

function TriageCard(props: {
  m: InboundMessage; now: number; first: boolean; text: string;
  onText: (t: string) => void; onSend: () => void; onDismiss: () => void; onRedraft: () => void;
}) {
  const { m, now, first, text } = props;
  const t = m.triage;
  return (
    <div className="triage">
      <div className="row">
        <b>{m.fromName}</b>
        <span className="muted small">{m.fromRole} · {m.channel} · {ago(now, m.at)}</span>
      </div>
      <blockquote>{m.text}</blockquote>
      <div className="small muted">Linked by {m.linkedBy}</div>
      {t ? (
        <>
          <div className="row tags">
            <span className="pill">{CATEGORY_LABEL[t.category]}</span>
            <span className={`engine ${t.engine}`} title={t.engine === "ai" ? "Classified and drafted by the LLM" : "Classified and drafted by deterministic rules"}>
              {t.engine === "ai" ? "AI" : "Rules"} · {Math.round(t.confidence * 100)}%
            </span>
          </div>
          <p className="small">{t.summary}</p>
          <p className="small"><b>Recommended:</b> {t.recommendedAction}</p>
          <label className="draft-label">Draft reply to <b>{t.draft.to}</b> ({t.draft.toRole})</label>
          <textarea value={text} onChange={(e) => props.onText(e.target.value)} rows={4} />
          <div className="row buttons">
            <button className="primary" onClick={props.onSend} disabled={!text.trim()}>Approve & send {first && <kbd>a</kbd>}</button>
            <button className="ghost" onClick={props.onRedraft}>Re-draft</button>
            <button className="ghost" onClick={props.onDismiss}>Dismiss</button>
          </div>
        </>
      ) : (
        <p className="muted small">Triaging…</p>
      )}
    </div>
  );
}

function ActionItem({ a, onApply }: { a: SuggestedAction; onApply: (text?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(a.draft?.text ?? "");
  useEffect(() => setText(a.draft?.text ?? ""), [a.draft?.text]);
  return (
    <li className={`action ${a.kind}`}>
      <div className="row">
        <div>
          <b>{a.label}</b>
          <div className="small muted">{a.detail}</div>
        </div>
        <span className="spacer" />
        {a.draft ? (
          <button onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Review"}</button>
        ) : (
          <button onClick={() => onApply()}>Apply</button>
        )}
      </div>
      {a.draft && open && (
        <div className="action-draft">
          <label className="draft-label">{a.draft.channel.toUpperCase()} to <b>{a.draft.to}</b></label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          <button className="primary" onClick={() => onApply(text)} disabled={!text.trim()}>Approve & send</button>
        </div>
      )}
    </li>
  );
}

function Notes({ d, now, run }: { d: CaseDetail; now: number; run: Run }) {
  const [text, setText] = useState("");
  return (
    <section className="card">
      <div className="card-head"><h2>Notes</h2><span className="muted">visible to next shift</span></div>
      {d.notes.map((n, i) => (
        <p key={i} className="small"><b>{n.author}</b> <span className="muted">{ago(now, n.at)}</span><br />{n.text}</p>
      ))}
      <form
        className="note-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void run(() => api.note(d.id, text), "Note added").then(() => setText(""));
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note…" />
        <button type="submit" disabled={!text.trim()}>Add</button>
      </form>
    </section>
  );
}
