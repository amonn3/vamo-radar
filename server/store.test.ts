import { beforeEach, describe, expect, it } from "vitest";
import { buildSeed } from "./seed";
import { Store } from "./store";
import { classifyByRules } from "./triage";

let store: Store;
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY; // tests always exercise the deterministic path
  store = new Store(() => buildSeed("2026-10-23T19:30:00Z"));
});

const codes = () => store.listCases().cases.map((c) => c.routeCode);

describe("seeded queue", () => {
  it("surfaces exactly the 8 planted stories", () => {
    expect(codes().sort()).toEqual(["R-2101", "R-2102", "R-2103", "R-2104", "R-2105", "R-2106", "R-2107", "R-2108"]);
  });

  it("ranks the ambient where's-my-order case last and the quiet chilled driver first", () => {
    const list = codes();
    expect(list[0]).toBe("R-2103");
    expect(list.at(-1)).toBe("R-2108");
  });

  it("explains every rank in one line", () => {
    for (const c of store.listCases().cases) expect(c.reason.length).toBeGreaterThan(10);
  });
});

describe("simulated clock", () => {
  it("escalates the building-access case to critical after 30 minutes", () => {
    const before = store.caseDetail("case-r-2104")!;
    store.advance(30);
    const after = store.caseDetail("case-r-2104")!;
    expect(before.level).not.toBe("critical");
    expect(after.level).toBe("critical");
    expect(after.priority).toBeGreaterThan(before.priority);
  });

  it("brings a previously healthy route into the queue", () => {
    expect(codes()).not.toContain("R-2027");
    store.advance(30);
    expect(codes()).toContain("R-2027");
  });
});

describe("triage", () => {
  it("links, classifies and drafts a simulated driver message", async () => {
    const msg = await store.simulateNextMessage();
    expect(msg.routeId).toBe("r-2101");
    expect(msg.stopId).toBe("r-2101-s5");
    expect(msg.triage?.category).toBe("stop_order");
    expect(msg.triage?.engine).toBe("rules");
    expect(msg.triage?.draft.text.length).toBeGreaterThan(20);
    expect(msg.status).toBe("pending"); // never auto-sent
  });

  it("classifies the planted messages with rules", () => {
    expect(classifyByRules("Gate code 4471 doesn't work and nobody at the front desk").category).toBe("building_access");
    expect(classifyByRules("only has 2 of 3 bags, the frozen one is missing").category).toBe("missing_bag");
    expect(classifyByRules("Hi where's my order?").category).toBe("wismo");
    expect(classifyByRules("it shows delivered, can you send proof of delivery?").category).toBe("pod_request");
    expect(classifyByRules("I'm missing $18 from Tuesday").category).toBe("pay_question");
  });
});

describe("case lifecycle", () => {
  it("claims, resolves and removes the case from the active queue", () => {
    store.claim("case-r-2107");
    expect(store.caseDetail("case-r-2107")!.status).toBe("in_progress");
    store.resolve("case-r-2107", "delivered_ok");
    expect(codes()).not.toContain("R-2107");
  });

  it("keeps a claimed case open after replying, even if no signal remains", () => {
    const msg = store.caseDetail("case-r-2104")!.messages[0]!;
    store.sendReply(msg.id, msg.triage!.draft.text);
    const after = store.caseDetail("case-r-2104")!;
    expect(after.status).toBe("in_progress");
    expect(after.claimedBy).toBe("You");
  });

  it("reorders perishable stops first when that buys TIV margin", () => {
    const action = store.caseDetail("case-r-2101")!.actions.find((a) => a.kind === "reorder");
    expect(action).toBeDefined();
    store.applyAction("case-r-2101", action!.id);
    const after = store.caseDetail("case-r-2101")!;
    expect(after.risk.worstMarginMin!).toBeGreaterThan(-6);
  });
});
