import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { CloudflareBindings } from "../../types/bindings";
import { utf8Encode, verifyOwnerSignature } from "../../lib/inbox/crypto";
import { DeleteAllRequestSchema, DeleteAllResponseSchema, ErrorSchema } from "./schemas";

const REQUEST_WINDOW_SECONDS = 300;

/**
 * Bound to purpose and time, unlike the static `sig(pubkey)` that `/sync` and
 * `/ack` accept: a captured sync signature can't wipe an inbox, and this one
 * stops working after five minutes.
 */
export const deleteAllPayload = (pubkey: string, ts: number) =>
  utf8Encode(`creds-inbox-delete:${pubkey}:${ts}`);

export const deleteAllRoute = createRoute({
  method: "post",
  path: "/inbox/delete",
  summary: "Account deletion: drop every message held for the signing pubkey",
  request: {
    body: { content: { "application/json": { schema: DeleteAllRequestSchema } } },
  },
  responses: {
    200: {
      description: "Number of messages deleted",
      content: { "application/json": { schema: DeleteAllResponseSchema } },
    },
    400: {
      description: "Malformed request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Signature invalid or request outside its time window",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const deleteAllHandler = async (c: Context<{ Bindings: CloudflareBindings }>) => {
  let parsed;
  try {
    parsed = DeleteAllRequestSchema.safeParse(await c.req.json());
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { pubkey, ts, sig } = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REQUEST_WINDOW_SECONDS) {
    return c.json({ error: "stale_request" }, 401);
  }
  if (!(await verifyOwnerSignature(pubkey, sig, deleteAllPayload(pubkey, ts)))) {
    return c.json({ error: "invalid_signature" }, 401);
  }
  const result = await c.env.INBOX_DB.prepare("DELETE FROM inbox WHERE owner_pubkey = ?").bind(pubkey).run();
  return c.json({ deleted: result.meta.changes ?? 0 }, 200);
};
