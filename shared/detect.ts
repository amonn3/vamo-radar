// Turns raw route state into signals before anyone calls in. Pure: same input, same output.
import { MINUTE } from "./tiv";
import type { Route, RouteRisk, Signal, Stop } from "./types";

export const THRESHOLDS = {
  stalledMin: 15, // no movement while cargo is aboard
  quietMin: 20, // no GPS ping and no message mid-route
  latePickupMin: 10, // past scheduled pickup and cargo not loaded
  unassignedLeadMin: 90, // unassigned this close to pickup
  farDeliveryM: 150,
};

const mins = (ms: number) => Math.round(ms / MINUTE);

export function fmtMin(m: number): string {
  const a = Math.abs(Math.round(m));
  return a >= 60 ? `${Math.floor(a / 60)}h${String(a % 60).padStart(2, "0")}m` : `${a}m`;
}

export function detectSignals(route: Route, stops: Stop[], risk: RouteRisk, now: number): Signal[] {
  const signals: Signal[] = [];
  const pending = stops.filter((s) => s.status === "pending" || s.status === "arrived");
  const cargoAboard = route.loadedAt !== null && pending.length > 0;
  const seqOf = (id: string | null) => stops.find((s) => s.id === id)?.seq;

  // TIV: current usage first, then projection.
  if (risk.usedPct !== null && risk.currentLevel !== "ok" && cargoAboard) {
    signals.push({
      type: "tiv_current",
      key: `tiv_current:${risk.currentLevel}`,
      stopIds: risk.atRiskStopIds,
      detail: `${Math.round(risk.usedPct * 100)}% of TIV budget used, ${
        risk.minutesToBreach! > 0 ? `breaches in ${fmtMin(risk.minutesToBreach!)}` : `over by ${fmtMin(risk.minutesToBreach!)}`
      }`,
      urgency: 0, // urgency comes from margin in scoring
    });
  }
  const projected = risk.stops.filter((r) => r.projectedBreach);
  if (projected.length > 0) {
    const worst = projected.reduce((a, b) => (a.marginMin! < b.marginMin! ? a : b));
    signals.push({
      type: "tiv_projected",
      key: "tiv_projected",
      stopIds: projected.map((r) => r.stopId),
      detail: `Stop ${seqOf(worst.stopId)} (${worst.cargo}) projected ${fmtMin(-worst.marginMin!)} over budget at current ETA`,
      urgency: 0,
    });
  }

  for (const r of risk.stops) {
    const s = stops.find((x) => x.id === r.stopId);
    if (s?.status === "delivered" && r.marginMin !== null && r.marginMin < 0) {
      signals.push({
        type: "tiv_breached",
        key: `tiv_breached:${s.id}`,
        stopIds: [s.id],
        detail: `Stop ${s.seq} (${s.cargo}) delivered after ${Math.round(r.tivAtStopMin!)}m in vehicle, budget ${r.budgetMin}m`,
        urgency: 5,
      });
    }
  }

  if (route.driverCancelledAt !== undefined && route.driverId === null) {
    signals.push({
      type: "driver_cancelled",
      key: "driver_cancelled",
      stopIds: pending.map((s) => s.id),
      detail: `Driver cancelled ${fmtMin(mins(now - route.driverCancelledAt))} ago, route needs a new driver`,
      urgency: 7,
    });
  }

  const untilPickup = mins(route.scheduledPickupAt - now);
  if (route.status === "unassigned" && untilPickup <= THRESHOLDS.unassignedLeadMin) {
    signals.push({
      type: "unassigned",
      key: "unassigned",
      stopIds: stops.map((s) => s.id),
      detail: untilPickup >= 0 ? `No driver, pickup in ${fmtMin(untilPickup)}` : `No driver, pickup was ${fmtMin(untilPickup)} ago`,
      urgency: untilPickup <= 0 ? 8 : untilPickup <= 30 ? 6 : 4,
    });
  }
  if (route.loadedAt === null && route.status !== "completed" && -untilPickup >= THRESHOLDS.latePickupMin) {
    signals.push({
      type: "late_pickup",
      key: "late_pickup",
      stopIds: stops.map((s) => s.id),
      detail: `Pickup ${fmtMin(-untilPickup)} late at ${route.pickupSite}`,
      urgency: 5,
    });
  }

  if (cargoAboard && route.lastPingAt !== null) {
    const silentMin = mins(now - Math.max(route.lastPingAt, route.lastDriverMessageAt ?? 0));
    const stillMin = route.lastMovedAt === null ? 0 : mins(now - route.lastMovedAt);
    if (silentMin >= THRESHOLDS.quietMin) {
      signals.push({
        type: "driver_quiet",
        key: "driver_quiet",
        stopIds: pending.map((s) => s.id),
        detail: `No GPS ping or message for ${fmtMin(silentMin)} with cargo aboard`,
        urgency: silentMin >= 40 ? 8 : 6,
      });
    } else if (stillMin >= THRESHOLDS.stalledMin) {
      const where =
        route.position.kind === "pickup" ? `at pickup (${route.pickupSite})` :
        route.position.kind === "at_stop" ? `at stop ${seqOf(route.position.stopId)}` : "en route";
      signals.push({
        type: "driver_stalled",
        key: "driver_stalled",
        stopIds: pending.map((s) => s.id),
        detail: `No movement for ${fmtMin(stillMin)} ${where}`,
        urgency: 5,
      });
    }
  }

  const lateStops = pending.filter((s) => s.eta !== null && Math.max(s.eta, now) > s.windowEnd);
  if (lateStops.length > 0) {
    const worst = lateStops.reduce((a, b) => (Math.max(a.eta!, now) - a.windowEnd > Math.max(b.eta!, now) - b.windowEnd ? a : b));
    signals.push({
      type: "eta_past_window",
      key: "eta_past_window",
      stopIds: lateStops.map((s) => s.id),
      detail: `${lateStops.length} stop${lateStops.length > 1 ? "s" : ""} past booked window (stop ${worst.seq} by ${fmtMin(mins(Math.max(worst.eta!, now) - worst.windowEnd))})`,
      urgency: 3,
    });
  }

  for (const s of stops) {
    if (s.status === "delivered" && (s.deliveredDistanceM ?? 0) > THRESHOLDS.farDeliveryM) {
      signals.push({
        type: "far_delivery",
        key: `far_delivery:${s.id}`,
        stopIds: [s.id],
        detail: `Stop ${s.seq} marked delivered ${s.deliveredDistanceM}m from the address`,
        urgency: 4,
      });
    }
  }

  return signals;
}
