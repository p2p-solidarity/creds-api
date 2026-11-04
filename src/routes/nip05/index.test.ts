import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalizeNip98Url } from "../../lib/nip05/auth";
import type { CloudflareBindings } from "../../types/bindings";
import { NONCE_TABLE_SQL } from "../../testing/signRequest";
import { nip05Router } from "./index";

class TestPreparedStatement {
  constructor(
    private readonly database: Database,
    readonly sql: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new TestPreparedStatement(this.database, this.sql, bindings);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.query(this.sql).get(...this.bindings) as T | null) ?? null;
  }

  async all<T>() {
    return { results: this.database.query(this.sql).all(...this.bindings) as T[] };
  }

  run() {
    const result = this.database.query(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: { changes: result.changes },
      results: [],
    };
  }
}

class TestD1Database {
  constructor(private readonly database: Database) {}

  prepare(sql: string) {
    return new TestPreparedStatement(this.database, sql);
  }

  async batch(statements: TestPreparedStatement[]) {
    return this.database.transaction(() => statements.map((statement) => statement.run()))();
  }
}

class MemoryCache {
  private readonly responses = new Map<string, Response>();

  async match(request: Request) {
    return this.responses.get(request.url)?.clone();
  }

  async put(request: Request, response: Response) {
    this.responses.set(request.url, response.clone());
  }

  async delete(request: Request) {
    return this.responses.delete(request.url);
  }
}

const textEncoder = new TextEncoder();
const SECRET_KEY = Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? 1 : 0,
);
const PUBKEY = bytesToHex(schnorr.getPublicKey(SECRET_KEY));
const START_TIME = 2_000_000_000;

let sqlite: Database;
let currentTime: number;
let originalDateNow: typeof Date.now;
let pendingWork: Promise<unknown>[];
let env: CloudflareBindings;
let executionContext: ExecutionContext;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  const migration = await Bun.file(
    new URL("../../../drizzle/0001_nip05.sql", import.meta.url),
  ).text();
  sqlite.exec(migration);
  sqlite.exec(NONCE_TABLE_SQL);

  currentTime = START_TIME;
  originalDateNow = Date.now;
  Date.now = () => currentTime * 1000;
  pendingWork = [];

  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  env = {
    INBOX_DB: new TestD1Database(sqlite) as unknown as D1Database,
    NIP05_WRITE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  } as unknown as CloudflareBindings;
  executionContext = {
    waitUntil: (promise) => {
      pendingWork.push(promise);
    },
    passThroughOnException: () => {},
  } as ExecutionContext;
});

afterEach(() => {
  Date.now = originalDateNow;
  sqlite.close();
  Reflect.deleteProperty(globalThis, "caches");
});

async function flushPendingWork() {
  await Promise.all(pendingWork.splice(0));
}

