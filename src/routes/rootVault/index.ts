import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import { Hono, type Context } from "hono";
import { readLimitedBody } from "../../lib/readLimitedBody";
import { SIGNED_REQUEST_HEADER, verifySignedRequest } from "../../lib/signedRequest";
import type { CloudflareBindings } from "../../types/bindings";

const LOCATOR_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CIPHERTEXT_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_REQUEST_BYTES = 4_096;
const MAX_CIPHERTEXT_CHARS = 2_048;
const MAX_META_CHARS = 2_048;
const MIN_META_CHARS = 38;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/u;
/** Bounds one identity's index so a leaked owner secret can't fill the table. */
const MAX_ROWS_PER_OWNER = 20;

interface RootVaultRow {
  readonly version: number;
  readonly ciphertext: string;
  readonly owner: string | null;
  readonly meta: string | null;
  readonly owner_did: string | null;
}

interface RootVaultRecord {
  readonly v: 1;
  readonly ciphertext: string;
  readonly meta?: string;
}

interface OwnedRow {
  readonly locator: string;
  readonly meta: string | null;
  readonly created_at: number;
}

type LimitedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly tooLarge: boolean };

async function readLimitedJson(
  request: Request,
  maxBytes: number,
): Promise<LimitedJson> {
  if (request.body === null) return { ok: false, tooLarge: false };
  const read = await readLimitedBody(request, maxBytes);
  if (!read.ok) return read;
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(read.bytes)) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

function noStoreHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
  };
}

function isMeta(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_META_CHARS &&
    value.length <= MAX_META_CHARS &&
    CIPHERTEXT_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is RootVaultRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const hasMeta = Object.prototype.hasOwnProperty.call(record, "meta");
  return (
    Object.keys(record).length === (hasMeta ? 3 : 2) &&
    (!hasMeta || isMeta(record.meta)) &&
    record.v === 1 &&
    typeof record.ciphertext === "string" &&
    record.ciphertext.length >= 38 &&
    record.ciphertext.length <= MAX_CIPHERTEXT_CHARS &&
    CIPHERTEXT_PATTERN.test(record.ciphertext)
  );
}

type RootVaultContext = Context<{ Bindings: CloudflareBindings }>;

/**
 * The owner secret is HKDF(seed) on the client (shared `deriveRootVaultAccess`);
 * only its SHA-256 is stored, so a database read can't act as an owner.
 * `undefined` = no Authorization header, `null` = present but malformed.
 */
function ownerHash(c: RootVaultContext): string | null | undefined {
  const header = c.req.header("authorization");
  if (header === undefined) return undefined;
  const match = BEARER_PATTERN.exec(header);
  if (match === null) return null;
  let secret: Uint8Array;
  try {
    secret = base64urlnopad.decode(match[1]!);
  } catch {
    return null;
  }
  if (secret.length !== 32) return null;
  return base64urlnopad.encode(sha256(secret));
}

function unauthorized(c: RootVaultContext) {
  return c.json({ error: "unauthorized" }, 401, noStoreHeaders());
}

/**
 * The root did:key that signed THIS request (method + path, single use). Owned
 * writes record it as `owner_did`; deletes must come from it. The owner secret
 * alone is a bearer — it lists and renames, but can't decide who may delete.
 */
async function signer(c: RootVaultContext, path: string): Promise<string | null> {
  const signed = await verifySignedRequest(c.env.INBOX_DB, {
    header: c.req.header(SIGNED_REQUEST_HEADER),
    method: c.req.method,
    path,
    nowSeconds: Math.floor(Date.now() / 1_000),
  });
  return signed.ok ? signed.did : null;
}

function notFound(c: RootVaultContext) {
  return c.json({ error: "vault_not_found" }, 404, noStoreHeaders());
}

/**
 * `{ meta }` for a rename; a claim also carries `credentialId` (base64url),
 * which must hash to the locator. The credential ID never reaches the service
 * any other way, so a locator seen in a URL or log can't claim a legacy row
 * (and then delete it) — only a device holding the passkey can.
 */
