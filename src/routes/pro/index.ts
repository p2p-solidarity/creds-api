/**
 * creds Pro license bridge (airmeishi docs/ref/09, docs/ref/10 §3.11).
 *
 *   POST /pro/license    { request: <compact JWS by the buyer's root did> }
 *                        payload { did, platform: 'ios'|'android', purchase, aud, iat }
 *                        → { license } (≤ 7 days, never past the store expiry)
 *   GET  /pro/issuers    → { issuers: [did] } — the key verifiers pin
 *   DELETE /pro/binding  X-Creds-Signature by the did (lib/signedRequest.ts)
 *                        → { deleted: n } — account deletion drops every
 *                        purchase ↔ did row of that did
 *
 * The purchase is looked up at the store, never believed from the app. One
 * purchase is bound to one did; rebinding to another did is allowed once per
 * 30 days (identity reset), and the previous did's license stops renewing.
 */
import { Hono } from "hono";
import { verifyCompact } from "../../lib/nip05/jws";
import { didKeyFromScalar, mintLicense } from "../../lib/pro/license";
import { lookupAppStore, lookupPlay } from "../../lib/pro/stores";
import { SIGNED_REQUEST_HEADER, verifySignedRequest } from "../../lib/signedRequest";
import type { CloudflareBindings } from "../../types/bindings";
import { readLimitedBody } from "../../lib/readLimitedBody";

const AUDIENCE = "creds.id/pro/license";
const REQUEST_WINDOW_SECONDS = 300;
const REBIND_COOLDOWN_SECONDS = 30 * 86_400;

interface BindingRow {
  readonly did: string;
  readonly bound_at: number;
}

function unsafeDid(jws: string): string | null {
  try {
    const part = jws.split(".")[1] ?? "";
    const json = atob(part.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const did = (JSON.parse(json) as { did?: unknown }).did;
    return typeof did === "string" && did.startsWith("did:key:z") ? did : null;
  } catch {
    return null;
  }
}

export const proRouter = new Hono<{ Bindings: CloudflareBindings }>();

proRouter.get("/pro/issuers", (c) => {
  if (!c.env.LICENSE_SIGNING_KEY) return c.json({ issuers: [] });
  return c.json({ issuers: [didKeyFromScalar(c.env.LICENSE_SIGNING_KEY)] });
});

/**
 * The row is deleted outright, not unlinked: after account deletion nothing
 * here should still tie a store purchase to that identity. The price is that
 * the 30-day rebind cooldown restarts from zero for that purchase — sharing it
 * that way still costs a signed request from every holder, and a license
 * never outlives 7 days.
 */
proRouter.delete("/pro/binding", async (c) => {
  const signed = await verifySignedRequest(c.env.INBOX_DB, {
    header: c.req.header(SIGNED_REQUEST_HEADER),
    method: "DELETE",
    path: "/pro/binding",
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!signed.ok) return c.json({ error: signed.error }, signed.error === "missing" ? 400 : 401);
  const deleted = await c.env.INBOX_DB.prepare("DELETE FROM pro_bindings WHERE did = ?").bind(signed.did).run();
  return c.json({ deleted: deleted.meta.changes ?? 0 });
});

proRouter.post("/pro/license", async (c) => {
  if (!c.env.LICENSE_SIGNING_KEY) return c.json({ error: "not_configured" }, 503);
  // `request` is capped at 4 KB below, so nothing larger is ever buffered.
  const read = await readLimitedBody(c.req.raw, 8_192);
  if (!read.ok) {
    if (read.tooLarge) return c.json({ error: "request_too_large" }, 413);
    return c.json({ error: "invalid_request" }, 400);
  }
  let body: { request?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(read.bytes)) as { request?: unknown };
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (typeof body !== "object" || body === null) return c.json({ error: "invalid_request" }, 400);
  if (typeof body.request !== "string" || body.request.length > 4096) return c.json({ error: "invalid_request" }, 400);

  // The did signs its own request: only the identity that will hold the license can ask for it.
  const did = unsafeDid(body.request);
  if (did === null) return c.json({ error: "invalid_request" }, 400);
  const verified = verifyCompact(body.request, did);
  if (!verified.ok) return c.json({ error: "invalid_signature" }, 401);
  const p = verified.payload;
  const now = Math.floor(Date.now() / 1000);
  if (p["aud"] !== AUDIENCE || typeof p["iat"] !== "number" || Math.abs(now - p["iat"]) > REQUEST_WINDOW_SECONDS) {
    return c.json({ error: "stale_request" }, 401);
  }
  if (typeof p["purchase"] !== "string") return c.json({ error: "invalid_request" }, 400);

  const store =
    p["platform"] === "ios"
      ? await lookupAppStore(c.env, p["purchase"], now)
      : p["platform"] === "android"
        ? await lookupPlay(c.env, p["purchase"], now)
        : null;
  if (store === null) return c.json({ error: "invalid_request" }, 400);
  if (!store.ok) {
    const status = store.error === "not_configured" || store.error === "store_unreachable" ? 503 : 402;
    return c.json({ error: store.error }, status);
  }

  const db = c.env.INBOX_DB;
  const existing = await db
    .prepare("SELECT did, bound_at FROM pro_bindings WHERE purchase_key = ?")
    .bind(store.value.key)
    .first<BindingRow>();
  if (existing && existing.did !== did && now - existing.bound_at < REBIND_COOLDOWN_SECONDS) {
    return c.json({ error: "rebind_cooldown", retryAfter: existing.bound_at + REBIND_COOLDOWN_SECONDS }, 409);
  }
  const boundAt = existing && existing.did === did ? existing.bound_at : now;
  await db
    .prepare(
      "INSERT INTO pro_bindings (purchase_key, did, product, expires_at, bound_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(purchase_key) DO UPDATE SET did = excluded.did, product = excluded.product, expires_at = excluded.expires_at, bound_at = excluded.bound_at",
    )
    .bind(store.value.key, did, store.value.productId, store.value.expiresAt, boundAt)
    .run();

  const license = mintLicense(c.env.LICENSE_SIGNING_KEY, { sub: did, product: store.value.productId, storeExpiry: store.value.expiresAt }, now);
  return c.json({ license });
});
