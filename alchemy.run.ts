import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import { loadConfig } from "./cli/load.ts";
import { Db, Files } from "./src/resources.ts";
import Worker from "./src/worker.ts";

const config = await loadConfig();

export default Alchemy.Stack(
  "Posthumail",
  // Deploy state lives in .alchemy/ on this machine; `--adopt` recovers if it is lost.
  { providers: Cloudflare.providers(), state: State.localState() },
  Effect.gen(function* () {
    yield* Db;
    yield* Files;
    // Fallback route for owner and trustees only. Creating an Address makes
    // Cloudflare send that person a one-time verification email.
    for (const p of [config.owner, ...config.trustees].filter((p) => p.manageAddress !== false)) {
      yield* Cloudflare.Email.Address(`Address-${p.id}`, { email: p.email });
    }
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
