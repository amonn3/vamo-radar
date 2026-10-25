import type { CaseDetail, CaseStatus, CaseSummary, InboundMessage, ResolutionCode } from "../../shared/types";

export interface ClockInfo {
  now: number;
  aiEnabled: boolean;
  runtime: "server" | "browser";
}

export interface CaseList {
  cases: CaseSummary[];
  counts: Record<CaseStatus, number>;
}

export interface Filters {
  status: CaseStatus | "active";
  cargo: string;
  type: string;
  q: string;
}

export interface PodPack {
  orderId: string;
  routeCode: string;
  customer: string;
  recipient: string;
  address: string;
  driver: string;
  cargo: string;
  photo: boolean;
  deliveredAt: number;
  distanceM: number | null;
  distanceOk: boolean;
  window: { start: number; end: number };
  inWindow: boolean;
  tiv: { loadedAt: number | null; atDeliveryMin: number | null; budgetMin: number | null; withinBudget: boolean };
}

// VITE_BROWSER_API=true (static deploy) runs the API in the browser instead of calling a server.
const transport: Promise<(path: string, init?: RequestInit) => Promise<Response>> =
  import.meta.env.VITE_BROWSER_API === "true" ? import("./local").then((m) => m.localFetch) : Promise.resolve(fetch.bind(window));

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const send = await transport;
  const res = await send(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

const post = <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  clock: () => request<ClockInfo>("/clock"),
  advance: (minutes: number) => post<{ now: number }>("/clock/advance", { minutes }),
  reset: () => post<{ now: number }>("/clock/reset"),
  cases: (f: Filters) => {
    const params = new URLSearchParams();
    params.set("status", f.status);
    if (f.cargo) params.set("cargo", f.cargo);
    if (f.type) params.set("type", f.type);
    if (f.q.trim()) params.set("q", f.q.trim());
    return request<CaseList>(`/cases?${params}`);
  },
  case: (id: string) => request<CaseDetail>(`/cases/${id}`),
  claim: (id: string) => post(`/cases/${id}/claim`),
  release: (id: string) => post(`/cases/${id}/release`),
  note: (id: string, text: string) => post(`/cases/${id}/note`, { text }),
  resolve: (id: string, code: ResolutionCode, note?: string) => post(`/cases/${id}/resolve`, { code, note }),
  applyAction: (id: string, actionId: string, text?: string) => post(`/cases/${id}/actions/${encodeURIComponent(actionId)}`, { text }),
  simulateMessage: () => post<InboundMessage>("/messages/simulate"),
  sendReply: (id: string, text: string) => post(`/messages/${id}/send`, { text }),
  dismiss: (id: string) => post(`/messages/${id}/dismiss`),
  redraft: (messageId: string) => post<InboundMessage>("/triage/draft", { messageId }),
  pod: (stopId: string) => request<PodPack>(`/stops/${stopId}/pod`),
  handoff: () => request<{ text: string }>("/handoff"),
};
