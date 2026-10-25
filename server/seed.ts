// Deterministic seed: ~40 routes in Miami, most healthy, plus 8 hand-crafted case stories.
// Every time is relative to `now`, so the demo replays identically from any anchor.
import { MINUTE } from "../shared/tiv";
import type {
  CargoClass, Customer, Driver, DriverPosition, InboundMessage, Route, RouteStatus, SimMode, Stop, TimelineEvent,
} from "../shared/types";

export interface SeedData {
  now: number;
  customers: Customer[];
  drivers: Driver[];
  routes: Route[];
  stops: Stop[];
  events: TimelineEvent[];
  messages: InboundMessage[];
}

export const DEFAULT_SEED_NOW = "2026-10-23T19:30:00Z"; // 3:30pm in Miami, mid afternoon wave

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CUSTOMERS: Customer[] = [
  { id: "c-freshfit", name: "FreshFit Meals", kind: "meal-prep" },
  { id: "c-verde", name: "Verde Kitchen", kind: "restaurant", tivBudgets: { chilled: 75 } },
  { id: "c-mercado", name: "Mercado Sol Grocers", kind: "grocer" },
  { id: "c-preppal", name: "PrepPal", kind: "meal-prep", tivBudgets: { frozen: 50 } },
  { id: "c-bayside", name: "Bayside Poke", kind: "restaurant", tivBudgets: { chilled: 60 } },
  { id: "c-harvest", name: "Harvest Lane Market", kind: "grocer" },
];

const PICKUP_SITE: Record<string, string> = {
  "c-freshfit": "FreshFit Commissary, Doral",
  "c-verde": "Verde Kitchen, Wynwood",
  "c-mercado": "Mercado Sol DC, Hialeah",
  "c-preppal": "PrepPal Kitchen, Little Havana",
  "c-bayside": "Bayside Poke, Edgewater",
  "c-harvest": "Harvest Lane, Coral Gables",
};

const ORDER_PREFIX: Record<string, string> = {
  "c-freshfit": "FF", "c-verde": "VK", "c-mercado": "MS", "c-preppal": "PP", "c-bayside": "BP", "c-harvest": "HL",
};

const DRIVER_NAMES: Array<[string, string]> = [
  ["Kevin Nguyen", "Doral"], ["Jomar dela Cruz", "Wynwood"], ["Tyler Brooks", "Coral Gables"],
  ["Marisol Reyes", "Brickell"], ["Jessa Santos", "Doral"], ["DeShawn Carter", "Edgewater"],
  ["Lucía Morales", "Coral Gables"], ["Carlos Mendoza", "Hialeah"], ["Ana Paula Ferreira", "Brickell"],
  ["Rafael Gutiérrez", "Little Havana"], ["Brianna Lee", "Wynwood"], ["Mark Villanueva", "Hialeah"],
  ["Emily Chen", "Coral Gables"], ["Diego Herrera", "Brickell"], ["Ramon Bautista", "Doral"],
];

const ADDRESSES = [
  "1450 Brickell Ave, Apt 3104", "88 NE 29th St", "2121 SW 3rd Ave, Unit 9", "640 Coral Way", "3301 NE 1st Ave, Apt 1207",
  "1800 NW 7th St", "255 Aragon Ave", "4120 Ponce de Leon Blvd", "901 S Miami Ave, Apt 2210", "75 SW 8th St, Apt 1902",
  "2600 Biscayne Blvd", "1250 S Miami Ave, Apt 410", "3535 Main Hwy", "7300 NW 36th St", "150 Giralda Ave",
  "1001 NW 42nd Ave", "520 W 41st St", "2000 N Bayshore Dr, Apt 1801", "6001 SW 70th St", "320 NE 61st St",
  "1700 Collins Ave, Apt 5", "980 Alton Rd", "4801 E 4th Ave, Hialeah", "2450 Hollywood Blvd", "11200 NW 25th St, Doral",
  "8350 NW 52nd Ter, Doral", "3480 Main Hwy, Apt 2", "120 SW 26th Rd", "450 NW 27th St", "2900 NE 7th Ave, Apt 3006",
  "1360 S Dixie Hwy", "5600 Collins Ave", "333 NE 24th St, Apt 802", "18 SE 13th St", "1111 SW 1st Ave, Apt 2615",
  "7500 SW 61st Ave", "2525 SW 27th Ave", "601 NE 39th St", "4000 Towerside Ter", "190 NE 46th St",
];

