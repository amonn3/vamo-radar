// In-memory world: seed data, a simulated clock, and the case state ops builds on top of it.
import { detectSignals, fmtMin, THRESHOLDS } from "../shared/detect";
import { scoreCase, SIGNAL_LABEL } from "../shared/score";
import { assessRoute, budgetFor, MINUTE } from "../shared/tiv";
import type {
  CargoClass, CaseDetail, CaseNote, CaseStatus, CaseSummary, Customer, Driver, InboundMessage, ResolutionCode, Route,
  RouteRisk, Signal, Stop, SuggestedAction, TimelineEvent,
} from "../shared/types";
import { buildSeed, type SeedData } from "./seed";
import { CATEGORY_LABEL } from "../shared/labels";
import { CATEGORY_URGENCY, triage, triageByRules, type TriageContext } from "./triage";

export const OPERATOR = "You";

interface CaseState {
  openedAt: number;
  status: CaseStatus;
  claimedBy: string | null;
  lastTouchedAt: number | null;
  notes: CaseNote[];
  resolution: { code: ResolutionCode; at: number } | null;
  resolvedKeys: string[];
}

export interface CaseFilter {
  status?: CaseStatus | "active";
  cargo?: CargoClass;
  type?: string;
  q?: string;
}

const CARGO_ORDER: CargoClass[] = ["frozen", "chilled", "ambient"];
const isPending = (s: Stop) => s.status === "pending" || s.status === "arrived";
const caseIdFor = (routeId: string) => `case-${routeId}`;

interface ScriptedMessage {
  fromPhone: (s: Store) => string;
  fromRole: InboundMessage["fromRole"];
  channel: InboundMessage["channel"];
  text: (s: Store) => string;
}

// What "Simulate driver message" injects, in order. Phones resolve at send time so links are real.
const SCRIPT: ScriptedMessage[] = [
  {
    fromRole: "driver", channel: "sms",
    fromPhone: (s) => s.driverByName("Kevin Nguyen").phone,
    text: () => "Hey the app has me doing Coral Way (stop 5) near the end but it's the frozen one. Can I do 5 first? It's close to where I am",
  },
  {
    fromRole: "driver", channel: "sms",
    fromPhone: (s) => s.driverByName("Tyler Brooks").phone,
    text: () => "Sorry phone died, back on now. Heading to stop 3, 5 min out",
  },
  {
    fromRole: "business", channel: "slack",
    fromPhone: () => "Bayside Poke (shared channel)",
    text: () => "Hi team, customer on order BP-40517 says nothing at the door but it shows delivered. Can you send proof of delivery?",
  },
  {
    fromRole: "customer", channel: "sms",
    fromPhone: (s) => s.healthyPendingStop()?.recipientPhone ?? "+1 305 555 0000",
    text: () => "When will my groceries get here? Tracking hasn't moved in a while",
  },
  {
    fromRole: "driver", channel: "sms",
    fromPhone: (s) => s.driverByName("Diego Herrera").phone,
    text: () => "Hi, I'm missing $18 from Tuesday's route. When does pay come in?",
  },
];

export class Store {
  now = 0;
  private customers = new Map<string, Customer>();
  private drivers = new Map<string, Driver>();
  private routes = new Map<string, Route>();
  private stops = new Map<string, Stop>();
  private events: TimelineEvent[] = [];
  private messages: InboundMessage[] = [];
  private cases = new Map<string, CaseState>();
  private seenSignals = new Set<string>();
  private eventSeq = 0;
  private msgSeq = 0;
  private scriptIdx = 0;

  constructor(private readonly seedFactory: () => SeedData = () => buildSeed()) {
    this.reset();
  }

