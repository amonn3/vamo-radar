// Static deploy mode: the API runs inside the browser against a local Store, so every visitor gets
// their own stable simulation and no server state is shared. LLM triage is server-only, so rules apply.
import { createApp } from "../../server/app";
import { Store } from "../../server/store";

const app = createApp(new Store(), { aiEnabled: () => false, runtime: "browser" });

export const localFetch = (path: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(app.fetch(new Request(new URL(path, window.location.origin), init)));