const RECIPIENTS = [
  "Sarah Mitchell", "Andrés Castillo", "Priya Raman", "Jake Thompson", "María José Ortega", "Chris Park", "Nicole Alvarez",
  "Benjamin Ortiz", "Grace Domingo", "Luis Fernández", "Hannah Cohen", "Daniela Rojas", "Patrick O'Neil", "Camila Duarte",
  "Joshua Reid", "Isabel Navarro", "Kenji Watanabe", "Valentina Cruz", "Michael Brennan", "Paolo Santiago", "Rachel Gold",
  "Juan Pablo Mejía", "Tiffany Wu", "Omar Haddad", "Lauren Fischer", "Gabriel Souza", "Ashley Morgan", "Mateo Vargas",
  "Erin Walsh", "Sofía Guerrero", "Derek Palmer", "Maricel Aquino", "Steven Kim", "Paula Herrera", "Natalie Brooks",
  "Rodrigo Lima", "Jasmine Patel", "Francisco Ruiz", "Megan O'Connor", "Ricardo Salinas",
];

// `process` does not exist when the store runs in the browser (static deploy).
const envSeedNow = typeof process !== "undefined" ? process.env.SEED_NOW : undefined;

export function buildSeed(nowIso: string = envSeedNow || DEFAULT_SEED_NOW): SeedData {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) throw new Error(`Invalid SEED_NOW: ${nowIso}`);
  const rand = mulberry32(42);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const t = (min: number) => now + Math.round(min * MINUTE);

  const drivers: Driver[] = DRIVER_NAMES.map(([name, zone], i) => buildDriver(i, name, zone, now, rand));
  const driverByName = (name: string) => drivers.find((d) => d.name === name)!;

  const routes: Route[] = [];
  const stops: Stop[] = [];
  const events: TimelineEvent[] = [];
  const messages: InboundMessage[] = [];
  let eventSeq = 0;
  let orderSeq = 81200;
  let addrIdx = 0;
  let recipIdx = 0;

  const ev = (e: Omit<TimelineEvent, "id">) => events.push({ id: `ev-${++eventSeq}`, ...e });

  interface StopSpec {
    cargo: CargoClass;
    /** Minutes from now: ETA for pending stops, delivery time for delivered ones. */
    at: number;
    delivered?: boolean;
    arrived?: number; // minutes from now when the driver arrived (stop still pending)
    window?: [number, number];
    distanceM?: number;
    customerId?: string;
    recipient?: string;
    address?: string;
    orderId?: string;
    bags?: number;
    notes?: string;
  }

  interface RouteSpec {
    id: string;
    customerId: string;
    driver: string | null;
    status: RouteStatus;
    pickupAt: number; // minutes from now
    loadedAt: number | null;
    sim?: SimMode;
    position?: DriverPosition;
    lastPing?: number | null;
    lastMoved?: number | null;
    lastMsg?: number | null;
    cancelledAt?: number;
    stops: StopSpec[];
  }

  const addRoute = (spec: RouteSpec): Route => {
    const routeStops = spec.stops.map((s, i): Stop => {
      const cust = s.customerId ?? spec.customerId;
      const windowLen = cust === "c-verde" || cust === "c-bayside" ? 45 : cust === "c-mercado" || cust === "c-harvest" ? 60 : 120;
      const [ws, we] = s.window ?? [Math.floor((s.at - windowLen / 2) / 15) * 15, Math.floor((s.at - windowLen / 2) / 15) * 15 + windowLen];
      const stop: Stop = {
        id: `${spec.id}-s${i + 1}`,
        routeId: spec.id,
        seq: i + 1,
        orderId: s.orderId ?? `${ORDER_PREFIX[cust]}-${orderSeq++}`,
        customerId: cust,
        recipient: s.recipient ?? RECIPIENTS[recipIdx++ % RECIPIENTS.length]!,
        recipientPhone: `+1 305 555 ${String(1000 + ((recipIdx * 37 + i * 11) % 9000)).padStart(4, "0")}`,
        address: s.address ?? ADDRESSES[addrIdx++ % ADDRESSES.length]!,
        cargo: s.cargo,
        bags: s.bags ?? 1 + Math.floor(rand() * 3),
        windowStart: t(ws),
        windowEnd: t(we),
        eta: s.delivered ? null : t(s.at),
        status: s.delivered ? "delivered" : s.arrived !== undefined ? "arrived" : "pending",
        notes: s.notes,
      };
      if (s.delivered) {
        stop.deliveredAt = t(s.at);
        stop.hasPhoto = true;
        stop.deliveredDistanceM = s.distanceM ?? 5 + Math.floor(rand() * 40);
      }
      if (s.arrived !== undefined) stop.arrivedAt = t(s.arrived);
      return stop;
    });
    stops.push(...routeStops);

    const firstPending = routeStops.find((s) => s.status !== "delivered");
    const defaultPosition: DriverPosition =
      spec.status === "completed" || spec.status === "unassigned" || spec.status === "assigned" ? { kind: "none" } :
      spec.loadedAt === null ? { kind: "pickup" } :
      firstPending ? { kind: "enroute", toStopId: firstPending.id, progress: 0.5 } : { kind: "none" };

    const route: Route = {
      id: spec.id,
      code: spec.id.replace("r-", "R-"),
      driverId: spec.driver ? driverByName(spec.driver).id : null,
      pickupSite: PICKUP_SITE[spec.customerId]!,
      scheduledPickupAt: t(spec.pickupAt),
      loadedAt: spec.loadedAt === null ? null : t(spec.loadedAt),
      status: spec.status,
      stopIds: routeStops.map((s) => s.id),
      position: spec.position ?? defaultPosition,
      lastPingAt: spec.lastPing === undefined ? (spec.status === "in_progress" || spec.status === "at_pickup" ? t(-1) : null) : spec.lastPing === null ? null : t(spec.lastPing),
      lastMovedAt: spec.lastMoved === undefined ? (spec.status === "in_progress" ? t(-2) : null) : spec.lastMoved === null ? null : t(spec.lastMoved),
      lastDriverMessageAt: spec.lastMsg == null ? null : t(spec.lastMsg),
      driverCancelledAt: spec.cancelledAt === undefined ? undefined : t(spec.cancelledAt),
      sim: spec.sim ?? "normal",
    };
    routes.push(route);

    // Baseline timeline every route gets: assignment, load scan, deliveries.
    const driverName = spec.driver ?? "Unassigned";
    ev({ routeId: route.id, at: t(spec.pickupAt - 180), source: "system", actor: "Vamo", text: `Route created: ${routeStops.length} stops, pickup ${PICKUP_SITE[spec.customerId]}` });
    ev({ routeId: route.id, at: t(spec.pickupAt - 170), source: "sms", direction: "out", actor: "Vamo", text: `Morning window texts sent to ${routeStops.length} recipients` });
    if (spec.driver) ev({ routeId: route.id, at: t(spec.pickupAt - 120), source: "status", actor: driverName, text: `${driverName} accepted the route` });
    if (route.loadedAt !== null) {
      ev({ routeId: route.id, at: route.loadedAt, source: "status", actor: driverName, text: `Cargo scanned out of cold storage (${routeStops.reduce((n, s) => n + s.bags, 0)} bags). TIV clock started` });
    }
    for (const s of routeStops) {
      if (s.arrivedAt) ev({ routeId: route.id, stopId: s.id, at: s.arrivedAt, source: "gps", actor: driverName, text: `Arrived at stop ${s.seq}, ${s.address}` });
      if (s.deliveredAt) ev({ routeId: route.id, stopId: s.id, at: s.deliveredAt, source: "status", actor: driverName, text: `Stop ${s.seq} delivered with photo (${s.deliveredDistanceM}m from address)` });
    }
    return route;
  };

  const message = (m: Omit<InboundMessage, "id" | "triage" | "status" | "linkedBy"> & { linkedBy?: string }) => {
    messages.push({ id: `msg-${messages.length + 1}`, triage: null, status: "pending", linkedBy: m.linkedBy ?? "sender phone", ...m });
    ev({ routeId: m.routeId!, stopId: m.stopId ?? undefined, at: m.at, source: m.channel, direction: "in", actor: m.fromName, text: m.text });
  };

  // ---------------------------------------------------------------------------
  // The 8 planted stories
  // ---------------------------------------------------------------------------

  // 1. Projected TIV breach: everything looks fine, but frozen stop 5 lands 6m past its 60m budget.
  addRoute({
    id: "r-2101", customerId: "c-freshfit", driver: "Kevin Nguyen", status: "in_progress", pickupAt: -25, loadedAt: -22, sim: "slipping",
    stops: [
      { cargo: "frozen", at: -8, delivered: true },
      { cargo: "frozen", at: 4 },
      { cargo: "chilled", at: 14 },
      { cargo: "frozen", at: 26 },
      { cargo: "frozen", at: 44, recipient: "Priya Raman", address: "640 Coral Way" },
      { cargo: "chilled", at: 52 },
    ],
  });

  // 2. Stalled at pickup: bags handed over 28m ago, driver still waiting on the kitchen.
  addRoute({
    id: "r-2102", customerId: "c-verde", driver: "Jomar dela Cruz", status: "at_pickup", pickupAt: -30, loadedAt: -28, sim: "stuck",
    position: { kind: "pickup" }, lastPing: -1, lastMoved: -26, lastMsg: -15,
    stops: [
      { cargo: "chilled", at: 6 }, { cargo: "chilled", at: 18 }, { cargo: "chilled", at: 31 }, { cargo: "chilled", at: 50 },
    ],
  });
  ev({ routeId: "r-2102", at: t(-27), source: "gps", actor: "Jomar dela Cruz", text: "Checked in at Verde Kitchen, Wynwood" });
  ev({ routeId: "r-2102", at: t(-15), source: "sms", direction: "in", actor: "Jomar dela Cruz", text: "Still at Verde, they gave me 9 bags but 2 for stop 3 not ready yet. Kitchen says 10 more min" });
  ev({ routeId: "r-2102", at: t(-14), source: "slack", actor: "Andrea (ops, PH shift)", text: "#ops-miami: anyone pinged Verde about the 2 missing bags on R-2102?" });

  // 3. Driver went quiet mid-route with chilled cargo aboard.
  addRoute({
    id: "r-2103", customerId: "c-harvest", driver: "Tyler Brooks", status: "in_progress", pickupAt: -70, loadedAt: -68, sim: "quiet",
    lastPing: -31, lastMoved: -31,
    stops: [
      { cargo: "chilled", at: -42, delivered: true }, { cargo: "chilled", at: -33, delivered: true },
      { cargo: "chilled", at: -4 }, { cargo: "chilled", at: 10 }, { cargo: "chilled", at: 24 },
    ],
  });
  ev({ routeId: "r-2103", at: t(-31), source: "gps", actor: "Tyler Brooks", text: "Last GPS ping near SW 27th Ave & US-1 (heading to stop 3)" });
  ev({ routeId: "r-2103", at: t(-12), source: "sms", direction: "out", actor: "Vamo", text: "Automated: running late text sent to stop 3 recipient" });

  // 4. Building inaccessible: frozen stop, driver at the door 14 minutes, ETA for stop 4 keeps slipping.
  const s4 = addRoute({
    id: "r-2104", customerId: "c-preppal", driver: "Marisol Reyes", status: "in_progress", pickupAt: -33, loadedAt: -30, sim: "stuck",
    lastPing: -1, lastMoved: -14, lastMsg: -6,
    stops: [
      { cargo: "frozen", at: -22, delivered: true },
      { cargo: "frozen", at: -16, delivered: true },
      { cargo: "frozen", at: 2, arrived: -14, recipient: "Sarah Mitchell", address: "1450 Brickell Ave, Apt 3104" },
      { cargo: "frozen", at: 16 },
    ],
  });
  s4.position = { kind: "at_stop", stopId: "r-2104-s3" };
  message({
    at: t(-6), fromRole: "driver", fromName: "Marisol Reyes", fromPhone: driverByName("Marisol Reyes").phone, channel: "sms",
    routeId: "r-2104", stopId: "r-2104-s3",
    text: "At 1450 Brickell for stop 3. Gate code 4471 doesn't work and nobody at the front desk. Customer not answering. It's the frozen bag, what do I do?",
  });

  // 5. Missing bag on a tight meal-prep window.
  addRoute({
    id: "r-2105", customerId: "c-freshfit", driver: "Jessa Santos", status: "in_progress", pickupAt: -15, loadedAt: -12,
    lastMsg: -4,
    stops: [
      { cargo: "frozen", at: 6 },
      { cargo: "frozen", at: 12, window: [-40, 20], orderId: "FF-88213", recipient: "Andrés Castillo", bags: 3 },
      { cargo: "chilled", at: 25 },
      { cargo: "chilled", at: 38 },
    ],
  });
  message({
    at: t(-4), fromRole: "driver", fromName: "Jessa Santos", fromPhone: driverByName("Jessa Santos").phone, channel: "sms",
    routeId: "r-2105", stopId: "r-2105-s2",
    text: "Order FF-88213 for stop 2 only has 2 of 3 bags, the frozen one is missing. Already left the commissary, 10 min out",
  });

  // 6. Unassigned route near pickup after a driver cancellation.
  addRoute({
    id: "r-2106", customerId: "c-mercado", driver: null, status: "unassigned", pickupAt: 35, loadedAt: null, cancelledAt: -20,
    stops: [{ cargo: "chilled", at: 60 }, { cargo: "ambient", at: 72 }, { cargo: "chilled", at: 85 }, { cargo: "chilled", at: 97 }],
  });
  ev({ routeId: "r-2106", at: t(-20), source: "status", actor: "Ramon Bautista", text: "Ramon Bautista cancelled the route (reason: car trouble)" });
  ev({ routeId: "r-2106", at: t(-18), source: "slack", actor: "Andrea (ops, PH shift)", text: "#dispatch: R-2106 open again, Hialeah 4:05pm pickup, need someone" });

  // 7. Delivered 420m from the address: future "never got it" complaint.
  addRoute({
    id: "r-2107", customerId: "c-bayside", driver: "DeShawn Carter", status: "in_progress", pickupAt: -45, loadedAt: -40,
    stops: [
      { cargo: "chilled", at: -30, delivered: true },
      { cargo: "chilled", at: -25, delivered: true, distanceM: 420, recipient: "Chris Park", address: "88 NE 29th St", orderId: "BP-40517" },
      { cargo: "chilled", at: 9 },
    ],
  });

  // 8. "Where's my order?" on ambient, on-time cargo. Must rank low.
  addRoute({
    id: "r-2108", customerId: "c-harvest", driver: "Lucía Morales", status: "in_progress", pickupAt: -20, loadedAt: -18,
    stops: [
      { cargo: "ambient", at: -5, delivered: true },
      { cargo: "ambient", at: 20, window: [-20, 40], recipient: "Nicole Alvarez", address: "255 Aragon Ave" },
      { cargo: "ambient", at: 34 },
    ],
  });
  const wismoStop = stops.find((s) => s.id === "r-2108-s2")!;
  message({
    at: t(-5), fromRole: "customer", fromName: wismoStop.recipient, fromPhone: wismoStop.recipientPhone, channel: "sms",
    routeId: "r-2108", stopId: wismoStop.id,
    text: "Hi where's my order? Tracking says around 3:50 but I have to leave by 4:30",
  });

  // Hidden escalation: healthy now, crosses the 70% chilled warning after "Advance 30 min".
  addRoute({
    id: "r-2027", customerId: "c-mercado", driver: "Carlos Mendoza", status: "in_progress", pickupAt: -42, loadedAt: -40,
    stops: [{ cargo: "chilled", at: 10 }, { cargo: "chilled", at: 25 }, { cargo: "chilled", at: 42 }],
  });

  // ---------------------------------------------------------------------------
  // Healthy background traffic
  // ---------------------------------------------------------------------------
  const custIds = CUSTOMERS.map((c) => c.id);
  const cargoFor = (cust: string): CargoClass =>
    cust === "c-freshfit" || cust === "c-preppal" ? pick(["frozen", "frozen", "chilled"] as const) :
    cust === "c-mercado" || cust === "c-harvest" ? pick(["chilled", "ambient", "ambient"] as const) : "chilled";

  // Morning routes, completed cleanly.
  const morningDrivers = ["Ana Paula Ferreira", "Rafael Gutiérrez", "Brianna Lee", "Mark Villanueva", "Emily Chen", "Diego Herrera",
    "Kevin Nguyen", "Tyler Brooks", "Marisol Reyes", "Carlos Mendoza", "Lucía Morales", "Jessa Santos", "DeShawn Carter"];
  morningDrivers.forEach((driver, i) => {
    const cust = custIds[i % custIds.length]!;
    const load = -300 + i * 12;
    addRoute({
      id: `r-19${String(i + 1).padStart(2, "0")}`, customerId: cust, driver, status: "completed", pickupAt: load - 3, loadedAt: load,
      stops: [0, 1, 2].map((k) => ({ cargo: cargoFor(cust), at: load + 9 + k * 10, delivered: true })),
    });
  });

  // In-progress, comfortably inside budget and window.
  ["Ana Paula Ferreira", "Rafael Gutiérrez", "Brianna Lee", "Mark Villanueva", "Emily Chen"].forEach((driver, i) => {
    const cust = custIds[(i + 2) % custIds.length]!;
    const load = -6 - i * 3;
    addRoute({
      id: `r-20${String(i + 31)}`, customerId: cust, driver, status: "in_progress", pickupAt: load - 2, loadedAt: load,
      stops: [0, 1, 2].map((k) => ({ cargo: cargoFor(cust), at: load + 10 + k * 9 + Math.floor(rand() * 3) })),
    });
  });

  // Upcoming evening wave, already assigned.
  const eveningDrivers = ["Diego Herrera", "Ana Paula Ferreira", "Rafael Gutiérrez", "Brianna Lee", "Mark Villanueva", "Emily Chen",
    "Kevin Nguyen", "Carlos Mendoza", "Lucía Morales", "DeShawn Carter", "Jessa Santos", "Marisol Reyes"];
  eveningDrivers.forEach((driver, i) => {
    const cust = custIds[(i + 1) % custIds.length]!;
    const pickupAt = (driver === "Diego Herrera" ? 150 : 75) + i * 10;
    const n = 2 + (i % 2);
    addRoute({
      id: `r-22${String(i + 1).padStart(2, "0")}`, customerId: cust, driver, status: "assigned", pickupAt, loadedAt: null,
      stops: Array.from({ length: n }, (_, k) => ({ cargo: cargoFor(cust), at: pickupAt + 12 + k * 10 })),
    });
  });

  events.sort((a, b) => a.at - b.at);
  return { now, customers: CUSTOMERS, drivers, routes, stops, events, messages };
}

