import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { nip05Router } from "./routes/nip05";
import { proRouter } from "./routes/pro";
import { rootVaultRouter } from "./routes/rootVault";
import { runNip05Cleanup } from "./schedules/index";
import type { CloudflareBindings } from "./types/bindings";

export { Nip05WriteLimiter } from "./lib/writeLimiter";

/**
 * NIP-05 directory worker — the `creds.id` id service on its own.
 *
 * Deployed with `wrangler.nip05.jsonc` into the Cloudflare account that owns
 * the creds.id zone (a Worker route can only be attached from the
 * account the zone lives in). The retired inbox / PassKit worker
 * (`src/index.ts`) is only an account-deletion stub now. The root vault, Pro
 * and nip05 routers and the audit cleanup cron are mounted here.
 * `bun run deploy:nip05` does the whole thing.
 */
const app = new OpenAPIHono<{ Bindings: CloudflareBindings }>();

app
  .use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type", "Authorization", "X-Creds-Signature"],
      allowMethods: ["POST", "PUT", "PATCH", "GET", "OPTIONS", "DELETE"],
      maxAge: 600,
    }),
  )
  .use("*", rateLimitMiddleware)
  .route("/", rootVaultRouter)
  .route("/", proRouter)
  .route("/", nip05Router);

export default {
  fetch: app.fetch,
  scheduled: async (
    _event: ScheduledEvent,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ) => {
    ctx.waitUntil(
      runNip05Cleanup(env).catch((error) => {
        console.error("❌ NIP-05 cleanup failed:", error);
      }),
    );
  },
};
