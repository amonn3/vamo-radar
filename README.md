# Vamo Radar

An exception-management console for Vamo's ops/support team. Radar watches every active route and puts the **cases that risk cargo loss** at the top of one queue. Each case has the route, stops, cold-chain exposure, a unified timeline, inbound messages with drafted replies, and ranked next actions, all on one screen.

The operator works the dozen cases that matter instead of watching 300 routes.

## Run it

```bash
npm install
npm run dev          # API on :8787, web on http://localhost:5173
npm test             # Vitest: TIV engine, scoring, store integration
```

No API key is needed. Triage falls back to a deterministic rules engine.

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Optional. Turns on LLM triage and drafting (structured JSON output). The top bar shows **AI triage** or **Rules triage**. |
| `SEED_NOW` | Optional ISO timestamp that anchors the simulated clock. Default `2026-10-23T19:30:00Z` (3:30 PM in Miami). |
| `PORT` | API port, default `8787`. |

`npm run build && npm start` serves the built app and API from a single process on `PORT`.

**Static deploy (Vercel).** `npm run build:static` builds a version where the same Hono API runs *inside the browser* against a local store (`web/src/local.ts`). Every visitor gets their own stable simulation, which serverless functions with in-memory state could not guarantee. The LLM key stays server-side, so the deployed demo uses rules triage. `vercel.json` is already configured.

### Demo script (about 3 minutes)

1. **On load**, the 8 planted cases are ranked. The quiet driver with chilled cargo (R-2103) is first. The ambient "where's my order?" (R-2108) is last, so the queue really prioritizes.
2. Open **R-2101**. Everything looks fine (37% TIV used), but frozen stop 5 is projected to land 6 minutes over budget. Suggested actions: reassign stop 5 or **reorder 2 → 4 → 5 → 3 → 6**, and each one shows the TIV margin it buys.
3. Open **R-2104** (building access). The driver's text has already been classified, and a reply is drafted. Press **a** to approve and send it.
4. Click **Advance 30 min** (or press `t`). The TIV bars drain. R-2104 moves from warning to **critical** because the driver is stuck at the door with frozen cargo, and R-2027, which was healthy, enters the queue.
5. Click **Simulate message** (`m`). Kevin asks to do stop 5 first. The message links to R-2101, stop 5, is classified as *stop-order confusion*, and gets a drafted reply. Keep pressing it to see Tyler come back online (the quiet signal clears), a POD request from Bayside Poke, a WISMO and a pay question.
6. On **R-2107**, open the **POD** pack for stop 2. It warns not to use the pack as proof, because the GPS fix was 420 m from the address.
7. **Shift handoff** produces a copyable summary for the next shift.

Keyboard: `↑/↓` or `j/k` move through the queue, `c` claims, `a` approves the top draft, `r` focuses resolve, `/` searches.

## Architecture

```
shared/   types, TIV engine, detection rules, priority score (pure functions, unit tested)
server/   Hono API (runtime-agnostic app.ts), in-memory store + simulated clock, seed, triage (rules) and llm.ts
web/      React + Vite, plain CSS, polling every 3 s
```

- **`shared/tiv.ts`** is the core model. It computes TIV per stop: `elapsed = now − loadedAt`, `projected(stop) = ETA − loadedAt`, and `margin = budget − projected`. Budgets are frozen 60 min, chilled 90 min, ambient none, and customers can override them (PrepPal frozen 50, Verde chilled 75, Bayside chilled 60). Levels: warn at 70% of budget used, critical at 90%. A projected breach is at least a warning even when current usage is fine. That is the "catch it before it happens" window.
- **`shared/detect.ts`** turns route state into signals: TIV current, projected, or breached on delivery; driver stalled (15 min with no movement); driver quiet (20 min with no ping or message); unassigned within 90 min of pickup; late pickup; ETA past the booked window; delivered more than 150 m from the address; driver cancelled.
- **`shared/score.ts`** computes `priority = urgency × cargo weight × (1 + 0.25 per at-risk perishable stop) × staleness`. TIV urgency is the inverse of the smallest margin: 10 at zero margin, halved for every 10 minutes of slack, above 10 once breached. Other signals carry a fixed base urgency. Cargo weights are frozen 1.0, chilled 0.9, ambient 0.4. Staleness adds +50% per hour without an operator touch, capped at 2×. Every case shows a one-line reason built from the same inputs.
- **One case per route.** Several alerts on the same route (TIV, stalled, an inbound text) collapse into one case with multiple signals, so two operators never work the same route. A resolved case reopens only when a *new* signal appears.
- **Triage** (`server/triage.ts`) links messages deterministically: sender phone → driver → live route, then an order ID in the text, then the recipient's phone, plus "stop N" mentions. The LLM only classifies and drafts. Linking in code is cheaper, testable and never hallucinates a route. If there is no key, the call errors, or the model refuses, the rules engine answers instead. **Nothing is ever sent automatically.** Every draft and every suggested message waits for *Approve & send*.
- **Simulation.** Each route has a sim mode: `normal` delivers on ETA, `slipping` drifts 20% later, `stuck` pings but its ETAs slide with the clock, and `quiet` stops pinging. "Advance 30 min" moves the world. Actions such as reassign, reorder, assign driver and notify change state and write to the timeline.

