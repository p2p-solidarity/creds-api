/**
 * Requests signed by the account's own root key (did:key, ES256) — how every
 * delete proves it comes from the account it deletes.
 *
 *   X-Creds-Signature: <compact JWS, header {alg: ES256, kid: <did>#0}>
 *   payload { aud: "creds.id", m: <HTTP method>, p: <path>, iat, jti }
 *
 * `m` + `p` bind it to one operation on one record, `iat` to ±5 minutes, and
 * `jti` (stored until the window has passed) to a single use, so a captured
 * header can be neither replayed nor pointed at another record.
 */
import { verifyCompact } from "./nip05/jws";

export const SIGNED_REQUEST_HEADER = "x-creds-signature";
export const SIGNED_REQUEST_AUDIENCE = "creds.id";
export const SIGNED_REQUEST_WINDOW_SECONDS = 300;
const JTI_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

export type SignedRequestResult =
  | { readonly ok: true; readonly did: string }
  | { readonly ok: false; readonly error: "missing" | "invalid_signature" | "stale" | "wrong_target" | "replay" };

function headerDid(jws: string): string | null {
  try {
    const part = jws.split(".")[0] ?? "";
    const json = atob(part.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const kid = (JSON.parse(json) as { kid?: unknown }).kid;
    if (typeof kid !== "string" || !kid.endsWith("#0")) return null;
    const did = kid.slice(0, -2);
    return did.startsWith("did:key:z") ? did : null;
  } catch {
    return null;
  }
}

/** Single-use: the first request with a `jti` wins, any later one is a replay. */
export async function consumeNonce(db: D1Database, jti: string, expiresAt: number): Promise<boolean> {
  const inserted = await db
    .prepare("INSERT OR IGNORE INTO signed_request_nonces (jti, expires_at) VALUES (?, ?)")
    .bind(jti, expiresAt)
    .run();
  return (inserted.meta.changes ?? 0) > 0;
}

export async function verifySignedRequest(
  db: D1Database,
  input: { header: string | undefined; method: string; path: string; nowSeconds: number },
): Promise<SignedRequestResult> {
  const jws = input.header;
  if (jws === undefined || jws.length === 0 || jws.length > 4096) return { ok: false, error: "missing" };
  const did = headerDid(jws);
  if (did === null) return { ok: false, error: "invalid_signature" };
  const verified = verifyCompact(jws, did);
  if (!verified.ok) return { ok: false, error: "invalid_signature" };
  const p = verified.payload;
  if (typeof p["iat"] !== "number" || Math.abs(input.nowSeconds - p["iat"]) > SIGNED_REQUEST_WINDOW_SECONDS) {
    return { ok: false, error: "stale" };
  }
  if (p["aud"] !== SIGNED_REQUEST_AUDIENCE || p["m"] !== input.method.toUpperCase() || p["p"] !== input.path) {
    return { ok: false, error: "wrong_target" };
  }
  if (typeof p["jti"] !== "string" || !JTI_PATTERN.test(p["jti"])) return { ok: false, error: "invalid_signature" };
  if (!(await consumeNonce(db, `did:${p["jti"]}`, p["iat"] + SIGNED_REQUEST_WINDOW_SECONDS))) {
    return { ok: false, error: "replay" };
  }
  return { ok: true, did };
}

export async function purgeExpiredNonces(db: D1Database, nowSeconds: number): Promise<number> {
  const removed = await db.prepare("DELETE FROM signed_request_nonces WHERE expires_at < ?").bind(nowSeconds).run();
  return removed.meta.changes ?? 0;
}