  reset(): void {
    const seed = this.seedFactory();
    this.now = seed.now;
    this.customers = new Map(seed.customers.map((c) => [c.id, c]));
    this.drivers = new Map(seed.drivers.map((d) => [d.id, structuredClone(d)]));
    this.routes = new Map(seed.routes.map((r) => [r.id, structuredClone(r)]));
    this.stops = new Map(seed.stops.map((s) => [s.id, structuredClone(s)]));
    this.events = structuredClone(seed.events);
    this.messages = structuredClone(seed.messages);
    this.cases.clear();
    this.seenSignals.clear();
    this.eventSeq = this.events.length;
    this.msgSeq = this.messages.length;
    this.scriptIdx = 0;
    for (const m of this.messages) m.triage = triageByRules(this.triageContext(m));
    this.sync();
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  driverByName(name: string): Driver {
    const d = [...this.drivers.values()].find((x) => x.name === name);
    if (!d) throw new Error(`Unknown driver ${name}`);
    return d;
  }

  private stopsOf(route: Route): Stop[] {
    return route.stopIds.map((id) => this.stops.get(id)!).sort((a, b) => a.seq - b.seq);
  }

  private riskOf(route: Route): RouteRisk {
    return assessRoute(route, this.stopsOf(route), this.now, this.customers);
  }

  private addEvent(e: Omit<TimelineEvent, "id">): void {
    this.events.push({ id: `ev-${++this.eventSeq}`, ...e });
  }

  /** A pending stop on an in-progress route with no open case, for the scripted WISMO. */
  healthyPendingStop(): Stop | undefined {
    for (const r of this.routes.values()) {
      if (r.status !== "in_progress" || this.cases.has(caseIdFor(r.id))) continue;
      const s = this.stopsOf(r).find((x) => isPending(x) && x.cargo !== "ambient");
      if (s) return s;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Signals and cases
  // ---------------------------------------------------------------------------

  private signalsOf(route: Route, risk: RouteRisk): Signal[] {
    const signals = detectSignals(route, this.stopsOf(route), risk, this.now);
    for (const m of this.messages) {
      if (m.routeId !== route.id || m.status !== "pending" || !m.triage) continue;
      const waiting = Math.round((this.now - m.at) / MINUTE);
      const snippet = m.text.length > 70 ? `${m.text.slice(0, 67)}...` : m.text;
      signals.push({
        type: "inbound",
        key: `inbound:${m.id}`,
        stopIds: m.stopId ? [m.stopId] : [],
        detail: `${CATEGORY_LABEL[m.triage.category]} from ${m.fromName.split(" ")[0]}, waiting ${fmtMin(waiting)}: "${snippet}"`,
        // An unanswered message gets a little more urgent every 10 minutes.
        urgency: CATEGORY_URGENCY[m.triage.category] + Math.min(waiting / 10, 2),
        messageCategory: m.triage.category,
      });
    }
    return signals;
  }

  private onsetOf(signal: Signal, route: Route): number {
    const m = signal.type === "inbound" ? this.messages.find((x) => `inbound:${x.id}` === signal.key) : undefined;
    if (m) return m.at;
    if (signal.type === "driver_quiet" && route.lastPingAt) return route.lastPingAt + THRESHOLDS.quietMin * MINUTE;
    if (signal.type === "driver_stalled" && route.lastMovedAt) return route.lastMovedAt + THRESHOLDS.stalledMin * MINUTE;
    if (signal.type === "driver_cancelled" && route.driverCancelledAt) return route.driverCancelledAt;
    return this.now;
  }

  /** Records first sightings of signals on the timeline and opens/reopens/auto-clears cases. */
  private sync(): void {
    for (const route of this.routes.values()) {
      const signals = this.signalsOf(route, this.riskOf(route));
      const id = caseIdFor(route.id);
      let state = this.cases.get(id);

      for (const s of signals) {
        const seenKey = `${route.id}|${s.key}`;
        if (this.seenSignals.has(seenKey)) continue;
        this.seenSignals.add(seenKey);
        if (s.type !== "inbound") {
          this.addEvent({ routeId: route.id, stopId: s.stopIds[0], at: Math.min(this.onsetOf(s, route), this.now), source: "alert", actor: "Radar", text: `${SIGNAL_LABEL[s.type]}: ${s.detail}` });
        }
      }

      if (signals.length === 0) {
        // Unclaimed cases close themselves; a claimed case stays with its owner until they resolve it.
        if (state?.status === "open") {
          state.status = "resolved";
          state.resolution = { code: "other", at: this.now };
          state.resolvedKeys = [];
          this.addEvent({ routeId: route.id, at: this.now, source: "system", actor: "Radar", text: "All signals cleared, case closed automatically" });
        }
        continue;
      }

      if (!state) {
        state = {
          openedAt: Math.min(...signals.map((s) => this.onsetOf(s, route)), this.now),
          status: "open", claimedBy: null, lastTouchedAt: null, notes: [], resolution: null, resolvedKeys: [],
        };
        this.cases.set(id, state);
      } else if (state.status === "resolved") {
        const fresh = signals.filter((s) => !state!.resolvedKeys.includes(s.key));
        if (fresh.length > 0) {
          state.status = "open";
          state.claimedBy = null;
          state.resolution = null;
          state.openedAt = this.now;
          state.lastTouchedAt = null;
          this.addEvent({ routeId: route.id, at: this.now, source: "alert", actor: "Radar", text: `Case reopened: ${SIGNAL_LABEL[fresh[0]!.type]}` });
        }
      }
    }
  }

  private summarize(route: Route): CaseSummary | null {
    const state = this.cases.get(caseIdFor(route.id));
    if (!state) return null;
    const risk = this.riskOf(route);
    const signals = this.signalsOf(route, risk);
    const stops = this.stopsOf(route);
    const affected = [...new Set(signals.flatMap((s) => s.stopIds))];
    const cargoPool = stops.filter(isPending).length ? stops.filter(isPending) : stops.filter((s) => affected.includes(s.id));
    const cargo = CARGO_ORDER.find((c) => cargoPool.some((s) => s.cargo === c)) ?? "ambient";
    const driver = route.driverId ? this.drivers.get(route.driverId) ?? null : null;

    const scored = signals.length
      ? scoreCase({ signals, risk, cargo, openedAt: state.openedAt, lastTouchedAt: state.lastTouchedAt, now: this.now })
      : null;

    return {
      id: caseIdFor(route.id),
      routeId: route.id,
      routeCode: route.code,
      driverName: driver?.name ?? null,
      customerNames: [...new Set(stops.map((s) => this.customers.get(s.customerId)!.name))],
      primaryType: scored?.primary.type ?? "inbound",
      signals,
      cargo,
      status: state.status,
      claimedBy: state.claimedBy,
      priority: state.status === "resolved" ? 0 : scored?.priority ?? 0,
      level: scored?.level ?? "ok",
      reason: scored?.reason ?? "Signals cleared. Resolve when you're done",
      risk,
      affectedStopIds: affected,
      openedAt: state.openedAt,
      lastTouchedAt: state.lastTouchedAt,
      pendingMessages: this.messages.filter((m) => m.routeId === route.id && m.status === "pending").length,
    };
  }

  listCases(filter: CaseFilter = {}): { cases: CaseSummary[]; counts: Record<CaseStatus, number> } {
    const all = [...this.routes.values()].map((r) => this.summarize(r)).filter((c): c is CaseSummary => c !== null);
    const counts: Record<CaseStatus, number> = { open: 0, in_progress: 0, resolved: 0 };
    for (const c of all) counts[c.status]++;

    const q = filter.q?.trim().toLowerCase();
    const status = filter.status ?? "active";
    const cases = all
      .filter((c) => (status === "active" ? c.status !== "resolved" : c.status === status))
      .filter((c) => !filter.cargo || c.cargo === filter.cargo)
      .filter((c) => !filter.type || c.signals.some((s) => s.type === filter.type))
      .filter((c) => !q || this.searchText(c).includes(q))
      .sort((a, b) => b.priority - a.priority || a.openedAt - b.openedAt);
    return { cases, counts };
  }

  private searchText(c: CaseSummary): string {
    const route = this.routes.get(c.routeId)!;
    const stops = this.stopsOf(route);
    return [c.routeCode, c.driverName ?? "", ...c.customerNames, ...stops.flatMap((s) => [s.orderId, s.recipient, s.address])].join(" ").toLowerCase();
  }

  caseDetail(id: string): CaseDetail | null {
    const route = this.routes.get(id.replace(/^case-/, ""));
    if (!route) return null;
    const summary = this.summarize(route);
    if (!summary) return null;
    const state = this.cases.get(id)!;
    const stops = this.stopsOf(route);
    return {
      ...summary,
      route: structuredClone(route),
      stops: structuredClone(stops),
      driver: route.driverId ? this.drivers.get(route.driverId) ?? null : null,
      customers: [...new Set(stops.map((s) => s.customerId))].map((cid) => this.customers.get(cid)!),
      timeline: this.events.filter((e) => e.routeId === route.id && e.at <= this.now).sort((a, b) => b.at - a.at),
      messages: this.messages.filter((m) => m.routeId === route.id).sort((a, b) => b.at - a.at),
      actions: summary.status === "resolved" ? [] : this.actionsFor(route, summary),
      notes: state.notes,
      resolution: state.resolution,
    };
  }

  // ---------------------------------------------------------------------------
  // Case lifecycle
  // ---------------------------------------------------------------------------

  private touch(caseId: string, claim = true): CaseState {
    const state = this.cases.get(caseId);
    if (!state) throw new NotFound(`Case ${caseId} not found`);
    state.lastTouchedAt = this.now;
    if (claim && state.status === "open") {
      state.status = "in_progress";
      state.claimedBy = OPERATOR;
    }
    return state;
  }

  claim(caseId: string): void {
    const state = this.touch(caseId);
    state.status = "in_progress";
    state.claimedBy = OPERATOR;
    this.addEvent({ routeId: caseId.replace("case-", ""), at: this.now, source: "operator", actor: OPERATOR, text: "Claimed the case" });
  }

  release(caseId: string): void {
    const state = this.touch(caseId, false);
    state.status = "open";
    state.claimedBy = null;
    this.addEvent({ routeId: caseId.replace("case-", ""), at: this.now, source: "operator", actor: OPERATOR, text: "Released the case back to the queue" });
  }

  addNote(caseId: string, text: string): void {
    const state = this.touch(caseId, false);
    state.notes.push({ at: this.now, author: OPERATOR, text });
    this.addEvent({ routeId: caseId.replace("case-", ""), at: this.now, source: "operator", actor: OPERATOR, text: `Note: ${text}` });
  }

  resolve(caseId: string, code: ResolutionCode, note?: string): void {
    const state = this.touch(caseId, false);
    const route = this.routes.get(caseId.replace("case-", ""))!;
    state.status = "resolved";
    state.resolution = { code, at: this.now };
    state.resolvedKeys = this.signalsOf(route, this.riskOf(route)).map((s) => s.key);
    // Resolving a case answers its open messages; nothing is sent on the operator's behalf.
    for (const m of this.messages) if (m.routeId === route.id && m.status === "pending") m.status = "dismissed";
    this.addEvent({ routeId: route.id, at: this.now, source: "operator", actor: OPERATOR, text: `Resolved: ${code.replace(/_/g, " ")}${note ? ` (${note})` : ""}` });
  }

  // ---------------------------------------------------------------------------
  // Simulated clock
  // ---------------------------------------------------------------------------

  advance(minutes: number): void {
    const to = this.now + minutes * MINUTE;
    for (const route of this.routes.values()) this.simulateRoute(route, to, minutes);
    this.now = to;
    this.sync();
  }

  private simulateRoute(route: Route, to: number, minutes: number): void {
    const driver = route.driverId ? this.drivers.get(route.driverId) : undefined;
    const actor = driver?.name ?? "Driver";

    if (route.status === "assigned" && route.scheduledPickupAt <= to) {
      route.loadedAt = route.scheduledPickupAt;
      route.status = "in_progress";
      route.lastMovedAt = to;
      this.addEvent({ routeId: route.id, at: route.loadedAt, source: "status", actor, text: "Cargo scanned out of cold storage. TIV clock started" });
    }
    if (route.status !== "in_progress" && route.status !== "at_pickup") return;

    const pending = this.stopsOf(route).filter(isPending);
    for (const s of pending) {
      if (s.eta === null) continue;
      if (s.handedTo) continue; // the receiving driver runs on time
      if (route.sim === "stuck" || route.sim === "quiet") s.eta += minutes * MINUTE;
      else if (route.sim === "slipping") s.eta += Math.round(minutes * 0.2) * MINUTE;
    }

    const moving = route.sim === "normal" || route.sim === "slipping";
    for (const s of pending) {
      if (s.eta === null || s.eta > to || (!moving && !s.handedTo)) continue;
      s.status = "delivered";
      s.deliveredAt = s.eta;
      s.eta = null;
      s.hasPhoto = true;
      s.deliveredDistanceM = 8 + ((s.seq * 17) % 30);
      this.addEvent({ routeId: route.id, stopId: s.id, at: s.deliveredAt, source: "status", actor: s.handedTo ?? actor, text: `Stop ${s.seq} delivered with photo (${s.deliveredDistanceM}m from address)` });
    }

    if (route.sim !== "quiet") route.lastPingAt = to;
    if (moving) route.lastMovedAt = to;

    const next = this.stopsOf(route).find((s) => isPending(s) && !s.handedTo);
    if (!this.stopsOf(route).some(isPending)) {
      route.status = "completed";
      route.position = { kind: "none" };
      this.addEvent({ routeId: route.id, at: to, source: "status", actor, text: "Route completed" });
    } else if (moving && next) {
      route.status = "in_progress";
      route.position = { kind: "enroute", toStopId: next.id, progress: 0.5 };
    }
  }

  // ---------------------------------------------------------------------------
  // Messages and triage
  // ---------------------------------------------------------------------------

  private triageContext(m: InboundMessage): TriageContext {
    const route = m.routeId ? this.routes.get(m.routeId) ?? null : null;
    const stop = m.stopId ? this.stops.get(m.stopId) ?? null : null;
    const risk = route ? this.riskOf(route) : null;
    return {
      message: m,
      route,
      stop,
      driver: route?.driverId ? this.drivers.get(route.driverId) ?? null : null,
      customer: stop ? this.customers.get(stop.customerId) ?? null : route ? this.customers.get(this.stopsOf(route)[0]!.customerId) ?? null : null,
      stopRisk: risk?.stops.find((r) => r.stopId === stop?.id) ?? null,
      now: this.now,
    };
  }

  /** Deterministic linking: sender phone, then order id, then "stop N" in the text. */
  private link(fromPhone: string, text: string): Pick<InboundMessage, "routeId" | "stopId" | "linkedBy" | "fromName"> {
    const orderMatch = text.match(/\b[A-Z]{2}-\d{5}\b/);
    const byOrder = orderMatch ? [...this.stops.values()].find((s) => s.orderId === orderMatch[0]) : undefined;
    const driver = [...this.drivers.values()].find((d) => d.phone === fromPhone);
    const recipientStop = [...this.stops.values()].find((s) => s.recipientPhone === fromPhone);

    if (driver) {
      const theirs = [...this.routes.values()].filter((r) => r.driverId === driver.id);
      const rank = (r: Route) => (r.status === "in_progress" || r.status === "at_pickup" ? 0 : r.status === "assigned" ? 1 : 2);
      const route = theirs.sort((a, b) => rank(a) - rank(b) || Math.abs(a.scheduledPickupAt - this.now) - Math.abs(b.scheduledPickupAt - this.now))[0];
      if (!route) return { routeId: null, stopId: null, linkedBy: "driver phone (no route)", fromName: driver.name };
      const seqMatch = text.match(/stop (\d+)/i);
      const stops = this.stopsOf(route);
      const stop = seqMatch ? stops.find((s) => s.seq === Number(seqMatch[1])) : route.position.kind === "at_stop" ? stops.find((s) => s.id === (route.position as { stopId: string }).stopId) : stops.find(isPending);
      return { routeId: route.id, stopId: stop?.id ?? null, linkedBy: `driver phone → ${route.code}${seqMatch ? ", stop number in text" : ""}`, fromName: driver.name };
    }
    if (byOrder) return { routeId: byOrder.routeId, stopId: byOrder.id, linkedBy: `order ${byOrder.orderId} in text`, fromName: "" };
    if (recipientStop) return { routeId: recipientStop.routeId, stopId: recipientStop.id, linkedBy: "recipient phone", fromName: recipientStop.recipient };
    return { routeId: null, stopId: null, linkedBy: "no match", fromName: "" };
  }

  async receiveMessage(input: { fromPhone: string; fromRole: InboundMessage["fromRole"]; channel: InboundMessage["channel"]; text: string; fromName?: string }): Promise<InboundMessage> {
    const linked = this.link(input.fromPhone, input.text);
    const msg: InboundMessage = {
      id: `msg-${++this.msgSeq}`,
      at: this.now,
      fromRole: input.fromRole,
      fromName: input.fromName || linked.fromName || input.fromPhone,
      fromPhone: input.fromPhone,
      channel: input.channel,
      text: input.text,
      routeId: linked.routeId,
      stopId: linked.stopId,
      linkedBy: linked.linkedBy,
      triage: null,
      status: "pending",
    };
    this.messages.push(msg);

    const route = msg.routeId ? this.routes.get(msg.routeId) : undefined;
    if (route) {
      this.addEvent({ routeId: route.id, stopId: msg.stopId ?? undefined, at: this.now, source: msg.channel, direction: "in", actor: msg.fromName, text: msg.text });
      if (msg.fromRole === "driver") {
        route.lastDriverMessageAt = this.now;
        // A driver who reappears is moving again (the simulator's notion of "back online").
        if (route.sim === "quiet") {
          route.sim = "normal";
          route.lastPingAt = this.now;
          route.lastMovedAt = this.now;
          const next = this.stopsOf(route).find(isPending);
          if (next) {
            next.eta = this.now + 5 * MINUTE;
            route.position = { kind: "enroute", toStopId: next.id, progress: 0.8 };
          }
        }
      }
    }

    msg.triage = await triage(this.triageContext(msg));
    if (route) this.addEvent({ routeId: route.id, at: this.now, source: "system", actor: msg.triage.engine === "ai" ? "Radar AI" : "Radar rules", text: `Triaged as ${CATEGORY_LABEL[msg.triage.category]}. Draft reply to ${msg.triage.draft.to} awaiting approval` });
    this.sync();
    return msg;
  }

  async simulateNextMessage(): Promise<InboundMessage> {
    const script = SCRIPT[this.scriptIdx++ % SCRIPT.length]!;
    return this.receiveMessage({ fromPhone: script.fromPhone(this), fromRole: script.fromRole, channel: script.channel, text: script.text(this) });
  }

  async redraft(messageId: string): Promise<InboundMessage> {
    const m = this.message(messageId);
    m.triage = await triage(this.triageContext(m));
    return m;
  }

  private message(id: string): InboundMessage {
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw new NotFound(`Message ${id} not found`);
    return m;
  }

  sendReply(messageId: string, text: string): void {
    const m = this.message(messageId);
    if (!m.triage) throw new Error("Message has no draft");
    m.status = "sent";
    m.triage.draft.text = text;
    if (m.routeId) {
      this.addEvent({ routeId: m.routeId, stopId: m.stopId ?? undefined, at: this.now, source: m.channel === "slack" ? "slack" : "sms", direction: "out", actor: OPERATOR, text: `To ${m.triage.draft.to}: ${text}` });
      this.touch(caseIdFor(m.routeId));
    }
    this.sync();
  }

  dismissMessage(messageId: string): void {
    const m = this.message(messageId);
    m.status = "dismissed";
    if (m.routeId) {
      this.addEvent({ routeId: m.routeId, at: this.now, source: "operator", actor: OPERATOR, text: `Dismissed message from ${m.fromName} without reply` });
      this.touch(caseIdFor(m.routeId), false);
    }
    this.sync();
  }

  // ---------------------------------------------------------------------------
  // Suggested actions
  // ---------------------------------------------------------------------------

  /** Drivers with no live route who did not cancel today, closest pickup zone first. */
  private availableDrivers(route: Route): Driver[] {
    const busy = new Set([...this.routes.values()].filter((r) => r.status === "in_progress" || r.status === "at_pickup").map((r) => r.driverId));
    const cancelled = new Set(this.events.filter((e) => /cancelled the route/.test(e.text)).map((e) => e.actor));
    const zone = route.pickupSite.split(", ")[1] ?? "";
    return [...this.drivers.values()]
      .filter((d) => !busy.has(d.id) && !cancelled.has(d.name) && d.id !== route.driverId)
      .sort((a, b) => Number(b.zone === zone) - Number(a.zone === zone) || b.stats.onTimeRate - a.stats.onTimeRate);
  }

  /** Earliest-deadline-first: each stop's deadline is load time + TIV budget (window end for ambient). */
  private edfOrder(route: Route): Stop[] {
    const deadline = (s: Stop) => {
      const b = budgetFor(s.cargo, this.customers.get(s.customerId));
      return b === null || route.loadedAt === null ? s.windowEnd : Math.min(route.loadedAt + b * MINUTE, s.windowEnd);
    };
    return this.stopsOf(route).filter((s) => isPending(s) && !s.handedTo).sort((a, b) => deadline(a) - deadline(b) || a.seq - b.seq);
  }

  private worstMarginIf(route: Route, etas: Map<string, number>): number | null {
    const simulated = this.stopsOf(route).map((s) => (etas.has(s.id) ? { ...s, eta: etas.get(s.id)! } : s));
    return assessRoute(route, simulated, this.now, this.customers).worstMarginMin;
  }

  private reorderPlan(route: Route): { order: Stop[]; etas: Map<string, number> } | null {
    const current = this.stopsOf(route).filter((s) => isPending(s) && !s.handedTo);
    const order = this.edfOrder(route);
    if (current.length < 2 || order.every((s, i) => s.id === current[i]!.id)) return null;
    // Keep the existing ETA slots and only change who gets which slot.
    const slots = current.map((s) => Math.max(s.eta ?? this.now, this.now)).sort((a, b) => a - b);
    return { order, etas: new Map(order.map((s, i) => [s.id, slots[i]!])) };
  }

  private actionsFor(route: Route, c: CaseSummary): SuggestedAction[] {
    const actions: SuggestedAction[] = [];
    const stops = this.stopsOf(route);
    const driver = route.driverId ? this.drivers.get(route.driverId) : undefined;
    const has = (t: Signal["type"]) => c.signals.some((s) => s.type === t);
    const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
    const atRisk = stops.filter((s) => c.risk.atRiskStopIds.includes(s.id) && !s.handedTo);
    const worst = stops.find((s) => s.id === c.risk.worstStopId);
    const marginTxt = (m: number | null) => (m === null ? "n/a" : m < 0 ? `${fmtMin(-m)} over` : `${fmtMin(m)} margin`);

    if (atRisk.length > 0 && driver) {
      const candidate = this.availableDrivers(route)[0];
      const etas = new Map(atRisk.map((s, i) => [s.id, this.now + (15 + i * 10) * MINUTE]));
      const afterReassign = candidate ? this.worstMarginIf(route, etas) : null;
      // Only worth a cargo transfer if the hand-off actually buys TIV margin.
      if (candidate && afterReassign !== null && (c.risk.worstMarginMin === null || afterReassign > c.risk.worstMarginMin)) {
        actions.push({
          id: "reassign", kind: "reassign",
          label: `Reassign stop${atRisk.length > 1 ? "s" : ""} ${atRisk.map((s) => s.seq).join(", ")} to ${candidate.name}`,
          detail: `${candidate.name} is free near ${candidate.zone} (${Math.round(candidate.stats.onTimeRate * 100)}% on time). Worst TIV ${marginTxt(c.risk.worstMarginMin)} → ${marginTxt(afterReassign)}`,
        });
      }
      const plan = this.reorderPlan(route);
      if (plan) {
        const after = this.worstMarginIf(route, plan.etas);
        if (after !== null && (c.risk.worstMarginMin === null || after > c.risk.worstMarginMin)) {
          actions.push({
            id: "reorder", kind: "reorder",
            label: `Reorder: ${plan.order.map((s) => s.seq).join(" → ")}`,
            detail: `Most perishable stops first. Worst TIV ${marginTxt(c.risk.worstMarginMin)} → ${marginTxt(after)}`,
          });
        }
      }
    }

    const notifyStop = worst && isPending(worst) ? worst : stops.find((s) => isPending(s) && c.affectedStopIds.includes(s.id));
    if (notifyStop && (atRisk.length > 0 || has("eta_past_window") || has("driver_quiet") || has("driver_stalled"))) {
      const eta = clock(Math.max(notifyStop.eta ?? this.now, this.now) + 10 * MINUTE);
      actions.push({
        id: "notify_customer", kind: "notify_customer",
        label: `Text ${notifyStop.recipient} a new ETA`,
        detail: `Stop ${notifyStop.seq}, booked ${clock(notifyStop.windowStart)}–${clock(notifyStop.windowEnd)}`,
        draft: { to: notifyStop.recipient, channel: "sms", text: `Hi ${notifyStop.recipient.split(" ")[0]}, this is Vamo. Your delivery is running a little behind, new ETA around ${eta}. Your order stays cold-packed; we'll text when the driver is close. Reply here if you need a different time.` },
      });
    }

    if (has("unassigned") || has("driver_cancelled")) {
      for (const cand of this.availableDrivers(route).slice(0, 2)) {
        actions.push({
          id: `assign_driver:${cand.id}`, kind: "assign_driver",
          label: `Assign ${cand.name}`,
          detail: `${cand.zone}, ${Math.round(cand.stats.onTimeRate * 100)}% on time, ${cand.stats.incidentsLast30d} incidents in 30d`,
          draft: { to: cand.name, channel: "sms", text: `Hi ${cand.name.split(" ")[0]}, can you take ${route.code}? Pickup ${clock(route.scheduledPickupAt)} at ${route.pickupSite}, ${stops.length} stops. Reply YES to confirm.` },
        });
      }
    }

    if (driver && (has("driver_quiet") || has("driver_stalled"))) {
      actions.push({
        id: "call_driver", kind: "call_driver",
        label: `Call ${driver.name}`,
        detail: `${driver.phone}. Last ping ${route.lastPingAt ? fmtMin((this.now - route.lastPingAt) / MINUTE) + " ago" : "never"}`,
      });
    }

    if (has("far_delivery") && driver) {
      const far = stops.find((s) => (s.deliveredDistanceM ?? 0) > THRESHOLDS.farDeliveryM)!;
      actions.push({
        id: "request_pod_review", kind: "request_pod_review",
        label: `Ask ${driver.name.split(" ")[0]} where stop ${far.seq} was left`,
        detail: `Marked ${far.deliveredDistanceM}m from ${far.address}. Confirm before the customer calls.`,
        draft: { to: driver.name, channel: "sms", text: `Hi ${driver.name.split(" ")[0]}, stop ${far.seq} (${far.address}, order ${far.orderId}) shows delivered ${far.deliveredDistanceM}m from the address. Where exactly did you leave it? Any detail helps.` },
      });
    }

    if (c.level === "critical") {
      actions.push({
        id: "escalate", kind: "escalate",
        label: "Escalate to shift lead",
        detail: "Posts the case summary to #ops-leads",
        draft: { to: "#ops-leads", channel: "slack", text: `${route.code} (${c.customerNames.join(", ")}): ${c.reason}. Need a call on reassign vs. reschedule.` },
      });
    }
    return actions;
  }

  applyAction(caseId: string, actionId: string, text?: string): void {
    const route = this.routes.get(caseId.replace(/^case-/, ""));
    const summary = route ? this.summarize(route) : null;
    if (!route || !summary) throw new NotFound(`Case ${caseId} not found`);
    const action = this.actionsFor(route, summary).find((a) => a.id === actionId);
    if (!action) throw new NotFound(`Action ${actionId} is no longer available`);
    const body = text ?? action.draft?.text;
    const ev = (e: Omit<TimelineEvent, "id" | "routeId" | "at">) => this.addEvent({ routeId: route.id, at: this.now, ...e });

    switch (action.kind) {
      case "reassign": {
        const candidate = this.availableDrivers(route)[0]!;
        const moved = this.stopsOf(route).filter((s) => summary.risk.atRiskStopIds.includes(s.id) && !s.handedTo);
        moved.forEach((s, i) => {
          s.handedTo = candidate.name;
          s.eta = this.now + (15 + i * 10) * MINUTE;
        });
        ev({ source: "operator", actor: OPERATOR, text: `Reassigned stop${moved.length > 1 ? "s" : ""} ${moved.map((s) => s.seq).join(", ")} to ${candidate.name} (cargo transfer, TIV clock continues)` });
        break;
      }
      case "reorder": {
        const plan = this.reorderPlan(route)!;
        const seqs = plan.order.map((s) => s.seq).sort((a, b) => a - b);
        plan.order.forEach((s, i) => {
          s.seq = seqs[i]!;
          s.eta = plan.etas.get(s.id)!;
        });
        ev({ source: "operator", actor: OPERATOR, text: `Reordered remaining stops, perishables first. Driver app updated` });
        break;
      }
      case "notify_customer":
      case "request_pod_review":
        ev({ source: "sms", direction: "out", actor: OPERATOR, text: `To ${action.draft!.to}: ${body}` });
        break;
      case "assign_driver": {
        const driverId = actionId.split(":")[1]!;
        const d = this.drivers.get(driverId)!;
        route.driverId = d.id;
        route.status = "assigned";
        route.driverCancelledAt = undefined;
        route.sim = "normal";
        ev({ source: "sms", direction: "out", actor: OPERATOR, text: `To ${d.name}: ${body}` });
        ev({ source: "status", actor: d.name, text: `${d.name} accepted the route` });
        break;
      }
      case "call_driver":
        ev({ source: "call", direction: "out", actor: OPERATOR, text: `Called ${route.driverId ? this.drivers.get(route.driverId)!.name : "driver"} (mocked call)` });
        break;
      case "escalate":
        ev({ source: "slack", actor: OPERATOR, text: `#ops-leads: ${body}` });
        break;
    }
    this.touch(caseId);
    this.sync();
  }

  // ---------------------------------------------------------------------------
  // Proof of delivery and handoff
  // ---------------------------------------------------------------------------

  podPack(stopId: string) {
    const stop = this.stops.get(stopId);
    if (!stop || stop.deliveredAt === undefined) throw new NotFound("Stop not delivered");
    const route = this.routes.get(stop.routeId)!;
    const customer = this.customers.get(stop.customerId)!;
    const risk = this.riskOf(route).stops.find((r) => r.stopId === stopId)!;
    return {
      orderId: stop.orderId,
      routeCode: route.code,
      customer: customer.name,
      recipient: stop.recipient,
      address: stop.address,
      driver: route.driverId ? this.drivers.get(route.driverId)!.name : stop.handedTo ?? "unknown",
      cargo: stop.cargo,
      photo: stop.hasPhoto ?? false,
      deliveredAt: stop.deliveredAt,
      distanceM: stop.deliveredDistanceM ?? null,
      distanceOk: (stop.deliveredDistanceM ?? 0) <= THRESHOLDS.farDeliveryM,
      window: { start: stop.windowStart, end: stop.windowEnd },
      inWindow: stop.deliveredAt >= stop.windowStart && stop.deliveredAt <= stop.windowEnd,
      tiv: { loadedAt: route.loadedAt, atDeliveryMin: risk.tivAtStopMin, budgetMin: risk.budgetMin, withinBudget: risk.budgetMin === null || (risk.marginMin ?? 0) >= 0 },
    };
  }

  handoff(): string {
    const { cases } = this.listCases({ status: "active" });
    const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
    const critical = cases.filter((c) => c.level === "critical").length;
    const lines = [
      `Shift handoff, ${clock(this.now)} ET`,
      `${cases.length} open cases (${critical} critical). ${cases.filter((c) => c.status === "in_progress").length} claimed, ${cases.filter((c) => c.status === "open").length} unclaimed.`,
      "",
      ...cases.slice(0, 8).map((c, i) => `${i + 1}. [${c.level.toUpperCase()}] ${c.routeCode} ${c.driverName ?? "(no driver)"}: ${c.reason}${c.claimedBy ? ` (owner: ${c.claimedBy})` : ""}`),
    ];
    const promises = this.events.filter((e) => e.source === "sms" && e.direction === "out" && e.actor === OPERATOR && this.now - e.at < 120 * MINUTE);
    if (promises.length) {
      lines.push("", "Promises made to customers/drivers in the last 2h:");
      for (const p of promises) lines.push(`- ${clock(p.at)} ${this.routes.get(p.routeId)!.code}: ${p.text}`);
    }
    const pendingDrafts = this.messages.filter((m) => m.status === "pending");
    if (pendingDrafts.length) lines.push("", `${pendingDrafts.length} inbound message(s) still waiting on a reply.`);
    return lines.join("\n");
  }
}

export class NotFound extends Error {}
