import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { CloudflareBindings } from "../../types/bindings";
import { verifyNip98Authorization } from "../../lib/nip05/auth";
import { purgeDirectoryCaches } from "../../lib/nip05/cache";
import { eraseHandlesForPubkey } from "../../lib/nip05/repository";
import { EraseResponseSchema, ErrorSchema } from "./schemas";

export const eraseRoute = createRoute({
  method: "delete",
  path: "/id/account",
  summary: "Account deletion: unlink every name of the authenticated pubkey",
  responses: {
    200: {
      description: "Names that were unlinked (they stay reserved as tombstones)",
      content: { "application/json": { schema: EraseResponseSchema } },
    },
    401: {
      description: "NIP-98 authorization failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Unexpected failure",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const eraseHandler = async (c: Context<{ Bindings: CloudflareBindings }>) => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const auth = verifyNip98Authorization({
    authorization: c.req.header("authorization"),
    method: c.req.method,
    requestUrl: c.req.url,
    nowSeconds,
  });
  if (!auth.ok) {
    return c.json({ error: "invalid_auth", detail: auth.detail }, 401);
  }

  try {
    const result = await eraseHandlesForPubkey(c.env.INBOX_DB, {
      pubkey: auth.event.pubkey,
      nowSeconds,
    });
    if (result.erased.length > 0) {
      await purgeDirectoryCaches(c.req.url, result.erased);
    }
    return c.json({ erased: result.erased }, 200);
  } catch (error) {
    console.error("NIP-05 erase failed", error instanceof Error ? error.message : "unknown");
    return c.json({ error: "storage_failed" }, 500);
  }
};