function authorization(
  method: string,
  url: string,
  body?: string,
  secret: Uint8Array = SECRET_KEY,
): string {
  const tags = [
    ["u", canonicalizeNip98Url(url)],
    ["method", method],
  ];
  if (body !== undefined) {
    tags.push(["payload", bytesToHex(sha256(textEncoder.encode(body)))]);
  }

  const event = {
    id: "",
    pubkey: bytesToHex(schnorr.getPublicKey(secret)),
    content: "",
    kind: 27_235,
    created_at: currentTime,
    tags,
    sig: "",
  };
  event.id = bytesToHex(
    sha256(
      textEncoder.encode(
        JSON.stringify([
          0,
          event.pubkey,
          event.created_at,
          event.kind,
          event.tags,
          event.content,
        ]),
      ),
    ),
  );
  event.sig = bytesToHex(
    schnorr.sign(hexToBytes(event.id), secret, new Uint8Array(32)),
  );
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

async function fetchRoute(request: Request) {
  const response = await nip05Router.fetch(request, env, executionContext);
  await flushPendingWork();
  return response;
}

describe("NIP-05 endpoints", () => {
  test("registers, resolves, reports availability, and releases a handle", async () => {
    const availabilityBefore = await fetchRoute(
      new Request("https://creds.id/id/availability?name=AliceX"),
    );
    expect(availabilityBefore.status).toBe(200);
    expect(availabilityBefore.headers.get("cache-control")).toBe("no-store");
    expect(await availabilityBefore.json()).toEqual({
      name: "alicex",
      available: true,
    });

    const body =
      '{"name":"AliceX","relays":["wss://relay.primal.net"],"consent":true}';
    const registerUrl = "https://creds.id/id/register";
    const registered = await fetchRoute(
      new Request(registerUrl, {
        method: "POST",
        headers: {
          authorization: authorization("POST", registerUrl, body),
          "content-type": "application/json",
        },
        body,
      }),
    );
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual({
      name: "alicex",
      pubkey: PUBKEY,
      identifier: "alicex@creds.id",
    });

    const resolved = await fetchRoute(
      new Request(
        "https://creds.id/.well-known/nostr.json?name=ALICEX",
      ),
    );
    expect(resolved.status).toBe(200);
    expect(resolved.headers.get("access-control-allow-origin")).toBe("*");
    expect(resolved.headers.get("cache-control")).toBe(
      "public, max-age=300",
    );
    expect(await resolved.json()).toEqual({
      names: { alicex: PUBKEY },
      relays: { [PUBKEY]: ["wss://relay.primal.net"] },
    });

    const availabilityAfter = await fetchRoute(
      new Request("https://creds.id/id/availability?name=alicex"),
    );
    expect(await availabilityAfter.json()).toEqual({
      name: "alicex",
      available: false,
      reason: "taken",
    });

    currentTime += 1;
    const deleteUrl = "https://creds.id/id";
    const released = await fetchRoute(
      new Request(deleteUrl, {
        method: "DELETE",
        headers: {
          authorization: authorization("DELETE", deleteUrl),
        },
      }),
    );
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ released: "alicex" });

    const resolvedAfterRelease = await fetchRoute(
      new Request(
        "https://creds.id/.well-known/nostr.json?name=alicex",
      ),
    );
    expect(await resolvedAfterRelease.json()).toEqual({ names: {} });

    const availabilityReleased = await fetchRoute(
      new Request("https://creds.id/id/availability?name=alicex"),
    );
    expect(await availabilityReleased.json()).toEqual({
      name: "alicex",
      available: false,
      reason: "tombstoned",
    });

    // G5 read side: the marker survives release, because someone holding an
    // older printed card is exactly who needs to see it.
    const history = await fetchRoute(
      new Request("https://creds.id/id/history?name=alicex"),
    );
    expect(history.status).toBe(200);
    expect(history.headers.get("cache-control")).toBe("no-store");
    expect(await history.json()).toEqual({
      name: "alicex",
      status: "released",
      redirectTo: null,
      redirectUntil: null,
      rebindGeneration: 0,
      reboundAt: null,
    });
  });

  test("reports no history for a name that was never registered", async () => {
    const response = await fetchRoute(
      new Request("https://creds.id/id/history?name=nobody0"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "name_not_found" });
  });

  test("exposes a live rename redirect and its 90-day retry boundary", async () => {
    const registerUrl = "https://creds.id/id/register";
    const register = async (name: string): Promise<Response> => {
      const body = JSON.stringify({ name, consent: true });
      return fetchRoute(
        new Request(registerUrl, {
          method: "POST",
          headers: {
            authorization: authorization("POST", registerUrl, body),
            "content-type": "application/json",
          },
          body,
        }),
      );
    };

    expect((await register("alice1")).status).toBe(200);
    currentTime += 1;
    expect((await register("bravo1")).status).toBe(200);

    const redirectUntil = currentTime + 90 * 24 * 60 * 60;
    const history = await fetchRoute(
      new Request("https://creds.id/id/history?name=alice1"),
    );
    expect(await history.json()).toMatchObject({
      status: "redirected",
      redirectTo: "bravo1",
      redirectUntil,
    });

    currentTime += 1;
    const blocked = await register("charlie1");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: "rename_too_soon",
      retryAt: redirectUntil,
    });
  });

  test("refuses an oversized register or recover body before reading it all", async () => {
    for (const path of ["/id/register", "/id/recover"]) {
      const url = `https://creds.id${path}`;
      const body = JSON.stringify({ name: "alicex", consent: true, pad: "x".repeat(40_000) });
      // Streamed with no Content-Length, so only the running byte count can stop it.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      const request = new Request(url, {
        method: "POST",
        headers: { authorization: authorization("POST", url, body), "content-type": "application/json" },
        body: stream,
      });
      request.headers.delete("content-length");
      const response = await fetchRoute(request);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "request_too_large" });
    }
  });

  test("refuses recovery without evidence instead of falling back to a human", async () => {
    const url = "https://creds.id/id/recover";
    const body = JSON.stringify({
      name: "alicex",
      oldRecordJws: "not.a.jws",
      newRecordJws: "not.a.jws",
      binding: "dns:example.com",
      consent: true,
    });
    const response = await fetchRoute(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: authorization("POST", url, body),
          "content-type": "application/json",
        },
        body,
      }),
    );
    // No registration exists yet, so there is nothing to recover — and
    // critically, no manual-review path to escalate into.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "name_not_found" });
  });

  test("account erase unlinks every name of the pubkey but keeps them reserved", async () => {
    const registerUrl = "https://creds.id/id/register";
    const register = async (name: string, secret = SECRET_KEY): Promise<Response> => {
      const body = JSON.stringify({ name, consent: true });
      return fetchRoute(
        new Request(registerUrl, {
          method: "POST",
          headers: {
            authorization: authorization("POST", registerUrl, body, secret),
            "content-type": "application/json",
          },
          body,
        }),
      );
    };
    expect((await register("alice1")).status).toBe(200);
    currentTime += 1;
    expect((await register("bravo1")).status).toBe(200);

    const eraseUrl = "https://creds.id/id/account";
    // A NIP-98 event for another URL (the plain release) must not erase.
    const wrongUrl = await fetchRoute(
      new Request(eraseUrl, {
        method: "DELETE",
        headers: { authorization: authorization("DELETE", "https://creds.id/id") },
      }),
    );
    expect(wrongUrl.status).toBe(401);

    currentTime += 1;
    const erased = await fetchRoute(
      new Request(eraseUrl, {
        method: "DELETE",
        headers: { authorization: authorization("DELETE", eraseUrl) },
      }),
    );
    expect(erased.status).toBe(200);
    expect(((await erased.json()) as { erased: string[] }).erased.sort()).toEqual(["alice1", "bravo1"]);

    // No row and no audit entry still carries the pubkey.
    expect(sqlite.query("SELECT COUNT(*) AS n FROM nip05_handles WHERE pubkey = ?").get(PUBKEY)).toEqual({ n: 0 });
    expect(sqlite.query("SELECT COUNT(*) AS n FROM nip05_audit WHERE pubkey = ?").get(PUBKEY)).toEqual({ n: 0 });
    expect(sqlite.query("SELECT DISTINCT status FROM nip05_handles").all()).toEqual([{ status: "released" }]);

    const resolved = await fetchRoute(new Request("https://creds.id/.well-known/nostr.json?name=bravo1"));
    expect(await resolved.json()).toEqual({ names: {} });
    const availability = await fetchRoute(new Request("https://creds.id/id/availability?name=bravo1"));
    expect(await availability.json()).toEqual({ name: "bravo1", available: false, reason: "tombstoned" });

    // Neither a stranger nor the old key can take the name back.
    currentTime += 1;
    const stranger = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 2 : 0));
    expect((await register("bravo1", stranger)).status).toBe(409);
    expect((await register("bravo1")).status).toBe(409);
  });
});
