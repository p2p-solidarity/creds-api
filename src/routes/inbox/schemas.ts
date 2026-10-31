import { z } from "@hono/zod-openapi";

export const ErrorSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});

export const MessageSchema = z.object({
  id: z.string().uuid(),
  owner_pubkey: z.string(),
  blob: z.string(),
  created_at: z.number(),
});

export const SealRequestSchema = z.object({
  device_token: z.string().min(1).describe("Raw APNs device token"),
});

export const SealResponseSchema = z.object({
  sealed_route: z.string().describe("Opaque encrypted route string"),
});

export const SendRequestSchema = z.object({
  recipient_pubkey: z.string().min(1).max(200),
  blob: z.string().min(1).max(100000),
  sealed_route: z.string().min(1).max(1000),
  sender_pubkey: z.string().min(1).max(200).optional(),
  sender_sig: z.string().min(1).max(500).optional(),
});

export const SendResponseSchema = z.object({
  message_id: z.string().uuid(),
  notified: z.boolean(),
  apns_status: z.number().optional(),
  apns_error: z.string().optional(),
});

export const SyncQuerySchema = z.object({
  pubkey: z.string().min(1),
  sig: z.string().min(1),
});

export const SyncResponseSchema = z.object({
  messages: z.array(MessageSchema),
});

export const AckRequestSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(100),
  pubkey: z.string().min(1),
  sig: z.string().min(1),
});

export const AckResponseSchema = z.object({
  deleted: z.number().min(0),
});

export const DeleteAllRequestSchema = z.object({
  pubkey: z.string().min(1).max(200),
  ts: z.number().int(),
  sig: z.string().min(1).max(500),
});

export const DeleteAllResponseSchema = z.object({
  deleted: z.number().min(0),
});
