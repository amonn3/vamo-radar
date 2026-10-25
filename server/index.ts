import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { aiEnabled, triageWithLLM } from "./llm";
import { buildSeed } from "./seed";
import { Store } from "./store";

// triageWithLLM falls back to rules when there is no key or the call fails.
const store = new Store(() => buildSeed(), triageWithLLM);
const app = createApp(store, { aiEnabled, runtime: "server" });

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Vamo Radar API on http://localhost:${port} (AI triage: ${aiEnabled() ? "LLM" : "rules only, set ANTHROPIC_API_KEY to enable"})`);
});
