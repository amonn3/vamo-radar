// LLM triage for inbound messages, used when ANTHROPIC_API_KEY is set. Server-only: the key never
// reaches the browser. Any failure or refusal falls back to the rules engine.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Triage } from "../shared/types";
import { clock, triageByRules, type TriageContext, type TriageFn } from "./triage";


const TriageSchema = z.object({
  category: z.enum(["building_access", "wrong_address", "missing_bag", "stuck_at_pickup", "stop_order", "driver_quiet", "wismo", "pod_request", "pay_question", "other"]),
  confidence: z.number(),
  summary: z.string(),
  recommended_action: z.string(),
  reply_to: z.enum(["driver", "customer", "business"]),
  reply: z.string(),
});

const SYSTEM = `You are the triage assistant inside Vamo Radar, an ops console for Vamo, a cold-chain last-mile delivery company in Miami.
Ops agents read your output and approve or edit it before anything is sent. You never send messages yourself.

Classify the inbound message into exactly one category:
building_access, wrong_address, missing_bag, stuck_at_pickup, stop_order, driver_quiet (driver reappearing after silence), wismo (where's my order), pod_request (proof of delivery / "says delivered but not here"), pay_question, other.

Then give a one-sentence summary for the agent, the single best next action for ops, and a short SMS reply (under 320 characters) to the party who should hear from us next (usually the sender).
Cold-chain risk is measured as Time-in-Vehicle (TIV) against a budget per cargo class; protect perishable cargo first.
Never promise refunds or credits. Never invent ETAs, codes or facts that are not in the context. Write replies in the sender's language, friendly and brief.`;

let client: Anthropic | null = null;
export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

function contextBlock(ctx: TriageContext): string {
  const { message: m, route, stop, driver, customer, stopRisk, now } = ctx;
  const lines = [
    `Now: ${clock(now)} ET`,
    `From: ${m.fromName} (${m.fromRole}) via ${m.channel}`,
    route ? `Route: ${route.code}, status ${route.status}, pickup ${route.pickupSite}` : "Route: not linked",
    driver ? `Driver: ${driver.name}` : "",
    customer ? `Business: ${customer.name} (${customer.kind})` : "",
    stop ? `Stop ${stop.seq}: ${stop.recipient}, ${stop.address}, order ${stop.orderId}, ${stop.cargo}, ${stop.bags} bags, status ${stop.status}` : "",
    stop ? `Booked window ${clock(stop.windowStart)}-${clock(stop.windowEnd)}; live ETA ${stop.eta ? clock(Math.max(stop.eta, now)) : "n/a"}` : "",
    stop?.deliveredAt ? `Delivered at ${clock(stop.deliveredAt)}, ${stop.deliveredDistanceM}m from the address` : "",
    stopRisk?.marginMin != null ? `TIV at this stop: ${Math.round(stopRisk.tivAtStopMin ?? 0)} of ${stopRisk.budgetMin} min budget (margin ${Math.round(stopRisk.marginMin)} min)` : "",
  ];
  return `${lines.filter(Boolean).join("\n")}\n\nMessage:\n"""${m.text}"""`;
}

export async function triageWithAI(ctx: TriageContext): Promise<Triage | null> {
  if (!aiEnabled()) return null;
  client ??= new Anthropic({ timeout: 30_000, maxRetries: 1 });
  try {
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content: contextBlock(ctx) }],
      output_config: { effort: "low", format: zodOutputFormat(TriageSchema) },
    });
    const out = response.parsed_output;
    if (response.stop_reason === "refusal" || !out) return null;
    const rules = triageByRules(ctx); // reuse its recipient resolution
    const to =
      out.reply_to === "driver" ? ctx.driver?.name ?? ctx.message.fromName :
      out.reply_to === "customer" ? ctx.stop?.recipient ?? ctx.message.fromName :
      ctx.customer?.name ?? rules.draft.to;
    return {
      category: out.category,
      confidence: Math.max(0, Math.min(1, out.confidence)),
      engine: "ai",
      summary: out.summary,
      recommendedAction: out.recommended_action,
      draft: { to, toRole: out.reply_to, text: out.reply },
    };
  } catch (err) {
    console.warn("[triage] LLM call failed, using rules:", err instanceof Error ? err.message : err);
    return null;
  }
}

export const triageWithLLM: TriageFn = async (ctx) => {
  return (await triageWithAI(ctx)) ?? triageByRules(ctx);
};
