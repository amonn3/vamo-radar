// Domain types shared by server and web. Times are epoch milliseconds on the simulated clock.

export type CargoClass = "frozen" | "chilled" | "ambient";
export type CustomerKind = "meal-prep" | "restaurant" | "grocer";

export interface Customer {
  id: string;
  name: string;
  kind: CustomerKind;
  /** Minutes of Time-in-Vehicle tolerated per cargo class; overrides the defaults. */
  tivBudgets?: Partial<Record<CargoClass, number>>;
}

export interface DriverStats {
  routesLast30d: number;
  onTimeRate: number; // 0..1
  incidentsLast30d: number;
  avgRating: number; // 1..5
}

export interface DriverRouteHistory {
  date: string; // YYYY-MM-DD
  routeCode: string;
  stops: number;
  outcome: "clean" | "late" | "incident";
  note?: string;
}

export interface Driver {
  id: string;
  name: string;
  phone: string;
  zone: string;
  stats: DriverStats;
  history: DriverRouteHistory[];
}

export type StopStatus = "pending" | "arrived" | "delivered" | "failed";

export interface Stop {
  id: string;
  routeId: string;
  seq: number;
  orderId: string;
  customerId: string;
  recipient: string;
  recipientPhone: string;
  address: string;
  cargo: CargoClass;
  bags: number;
  windowStart: number;
  windowEnd: number;
  /** Live ETA from the driver app; null once delivered. */
  eta: number | null;
  status: StopStatus;
  arrivedAt?: number;
  deliveredAt?: number;
  hasPhoto?: boolean;
  /** Distance between the "delivered" GPS fix and the address, in meters. */
  deliveredDistanceM?: number;
  notes?: string;
  /** Set when stops are handed to another driver; the simulator then delivers them on ETA. */
  handedTo?: string;
}

export type RouteStatus = "unassigned" | "assigned" | "at_pickup" | "in_progress" | "completed";

/** Where the driver is, in route-strip terms (we deliberately avoid real maps). */
export type DriverPosition =
  | { kind: "none" }
  | { kind: "pickup" }
  | { kind: "enroute"; toStopId: string; progress: number }
  | { kind: "at_stop"; stopId: string };

/** How the simulator moves this route when the clock advances. */
export type SimMode =
  | "normal" // delivers on ETA
  | "slipping" // delivers, but ETAs drift later (traffic)
  | "stuck" // pings but does not move; ETAs slide with the clock
  | "quiet"; // no pings, no movement

export interface Route {
  id: string;
  code: string;
  driverId: string | null;
  pickupSite: string;
  scheduledPickupAt: number;
  /** When cargo left cold storage. TIV starts here. */
  loadedAt: number | null;
  status: RouteStatus;
  stopIds: string[];
  position: DriverPosition;
  lastPingAt: number | null;
  lastMovedAt: number | null;
  lastDriverMessageAt: number | null;
  driverCancelledAt?: number;
  sim: SimMode;
}

export type EventSource = "gps" | "status" | "alert" | "sms" | "call" | "slack" | "operator" | "system";

export interface TimelineEvent {
  id: string;
  routeId: string;
  stopId?: string;
  at: number;
  source: EventSource;
  direction?: "in" | "out";
  actor: string;
  text: string;
}

// ---- Detection ----

export type SignalType =
  | "tiv_current"
  | "tiv_projected"
  | "tiv_breached"
  | "driver_stalled"
  | "driver_quiet"
  | "late_pickup"
  | "unassigned"
  | "eta_past_window"
  | "far_delivery"
  | "driver_cancelled"
  | "inbound";

export interface Signal {
  type: SignalType;
  /** Stable key so the same problem is not re-announced on every recompute. */
  key: string;
  stopIds: string[];
  detail: string;
  /** Base urgency on a 0-10 scale before cargo weighting (TIV signals use margin instead). */
  urgency: number;
  messageCategory?: MessageCategory;
}

// ---- TIV ----

export type RiskLevel = "ok" | "warn" | "critical";

export interface StopRisk {
  stopId: string;
  cargo: CargoClass;
  budgetMin: number | null;
  /** TIV at delivery (actual for delivered stops, projected from ETA for pending ones). */
  tivAtStopMin: number | null;
  /** budget - tivAtStop. Negative means a (projected) breach. */
  marginMin: number | null;
  level: RiskLevel;
  projectedBreach: boolean;
}

export interface RouteRisk {
  elapsedMin: number | null;
  /** Budget of the most sensitive cargo still aboard. */
  activeBudgetMin: number | null;
  usedPct: number | null;
  /** Minutes until elapsed TIV hits the active budget. */
  minutesToBreach: number | null;
  currentLevel: RiskLevel;
  stops: StopRisk[];
  /** Smallest margin across pending sensitive stops (current or projected). */
  worstMarginMin: number | null;
  worstStopId: string | null;
  atRiskStopIds: string[];
}

// ---- Cases ----

export type CaseStatus = "open" | "in_progress" | "resolved";
export type ResolutionCode =
  | "delivered_ok"
  | "customer_notified"
  | "reassigned"
  | "redelivery_scheduled"
  | "false_alarm"
  | "escalated"
  | "other";

export interface CaseNote {
  at: number;
  author: string;
  text: string;
}

export interface CaseSummary {
  id: string;
  routeId: string;
  routeCode: string;
  driverName: string | null;
  customerNames: string[];
  primaryType: SignalType;
  signals: Signal[];
  cargo: CargoClass; // most sensitive cargo still at risk / aboard
  status: CaseStatus;
  claimedBy: string | null;
  priority: number;
  level: RiskLevel;
  reason: string;
  risk: RouteRisk;
  affectedStopIds: string[];
  openedAt: number;
  lastTouchedAt: number | null;
  pendingMessages: number;
}

export interface SuggestedAction {
  id: string;
  kind: "reassign" | "reorder" | "notify_customer" | "escalate" | "assign_driver" | "call_driver" | "request_pod_review";
  label: string;
  detail: string;
  /** Draft message requiring human approval, if the action sends something. */
  draft?: { to: string; channel: "sms" | "slack"; text: string };
}

export type MessageCategory =
  | "building_access"
  | "wrong_address"
  | "missing_bag"
  | "stuck_at_pickup"
  | "stop_order"
  | "driver_quiet"
  | "wismo"
  | "pod_request"
  | "pay_question"
  | "other";

export interface Triage {
  category: MessageCategory;
  confidence: number;
  engine: "ai" | "rules";
  summary: string;
  recommendedAction: string;
  draft: { to: string; toRole: "driver" | "customer" | "business"; text: string };
}

export interface InboundMessage {
  id: string;
  at: number;
  fromRole: "driver" | "customer" | "business";
  fromName: string;
  fromPhone: string;
  channel: "sms" | "call" | "slack";
  text: string;
  routeId: string | null;
  stopId: string | null;
  linkedBy: string;
  triage: Triage | null;
  status: "pending" | "sent" | "dismissed";
}

export interface CaseDetail extends CaseSummary {
  route: Route;
  stops: Stop[];
  driver: Driver | null;
  customers: Customer[];
  timeline: TimelineEvent[];
  messages: InboundMessage[];
  actions: SuggestedAction[];
  notes: CaseNote[];
  resolution: { code: ResolutionCode; at: number } | null;
}

export interface ClockState {
  now: number;
  aiEnabled: boolean;
}
