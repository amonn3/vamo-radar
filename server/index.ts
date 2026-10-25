import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { CargoClass, CaseStatus, InboundMessage, ResolutionCode } from "../shared/types";
import { NotFound, Store } from "./store";
import { aiEnabled } from "./triage";

const store = new Store();
const app = new Hono();

app.onError((err, c) => {
  if (err instanceof NotFound) return c.json({ error: err.message }, 404);
  console.error(err);
  return c.json({ error: err.message }, 400);
});

const RESOLUTION_CODES: ResolutionCode[] = ["delivered_ok", "customer_notified", "reassigned", "redelivery_scheduled", "false_alarm", "escalated", "other"];

app.get("/api/clock", (c) => c.json({ now: store.now, aiEnabled: aiEnabled() }));

app.post("/api/clock/advance", async (c) => {
  const { minutes } = await c.req.json<{ minutes?: number }>().catch(() => ({ minutes: undefined }));
  const m = Number(minutes ?? 30);
  if (!Number.isFinite(m) || m <= 0 || m > 240) return c.json({ error: "minutes must be between 1 and 240" }, 400);
  store.advance(m);
  return c.json({ now: store.now });
});

app.post("/api/clock/reset", (c) => {
  store.reset();
  return c.json({ now: store.now });
});

app.get("/api/cases", (c) => {
  const q = c.req.query();
  return c.json(store.listCases({
    status: (q.status as CaseStatus | "active" | undefined) || undefined,
    cargo: (q.cargo as CargoClass | undefined) || undefined,
    type: q.type || undefined,
    q: q.q || undefined,
  }));
});

app.get("/api/cases/:id", (c) => {
  const detail = store.caseDetail(c.req.param("id"));
  return detail ? c.json(detail) : c.json({ error: "Case not found" }, 404);
});

app.post("/api/cases/:id/claim", (c) => {
  store.claim(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/cases/:id/release", (c) => {
  store.release(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/cases/:id/note", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  if (!text?.trim()) return c.json({ error: "text is required" }, 400);
  store.addNote(c.req.param("id"), text.trim());
  return c.json({ ok: true });
});

app.post("/api/cases/:id/resolve", async (c) => {
  const { code, note } = await c.req.json<{ code?: ResolutionCode; note?: string }>();
  if (!code || !RESOLUTION_CODES.includes(code)) return c.json({ error: "valid resolution code required" }, 400);
  store.resolve(c.req.param("id"), code, note?.trim() || undefined);
  return c.json({ ok: true });
});

app.post("/api/cases/:id/actions/:actionId", async (c) => {
  const { text } = await c.req.json<{ text?: string }>().catch(() => ({ text: undefined }));
  store.applyAction(c.req.param("id"), c.req.param("actionId"), text);
  return c.json({ ok: true });
});

app.post("/api/messages/simulate", async (c) => c.json(await store.simulateNextMessage()));

app.post("/api/messages/inbound", async (c) => {
  const body = await c.req.json<Partial<Pick<InboundMessage, "fromPhone" | "fromRole" | "channel" | "text" | "fromName">>>();
  if (!body.fromPhone || !body.text) return c.json({ error: "fromPhone and text are required" }, 400);
  return c.json(await store.receiveMessage({
    fromPhone: body.fromPhone, text: body.text, fromName: body.fromName,
    fromRole: body.fromRole ?? "driver", channel: body.channel ?? "sms",
  }));
});

app.post("/api/messages/:id/send", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  if (!text?.trim()) return c.json({ error: "text is required" }, 400);
  store.sendReply(c.req.param("id"), text.trim());
  return c.json({ ok: true });
});

app.post("/api/messages/:id/dismiss", (c) => {
  store.dismissMessage(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/triage/draft", async (c) => {
  const { messageId } = await c.req.json<{ messageId?: string }>();
  if (!messageId) return c.json({ error: "messageId is required" }, 400);
  return c.json(await store.redraft(messageId));
});

app.get("/api/stops/:id/pod", (c) => c.json(store.podPack(c.req.param("id"))));

app.get("/api/handoff", (c) => c.json({ text: store.handoff() }));

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Vamo Radar API on http://localhost:${port} (AI triage: ${aiEnabled() ? "LLM" : "rules only, set ANTHROPIC_API_KEY to enable"})`);
});