async function readMetaBody(
  c: RootVaultContext,
  locatorProof?: string,
): Promise<{ ok: true; meta: string } | { ok: false; response: Response }> {
  const decoded = await readLimitedJson(c.req.raw, MAX_REQUEST_BYTES);
  if (!decoded.ok) {
    return {
      ok: false,
      response: c.json(
        { error: decoded.tooLarge ? "record_too_large" : "invalid_record" },
        decoded.tooLarge ? 413 : 400,
        noStoreHeaders(),
      ),
    };
  }
  const body = decoded.value as Record<string, unknown> | null;
  if (
    typeof body !== "object" ||
    body === null ||
    Object.keys(body).length !== (locatorProof === undefined ? 1 : 2) ||
    !isMeta(body.meta) ||
    (locatorProof !== undefined && !provesLocator(body.credentialId, locatorProof))
  ) {
    return {
      ok: false,
      response: c.json({ error: "invalid_record" }, 400, noStoreHeaders()),
    };
  }
  return { ok: true, meta: body.meta };
}

/** Same derivation as shared `rootVaultLocator`: base64url(sha256(credentialId)). */
function provesLocator(credentialId: unknown, locator: string): boolean {
  if (typeof credentialId !== "string" || !CIPHERTEXT_PATTERN.test(credentialId)) return false;
  let bytes: Uint8Array;
  try {
    bytes = base64urlnopad.decode(credentialId);
  } catch {
    return false;
  }
  return bytes.length > 0 && base64urlnopad.encode(sha256(bytes)) === locator;
}