function buildDriver(i: number, name: string, zone: string, now: number, rand: () => number): Driver {
  const day = (d: number) => new Date(now - d * 86_400_000).toISOString().slice(0, 10);
  // A couple of drivers get a rougher history so the context panel has something to say.
  const shaky = name === "Tyler Brooks" || name === "Jomar dela Cruz";
  const history = Array.from({ length: 5 }, (_, k) => {
    const roll = rand();
    const outcome: "clean" | "late" | "incident" = shaky && k === 1 ? "incident" : roll < (shaky ? 0.35 : 0.12) ? "late" : "clean";
    return {
      date: day(k + 1),
      routeCode: `R-${1700 + i * 7 + k * 31}`,
      stops: 3 + Math.floor(rand() * 4),
      outcome,
      note: outcome === "incident" ? (name === "Tyler Brooks" ? "Unreachable 35 min mid-route (phone died)" : "Left pickup 25 min late, kitchen delay") : undefined,
    };
  });
  return {
    id: `d-${i + 1}`,
    name,
    phone: `+1 786 555 ${String(2100 + i * 13).padStart(4, "0")}`,
    zone,
    stats: {
      routesLast30d: 14 + Math.floor(rand() * 16),
      onTimeRate: shaky ? 0.81 + rand() * 0.05 : 0.9 + rand() * 0.08,
      incidentsLast30d: shaky ? 2 + Math.floor(rand() * 2) : Math.floor(rand() * 2),
      avgRating: Math.round((shaky ? 4.3 : 4.6 + rand() * 0.35) * 10) / 10,
    },
    history,
  };
}
