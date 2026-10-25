// Deterministic triage: classify, recommend an action, draft a reply. Always available, and the
// fallback for the LLM path in ./llm.ts. Nothing here sends anything: drafts wait for an operator.
import { fmtMin } from "../shared/detect";
import type { Customer, Driver, InboundMessage, MessageCategory, Route, Stop, StopRisk, Triage } from "../shared/types";

export type TriageFn = (ctx: TriageContext) => Promise<Triage>;

export interface TriageContext {
  message: InboundMessage;
  route: Route | null;
  stop: Stop | null;
  driver: Driver | null;
  customer: Customer | null;
  stopRisk: StopRisk | null;
  now: number;
}

/** Base urgency (0-10) of an unanswered message, used by the queue score. */
export const CATEGORY_URGENCY: Record<MessageCategory, number> = {
  building_access: 6, missing_bag: 6, stuck_at_pickup: 5, wrong_address: 5, driver_quiet: 5,
  stop_order: 4, wismo: 3, pod_request: 2, other: 2, pay_question: 1,
};

// Order matters: earlier rules win (e.g. "says delivered" is a POD issue, not a WISMO).
const RULES: Array<[MessageCategory, RegExp]> = [
  ["pay_question", /\b(pay|paid|payment|deposit|payout)\b|\$\d/i],
  ["pod_request", /proof|photo|\bpod\b|not received|never (got|received)|says (it was )?delivered|nothing at (my|the) door/i],
  ["missing_bag", /missing|\d+ of \d+ bags|wrong bag|extra bag|bag(s)? (is|are)n'?t/i],
  ["building_access", /gate|code|buzz|front desk|concierge|can'?t get in|locked|lobby|call ?box/i],
  ["wrong_address", /wrong address|address (is )?(wrong|doesn'?t exist)|no such (address|unit)|moved/i],
  ["driver_quiet", /phone died|back online|back on now|lost (signal|service)|battery/i],
  ["stop_order", /stop order|which stop|(do|go to) (stop )?\d+ (first|before)|reorder|before stop/i],
  ["stuck_at_pickup", /still (at|waiting)|not ready|kitchen|commissary|waiting (on|for) (the )?(bags|order)/i],
  ["wismo", /where('?s| is) my|when (will|is) .*(arrive|get here|deliver)|tracking|\beta\b/i],
];

export function classifyByRules(text: string): { category: MessageCategory; confidence: number } {
  for (const [category, re] of RULES) if (re.test(text)) return { category, confidence: 0.7 };
  return { category: "other", confidence: 0.3 };
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

function firstName(name: string | undefined): string {
  return name?.split(" ")[0] ?? "there";
}

export function triageByRules(ctx: TriageContext): Triage {
  const { message: m, stop, driver, customer, stopRisk, now } = ctx;
  const { category, confidence } = classifyByRules(m.text);
  const driverFirst = firstName(driver?.name);
  const recipientFirst = firstName(stop?.recipient);
  const eta = stop?.eta ? clock(Math.max(stop.eta, now)) : null;
  const window = stop ? `${clock(stop.windowStart)}–${clock(stop.windowEnd)}` : null;
  const margin = stopRisk?.marginMin ?? null;
  const tivNote = margin !== null ? (margin < 0 ? ` TIV projected ${fmtMin(-margin)} over budget.` : ` TIV margin ${fmtMin(margin)}.`) : "";
  const stopRef = stop ? `stop ${stop.seq}` : "the stop";

  const reply = (toRole: Triage["draft"]["toRole"], text: string): Triage["draft"] => ({
    toRole,
    to: toRole === "driver" ? driver?.name ?? m.fromName : toRole === "customer" ? stop?.recipient ?? m.fromName : customer?.name ?? m.fromName,
    text,
  });

  const byCategory: Record<MessageCategory, { summary: string; action: string; draft: Triage["draft"] }> = {
    building_access: {
      summary: `Driver can't access ${stop?.address ?? "the building"} for ${stopRef}.${tivNote}`,
      action: "Call the recipient for access; if no answer in 5 min, deliver to concierge or skip and come back after the next stop.",
      draft: reply("driver", `Thanks ${driverFirst}, calling ${recipientFirst} now for access. Hang tight 5 min. If we can't reach them, leave it with the concierge if there is one, otherwise continue to the next stop and we'll reschedule this one.`),
    },
    missing_bag: {
      summary: `Bag missing for ${stopRef} (${stop?.orderId ?? "order unknown"}).${tivNote}`,
      action: `Confirm with ${customer?.name ?? "the business"} whether the bag is still at the kitchen; arrange a runner or partial delivery and tell the recipient.`,
      draft: reply("driver", `Got it ${driverFirst}, thanks for flagging. Deliver the bags you have for ${stopRef} and keep going. We're checking with ${customer?.name ?? "the kitchen"} on the missing one and will update the customer.`),
    },
    stuck_at_pickup: {
      summary: `Driver waiting at pickup with cargo already loaded.${tivNote}`,
      action: `Call ${customer?.name ?? "the pickup site"} for a ready time; if over 10 min, have the driver leave with what is ready.`,
      draft: reply("driver", `Thanks ${driverFirst}. We're calling the kitchen now. If the remaining bags aren't ready in 10 minutes, head out with what you have and we'll sort the rest.`),
    },
    stop_order: {
      summary: `Driver asking about stop order.${tivNote}`,
      action: "Check TIV per stop; if a sensitive stop is projected to breach, approve the reorder.",
      draft: reply("driver", `Good call ${driverFirst}. Go ahead and do the frozen stop first, then continue in the app order. We're updating the ETAs for the customers.`),
    },
    driver_quiet: {
      summary: "Driver back in contact after going quiet.",
      action: "Confirm the driver's position and remaining stops; re-send updated ETAs to affected customers.",
      draft: reply("driver", `Thanks for checking in ${driverFirst}. Please keep the app open so we see your location. You have ${stopRef} next, customers are waiting.`),
    },
    wrong_address: {
      summary: `Address issue at ${stopRef}.`,
      action: "Call the recipient to confirm the address; update the stop and notify the driver.",
      draft: reply("driver", `Thanks ${driverFirst}, we're calling ${recipientFirst} to confirm the address. Give us 5 min, we'll text you the correct one.`),
    },
    wismo: {
      summary: `Customer asking for their order. ETA ${eta ?? "unknown"}, window ${window ?? "unknown"}.`,
      action: "Reply with the live ETA; no escalation needed if within window.",
      draft: reply("customer", `Hi ${recipientFirst}, your ${customer?.name ?? ""} order is on its way with ${driverFirst}. Current ETA is ${eta ?? "shortly"}${window ? `, within your ${window} window` : ""}. We'll text you if anything changes.`),
    },
    pod_request: {
      summary: `Proof of delivery requested for ${stop?.orderId ?? "an order"}.${stop?.deliveredDistanceM && stop.deliveredDistanceM > 150 ? ` Delivery was marked ${stop.deliveredDistanceM}m from the address.` : ""}`,
      action: stop?.deliveredDistanceM && stop.deliveredDistanceM > 150
        ? "Do not send POD as proof: GPS fix is far from the address. Call the driver to confirm where it was left; offer redelivery."
        : "Send the POD pack (photo, timestamp, distance, TIV at delivery).",
      draft: reply("business", stop?.deliveredDistanceM && stop.deliveredDistanceM > 150
        ? `Hi ${customer?.name ?? ""} team, thanks for flagging ${stop.orderId}. We're checking with the driver now as the delivery location looks off. We'll update you within 15 minutes and can arrange redelivery if needed.`
        : `Hi ${customer?.name ?? ""} team, attached is the proof of delivery for ${stop?.orderId ?? "the order"}: photo, timestamp and GPS location.`),
    },
    pay_question: {
      summary: "Driver pay question (out of scope for live ops).",
      action: "Forward to the driver-pay queue; acknowledge receipt.",
      draft: reply("driver", `Hi ${driverFirst}, thanks for reaching out. I've passed this to our driver pay team, they'll get back to you within 1 business day.`),
    },
    other: {
      summary: "Unclassified message.",
      action: "Read and handle manually.",
      draft: reply(m.fromRole, `Hi ${firstName(m.fromName)}, thanks for the message, we're looking into it now.`),
    },
  };

  const chosen = byCategory[category];
  return { category, confidence, engine: "rules", summary: chosen.summary, recommendedAction: chosen.action, draft: chosen.draft };
}

export const triageWithRules: TriageFn = async (ctx) => triageByRules(ctx);