export const rootVaultRouter = new Hono<{ Bindings: CloudflareBindings }>()
  .get("/vault/root", async (c) => {
    const owner = ownerHash(c);
    if (typeof owner !== "string") return unauthorized(c);
    const rows = await c.env.INBOX_DB.prepare(
      `SELECT locator, meta, created_at FROM root_vaults
       WHERE owner = ? ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(owner, MAX_ROWS_PER_OWNER)
      .all<OwnedRow>();
    return c.json(
      {
        rows: rows.results.map((row) => ({
          locator: row.locator,
          meta: row.meta,
          createdAt: row.created_at,
        })),
      },
      200,
      noStoreHeaders(),
    );
  })
  .put("/vault/root/:locator", async (c) => {
    const locator = c.req.param("locator");
    if (!LOCATOR_PATTERN.test(locator)) {
      return c.json({ error: "invalid_locator" }, 400, noStoreHeaders());
    }

    const decoded = await readLimitedJson(c.req.raw, MAX_REQUEST_BYTES);
    if (!decoded.ok) {
      return c.json(
        { error: decoded.tooLarge ? "record_too_large" : "invalid_record" },
        decoded.tooLarge ? 413 : 400,
        noStoreHeaders(),
      );
    }
    const body = decoded.value;
    if (!isRecord(body)) {
      return c.json({ error: "invalid_record" }, 400, noStoreHeaders());
    }
    const owner = ownerHash(c);
    if (owner === null) return unauthorized(c);
    // Metadata is only readable through an owner listing; an unowned row has no use for it.
    if (owner === undefined && body.meta !== undefined) {
      return c.json({ error: "invalid_record" }, 400, noStoreHeaders());
    }
    const ownerDid = owner === undefined ? null : await signer(c, `/vault/root/${locator}`);
    if (owner !== undefined && ownerDid === null) return unauthorized(c);
    const meta = body.meta ?? null;
    const record = { v: body.v, ciphertext: body.ciphertext };

    if (owner !== undefined) {
      const count = await c.env.INBOX_DB.prepare(
        "SELECT COUNT(*) AS n FROM root_vaults WHERE owner = ? AND locator <> ?",
      )
        .bind(owner, locator)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_ROWS_PER_OWNER) {
        return c.json({ error: "too_many_vaults" }, 409, noStoreHeaders());
      }
    }

    const createdAt = Math.floor(Date.now() / 1_000);
    const insert = await c.env.INBOX_DB.prepare(
      `INSERT OR IGNORE INTO root_vaults (locator, version, ciphertext, created_at, owner, meta, owner_did)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(locator, body.v, body.ciphertext, createdAt, owner ?? null, meta, ownerDid)
      .run();

    if ((insert.meta.changes ?? 0) > 0) {
      return c.json(record, 201, noStoreHeaders());
    }

    const existing = await c.env.INBOX_DB.prepare(
      "SELECT version, ciphertext, owner, meta, owner_did FROM root_vaults WHERE locator = ?",
    )
      .bind(locator)
      .first<RootVaultRow>();
    if (
      existing?.version === body.v &&
      existing.ciphertext === body.ciphertext &&
      existing.owner === (owner ?? null) &&
      existing.meta === meta &&
      existing.owner_did === ownerDid
    ) {
      return c.json(record, 200, noStoreHeaders());
    }
    return c.json({ error: "vault_already_exists" }, 409, noStoreHeaders());
  })
  .get("/vault/root/:locator", async (c) => {
    const locator = c.req.param("locator");
    if (!LOCATOR_PATTERN.test(locator)) {
      return c.json({ error: "invalid_locator" }, 400, noStoreHeaders());
    }

    const row = await c.env.INBOX_DB.prepare(
      "SELECT version, ciphertext FROM root_vaults WHERE locator = ?",
    )
      .bind(locator)
      .first<RootVaultRow>();
    if (row === null) return notFound(c);
    return c.json(
      { v: row.version, ciphertext: row.ciphertext },
      200,
      noStoreHeaders(),
    );
  })
  .patch("/vault/root/:locator/meta", async (c) => {
    const locator = c.req.param("locator");
    if (!LOCATOR_PATTERN.test(locator)) return notFound(c);
    const owner = ownerHash(c);
    if (typeof owner !== "string") return unauthorized(c);
    const body = await readMetaBody(c);
    if (!body.ok) return body.response;
    const updated = await c.env.INBOX_DB.prepare(
      "UPDATE root_vaults SET meta = ? WHERE locator = ? AND owner = ?",
    )
      .bind(body.meta, locator, owner)
      .run();
    return (updated.meta.changes ?? 0) > 0
      ? c.json({ ok: true }, 200, noStoreHeaders())
      : notFound(c);
  })
  /**
   * Adopt a row written before the owner index existed. Only an unowned row
   * (or one this owner already holds) can be claimed, only with the passkey's
   * credential ID as proof (`readMetaBody`), so this can never take over a
   * current row or someone else's legacy one. Claiming also binds the row to
   * the signing did when it has none yet.
   */
  .put("/vault/root/:locator/owner", async (c) => {
    const locator = c.req.param("locator");
    if (!LOCATOR_PATTERN.test(locator)) return notFound(c);
    const owner = ownerHash(c);
    if (typeof owner !== "string") return unauthorized(c);
    const did = await signer(c, `/vault/root/${locator}/owner`);
    if (did === null) return unauthorized(c);
    const body = await readMetaBody(c, locator);
    if (!body.ok) return body.response;
    const claimed = await c.env.INBOX_DB.prepare(
      `UPDATE root_vaults SET owner = ?, meta = ?, owner_did = ?
       WHERE locator = ? AND (owner IS NULL OR owner = ?) AND (owner_did IS NULL OR owner_did = ?)`,
    )
      .bind(owner, body.meta, did, locator, owner, did)
      .run();
    return (claimed.meta.changes ?? 0) > 0
      ? c.json({ ok: true }, 200, noStoreHeaders())
      : notFound(c);
  })
  .delete("/vault/root/:locator", async (c) => {
    const locator = c.req.param("locator");
    if (!LOCATOR_PATTERN.test(locator)) return notFound(c);
    const owner = ownerHash(c);
    if (typeof owner !== "string") return unauthorized(c);
    const did = await signer(c, `/vault/root/${locator}`);
    if (did === null) return unauthorized(c);
    // A row from before owner_did existed has only its owner secret to go on.
    const deleted = await c.env.INBOX_DB.prepare(
      "DELETE FROM root_vaults WHERE locator = ? AND owner = ? AND (owner_did = ? OR owner_did IS NULL)",
    )
      .bind(locator, owner, did)
      .run();
    return (deleted.meta.changes ?? 0) > 0
      ? c.body(null, 204, noStoreHeaders())
      : notFound(c);
  });
