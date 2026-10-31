import { z } from "@hono/zod-openapi";

export const ErrorSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
  retryAt: z.number().optional(),
});

export const DirectoryQuerySchema = z.object({
  name: z.string().optional().describe('NIP-05 name to resolve; defaults to "_"'),
});

export const DirectoryResponseSchema = z.object({
  names: z.record(z.string(), z.string()),
  relays: z.record(z.string(), z.array(z.string())).optional(),
});

export const AvailabilityQuerySchema = z.object({
  name: z.string().optional().describe("Candidate NIP-05 name"),
});

export const AvailabilityResponseSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  // `tombstoned` is terminal — unlike the quarantine it replaces, a name in
  // this state never becomes available to anyone but its original holder.
  reason: z.enum(["reserved", "invalid", "taken", "tombstoned"]).optional(),
});

export const RegisterResponseSchema = z.object({
  name: z.string(),
  pubkey: z.string(),
  identifier: z.string(),
});

export const ReleaseResponseSchema = z.object({
  released: z.string().nullable(),
});

export const EraseResponseSchema = z.object({
  erased: z.array(z.string()),
});

export const HistoryQuerySchema = z.object({
  name: z.string().optional().describe("NIP-05 name to inspect"),
});

export const HistoryResponseSchema = z.object({
  name: z.string(),
  status: z.enum(["active", "redirected", "released"]),
  redirectTo: z.string().nullable(),
  redirectUntil: z.number().nullable(),
  /** G5 — `>= 1` must be rendered by the viewer as a permanent marker. */
  rebindGeneration: z.number(),
  reboundAt: z.number().nullable(),
});

export const RecoverResponseSchema = z.object({
  name: z.string(),
  pubkey: z.string(),
  identifier: z.string(),
  /** G5 — permanent, monotonic. Viewers must surface `>= 1`. */
  rebindGeneration: z.number(),
  /** The applicant's previous active name, released to make room. */
  releasedName: z.string().nullable(),
});
