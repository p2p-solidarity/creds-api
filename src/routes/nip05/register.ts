import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { CloudflareBindings } from "../../types/bindings";
import { readLimitedBody } from "../../lib/readLimitedBody";
import { verifyNip98Authorization } from "../../lib/nip05/auth";
import { purgeDirectoryCaches } from "../../lib/nip05/cache";
import { NIP05_DOMAIN } from "../../lib/nip05/constants";
import { registerHandle } from "../../lib/nip05/repository";
import { parseRegisterBody } from "../../lib/nip05/request";
import { ErrorSchema, RegisterResponseSchema } from "./schemas";

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
/** Far above any real request; stops an oversized upload before it is buffered. */
const MAX_BODY_BYTES = 16_384;

// The body is intentionally not declared for schema validation: NIP-98
// authorization hashes the raw request bytes, so the handler must read them
// untouched and reply with this endpoint's contractual error codes.
export const registerRoute = createRoute({
  method: "post",
  path: "/id/register",
  summary: "Register a NIP-05 handle for the authenticated pubkey",
  description:
    'Expects a JSON body of the form {"name": string, "relays": string[], "consent": true} signed via a NIP-98 authorization header.',
  responses: {
    200: {
      description: "Handle registered",
      content: {
        "application/json": {
          schema: RegisterResponseSchema,
        },
      },
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
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    401: {
      description: "NIP-98 authorization failed",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    409: {
      description: "Name taken or quarantined",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    429: {
      description: "Rate limit exceeded or too many renames",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    500: {
      description: "Unexpected failure",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

export const registerHandler = async (c: Context<{ Bindings: CloudflareBindings }>) => {
  const clientIp =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for") ||
    "unknown";
  const { success } = await c.env.REGISTER_RATE_LIMITER.limit({
    key: clientIp,
  });
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

  const body = parseRegisterBody(rawBody);
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
    const result = await registerHandle(c.env.INBOX_DB, {
      name: body.name,
      pubkey: auth.event.pubkey,
      relays: body.relays,
      eventId: auth.event.id,
      authEvent: auth.authEvent,
      nowSeconds,
    });
    if (!result.ok) {
      if (result.error === "replay") {
        return c.json({ error: "invalid_auth", detail: "replay" }, 401);
      }
      if (result.error === "rename_too_soon") {
        return c.json(
          { error: result.error, retryAt: result.retryAt },
          429,
        );
      }
      return c.json({ error: result.error }, 409);
    }

    await purgeDirectoryCaches(
      c.req.url,
      result.previousName === null
        ? [result.name]
        : [result.previousName, result.name],
    );
    return c.json(
      {
        name: result.name,
        pubkey: result.pubkey,
        identifier: `${result.name}@${NIP05_DOMAIN}`,
      },
      200,
    );
  } catch (error) {
    console.error("NIP-05 registration failed", error);
    return c.json({ error: "storage_failed" }, 500);
  }
};
