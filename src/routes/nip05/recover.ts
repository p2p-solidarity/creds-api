import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { CloudflareBindings } from "../../types/bindings";
import { readLimitedBody } from "../../lib/readLimitedBody";
import { verifyNip98Authorization } from "../../lib/nip05/auth";
import { purgeDirectoryCaches } from "../../lib/nip05/cache";
import { MAX_OLD_RECORD_JWS_BYTES, NIP05_DOMAIN } from "../../lib/nip05/constants";
import { createWorkerResolverIO } from "../../lib/nip05/dnsBinding";
import { verifyRecoveryEvidence } from "../../lib/nip05/recovery";
import {
  findActiveDirectoryEntry,
  recoverHandle,
} from "../../lib/nip05/repository";
import { parseRecoverBody } from "../../lib/nip05/request";
import { ErrorSchema, RecoverResponseSchema } from "./schemas";

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
/**
 * Two record JWS (each capped at `MAX_OLD_RECORD_JWS_BYTES`) plus small fields;
 * stops an oversized upload before it is buffered.
 */
const MAX_BODY_BYTES = 2 * MAX_OLD_RECORD_JWS_BYTES + 4_096;

// Body is read raw, not schema-validated by the router: NIP-98 hashes the
// exact request bytes, so any normalisation would break the payload check.
export const recoverRoute = createRoute({
  method: "post",
  path: "/id/recover",
  summary: "Rebind a NIP-05 name to a new key after the original seed was lost",
  description:
    'Purely cryptographic recovery (design §3.5). Body: {"name": string, "oldRecordJws": string, "newRecordJws": string, "binding": "dns:<domain>", "consent": true}, signed via NIP-98 by the NEW Nostr key. There is deliberately no manual/admin approval path: when the evidence below cannot be produced, the request is denied and the name stays with its current holder.',
  responses: {
    200: {
      description: "Name rebound to the new pubkey",
      content: { "application/json": { schema: RecoverResponseSchema } },
    },
    413: {
      description: "Request body over the size limit",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "NIP-98 authorization failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Recovery evidence rejected",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "No active registration for that name",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Directory state changed during the request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Unexpected failure",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const recoverHandler = async (
  c: Context<{ Bindings: CloudflareBindings }>,
) => {
  const clientIp =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for") ||
    "unknown";
  const { success } = await c.env.REGISTER_RATE_LIMITER.limit({ key: clientIp });
  if (!success) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }

  const read = await readLimitedBody(c.req.raw, MAX_BODY_BYTES);
  if (!read.ok) {
    if (read.tooLarge) return c.json({ error: "request_too_large" }, 413);
    return c.json({ error: "invalid_request" }, 400);
  }
  const rawBodyBytes = read.bytes;
  let rawBody: string;
  try {
    rawBody = textDecoder.decode(rawBodyBytes);
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  const body = parseRecoverBody(rawBody);
  if (!body.ok) {
    return c.json({ error: body.error }, 400);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const auth = verifyNip98Authorization({
    authorization: c.req.header("authorization"),
    method: c.req.method,
    requestUrl: c.req.url,
    rawBody: rawBodyBytes,
    nowSeconds,
  });
  if (!auth.ok) {
    return c.json({ error: "invalid_auth", detail: auth.detail }, 401);
  }

  try {
    const current = await findActiveDirectoryEntry(c.env.INBOX_DB, body.name);
    if (current === null) {
      return c.json({ error: "name_not_found" }, 404);
    }

    const verdict = await verifyRecoveryEvidence(
      {
        name: body.name,
        storedPubkey: current.pubkey,
        newPubkey: auth.event.pubkey,
        oldRecordJws: body.oldRecordJws,
        newRecordJws: body.newRecordJws,
        binding: body.binding,
      },
      createWorkerResolverIO(),
    );
    if (!verdict.ok) {
      return c.json({ error: "recovery_denied", detail: verdict.detail }, 403);
    }

    const result = await recoverHandle(c.env.INBOX_DB, {
      name: body.name,
      expectedPubkey: current.pubkey,
      pubkey: auth.event.pubkey,
      eventId: auth.event.id,
      authEvent: auth.authEvent,
      nowSeconds,
    });
    if (!result.ok) {
      if (result.error === "replay") {
        return c.json({ error: "invalid_auth", detail: "replay" }, 401);
      }
      if (result.error === "name_not_found") {
        return c.json({ error: "name_not_found" }, 404);
      }
      return c.json({ error: result.error }, 409);
    }

    await purgeDirectoryCaches(
      c.req.url,
      result.releasedName === null
        ? [result.name]
        : [result.name, result.releasedName],
    );
    return c.json(
      {
        name: result.name,
        pubkey: result.pubkey,
        identifier: `${result.name}@${NIP05_DOMAIN}`,
        rebindGeneration: result.rebindGeneration,
        releasedName: result.releasedName,
      },
      200,
    );
  } catch (error) {
    console.error("NIP-05 recovery failed", error);
    return c.json({ error: "storage_failed" }, 500);
  }
};
