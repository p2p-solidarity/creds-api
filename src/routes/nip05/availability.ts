import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { CloudflareBindings } from "../../types/bindings";
import { isReservedNip05Name, validateNip05Name } from "../../lib/nip05/name";
import { getStoredNameState } from "../../lib/nip05/repository";
import {
  AvailabilityQuerySchema,
  AvailabilityResponseSchema,
  ErrorSchema,
} from "./schemas";

export const availabilityRoute = createRoute({
  method: "get",
  path: "/id/availability",
  summary: "Check whether a NIP-05 name can be registered",
  request: {
    query: AvailabilityQuerySchema,
  },
  responses: {
    200: {
      description: "Availability verdict for the requested name",
      content: {
        "application/json": {
          schema: AvailabilityResponseSchema,
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

export const availabilityHandler = async (c: Context<{ Bindings: CloudflareBindings }>) => {
  const rawName = c.req.query("name") ?? "";
  const normalizedName = rawName.toLowerCase();
  const responseHeaders = { "Cache-Control": "no-store" };

  if (isReservedNip05Name(normalizedName)) {
    return c.json(
      { name: normalizedName, available: false, reason: "reserved" as const },
      200,
      responseHeaders,
    );
  }

  const validation = validateNip05Name(rawName);
  if (!validation.valid) {
    return c.json(
      { name: validation.name, available: false, reason: "invalid" as const },
      200,
      responseHeaders,
    );
  }

  try {
    const state = await getStoredNameState(
      c.env.INBOX_DB,
      validation.name,
      Math.floor(Date.now() / 1000),
    );
    if (state.state === "available") {
      return c.json(
        { name: validation.name, available: true },
        200,
        responseHeaders,
      );
    }
    return c.json(
      { name: validation.name, available: false, reason: state.state },
      200,
      responseHeaders,
    );
  } catch (error) {
    console.error("NIP-05 availability lookup failed", error);
    return c.json({ error: "storage_failed" }, 500, responseHeaders);
  }
};