## Assumptions

- There are no temperature sensors or driver temperature check-ins (confirmed with Scott). Cold-chain risk is inferred from **Time in Vehicle** against a budget per cargo class. TIV is a proxy: it does not see door-open events, vehicle climate or insulated bags, so the default budgets are conservative.
- The TIV clock starts when cargo is scanned out of cold storage (`loadedAt`), not when the vehicle starts moving. A driver waiting at pickup with bags in hand is already spending budget (story 2).
- The live ETA from the driver app is trusted. An ETA in the past means the app is stale, so projections never use a time earlier than now.
- Times are shown in Eastern Time, because the demo market is Miami. A real deployment would show the operator's zone next to the market's zone.

## Trade-offs

- **Explainable score over optimal score.** A small multiplicative formula with visible weights is easy to argue with and tune. A learned model would rank better eventually, but only once there is resolution data to learn from.
- **Route strip instead of a map.** Ops needs to know "between stop 2 and 3, last ping 31 minutes ago", not street geometry. A real map is a later add-on.
- **Polling instead of websockets.** 3-second polling is simple and good enough for a single operator. Server-sent events would be the next step.
- **Suggestions are honest.** Reassign and reorder are offered only when they actually improve the worst TIV margin, and each suggestion shows the margin before and after. Reassigning a route whose cargo is already old gains nothing, so it is not suggested.
- **In-memory state.** Restarting the server resets the demo, which is useful for a Loom recording.

## Not built (out of scope)

Real telephony, Slack or SMS integration; authentication and roles (the operator is "You"); route optimization (reorder is earliest-deadline-first over the existing ETA slots); pay and disputes (pay questions are classified and routed, not handled); real temperature sensors; native mobile; real maps and routing APIs; persistence beyond memory; shareable POD links (the pack copies to the clipboard); AI-written handoff (the handoff is generated from rules).

## Write-up (draft)

**Problem and assumptions.** Ops already has signals, such as live GPS, ETAs, delivery photos and board auto-flags. What it lacks is unified context and risk-based prioritization: context is spread across phone, Slack and the admin tool, and work is ordered by who called first. Scott confirmed there is no temperature data, so Radar models cold-chain risk as Time-in-Vehicle against a per-cargo budget, using the live ETAs ops already has. TIV is a proxy and the budgets are conservative.

**What we built.** A prioritized case queue ranked by risk of cargo loss, with per-stop TIV including a *projected* breach before it happens. A case view with route strip, stops, a unified timeline and driver history. A detection engine that opens cases before anyone complains. Human-in-the-loop triage that links, classifies and drafts replies (LLM with a rules fallback). Ranked suggested actions that show the margin each one buys: reassign, reorder, notify, escalate. Claim, note and resolve. POD pack and shift handoff. What we left out is listed above.

**Next week.** Integrate the real telephony/SMS and Slack feeds. Calibrate TIV budgets against historical complaint and loss data, and validate them with sensors on a few routes if possible. Learn playbooks from resolved cases (which action resolved which signal, and how fast). Tune the score weights with the team. Pilot with one shift.

**How we would know it works.** Time to detection and time to resolution by case type. The share of problems detected before customer contact. "Where's my order?" contacts per delivery, which should fall. Touches and tools per case. The share of projected TIV breaches prevented by proactive action. The cold-chain complaint and loss rate.

**AI usage.** AI coding tools were used for scaffolding and iteration. In the product, an LLM API classifies inbound messages and drafts replies and actions with structured output. A human approves every message, and a deterministic rules engine keeps the product working without a key.

**Time spent.** _To be filled in._
