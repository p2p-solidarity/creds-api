import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import type { CloudflareBindings } from "../../types/bindings";
import { rootVaultRouter } from "./index";

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

  allRows<T>(): T[] {
    return this.database.query(this.sql).all(...(this.bindings as never[])) as T[];
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.allRows<T>() };
  }

  run() {
    const result = this.database.query(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: result.changes }, results: [] };
  }
}

class TestD1Database {
  constructor(private readonly database: Database) {}

  prepare(sql: string) {
    return new TestPreparedStatement(this.database, sql);
  }
}

const LOCATOR = "A".repeat(43);
const RECORD = { v: 1, ciphertext: "B".repeat(80) };

let sqlite: Database;
let env: CloudflareBindings;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE root_vaults (
      locator TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      owner TEXT,
      meta TEXT
    );
  `);
  env = {
    INBOX_DB: new TestD1Database(sqlite) as unknown as D1Database,
  } as CloudflareBindings;
});

async function fetchRoute(request: Request) {
  return rootVaultRouter.fetch(request, env);
}

describe("root vault endpoints", () => {
  test("creates and reads an opaque vault record", async () => {
    const created = await fetchRoute(
      new Request(`https://creds.id/vault/root/${LOCATOR}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(RECORD),
      }),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(RECORD);

    const fetched = await fetchRoute(
      new Request(`https://creds.id/vault/root/${LOCATOR}`),
    );
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("cache-control")).toBe("no-store");
    expect(await fetched.json()).toEqual(RECORD);
  });

  test("is idempotent for the same bytes and rejects replacement ciphertext", async () => {
    const put = (record: typeof RECORD) =>
      fetchRoute(
        new Request(`https://creds.id/vault/root/${LOCATOR}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record),
        }),
      );

    expect((await put(RECORD)).status).toBe(201);
    expect((await put(RECORD)).status).toBe(200);

    const replaced = await put({ ...RECORD, ciphertext: "C".repeat(80) });
    expect(replaced.status).toBe(409);
    expect(await replaced.json()).toEqual({ error: "vault_already_exists" });
  });

  test("accepts no identity metadata and discloses no existence for malformed locators", async () => {
    const metadata = await fetchRoute(
      new Request(`https://creds.id/vault/root/${LOCATOR}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...RECORD, did: "did:key:plaintext" }),
      }),
    );
    expect(metadata.status).toBe(400);

    const malformed = await fetchRoute(
      new Request("https://creds.id/vault/root/not-a-valid-locator"),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");

    const missing = await fetchRoute(
      new Request(`https://creds.id/vault/root/${LOCATOR}`),
    );
    expect(missing.status).toBe(404);
  });

  test("stops a headerless request body once it exceeds 4 KB", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(5_000)));
        controller.close();
      },
    });
    const request = new Request(`https://creds.id/vault/root/${LOCATOR}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    request.headers.delete("content-length");

    const response = await fetchRoute(request);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

/** 32-byte secrets in canonical base64url (43 chars, zero padding bits). */
const OWNER_SECRET = `${"S".repeat(42)}A`;
const OTHER_SECRET = `${"T".repeat(42)}A`;
const META = "M".repeat(60);
const LOCATOR_2 = "Z".repeat(43);

function bearer(secret: string) {
  return { authorization: `Bearer ${secret}` };
}

async function putVault(
  locator: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetchRoute(
    new Request(`https://creds.id/vault/root/${locator}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function list(secret?: string) {
  return fetchRoute(
    new Request("https://creds.id/vault/root", {
      headers: secret === undefined ? {} : bearer(secret),
    }),
  );
}

describe("root vault owner index", () => {
  test("an owned create lists for that owner only and the public read stays ciphertext-only", async () => {
    expect(
      (await putVault(LOCATOR, { ...RECORD, meta: META }, bearer(OWNER_SECRET))).status,
    ).toBe(201);
    expect((await putVault(LOCATOR_2, RECORD, bearer(OTHER_SECRET))).status).toBe(201);

    const read = await fetchRoute(new Request(`https://creds.id/vault/root/${LOCATOR}`));
    expect(await read.json()).toEqual(RECORD);

    const listed = await list(OWNER_SECRET);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const body = (await listed.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toEqual({
      locator: LOCATOR,
      meta: META,
      createdAt: expect.any(Number),
    });
  });

  test("stores a hash of the owner secret, never the secret", async () => {
    await putVault(LOCATOR, RECORD, bearer(OWNER_SECRET));
    const row = sqlite.query("SELECT owner FROM root_vaults").get() as { owner: string };
    expect(row.owner).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.owner).not.toBe(OWNER_SECRET);
  });

  test("listing needs a well-formed bearer secret", async () => {
    expect((await list()).status).toBe(401);
    expect((await list("short")).status).toBe(401);
    const empty = await list(OWNER_SECRET);
    expect(((await empty.json()) as { rows: unknown[] }).rows).toEqual([]);
  });

  test("an idempotent retry must repeat owner and meta byte for byte", async () => {
    expect((await putVault(LOCATOR, { ...RECORD, meta: META }, bearer(OWNER_SECRET))).status).toBe(201);
    expect((await putVault(LOCATOR, { ...RECORD, meta: META }, bearer(OWNER_SECRET))).status).toBe(200);
    expect((await putVault(LOCATOR, { ...RECORD, meta: META }, bearer(OTHER_SECRET))).status).toBe(409);
    expect((await putVault(LOCATOR, { ...RECORD, meta: "N".repeat(60) }, bearer(OWNER_SECRET))).status).toBe(409);
  });

  test("rejects malformed meta", async () => {
    expect((await putVault(LOCATOR, { ...RECORD, meta: "not base64url!" }, bearer(OWNER_SECRET))).status).toBe(400);
    expect((await putVault(LOCATOR, { ...RECORD, meta: "M".repeat(3000) }, bearer(OWNER_SECRET))).status).toBe(400);
    expect((await putVault(LOCATOR, { ...RECORD, meta: META })).status).toBe(400);
  });

  test("renames only for the owner and hides other owners' rows", async () => {
    await putVault(LOCATOR, { ...RECORD, meta: META }, bearer(OWNER_SECRET));
    const patch = (secret: string, meta: string) =>
      fetchRoute(
        new Request(`https://creds.id/vault/root/${LOCATOR}/meta`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...bearer(secret) },
          body: JSON.stringify({ meta }),
        }),
      );
    expect((await patch(OTHER_SECRET, "X".repeat(60))).status).toBe(404);
    expect((await patch(OWNER_SECRET, "Y".repeat(60))).status).toBe(200);
    const body = (await (await list(OWNER_SECRET)).json()) as { rows: Array<{ meta: string }> };
    expect(body.rows[0]?.meta).toBe("Y".repeat(60));
    const read = await fetchRoute(new Request(`https://creds.id/vault/root/${LOCATOR}`));
    expect(await read.json()).toEqual(RECORD);
  });

  test("claims a legacy unowned row once, never someone else's", async () => {
    await putVault(LOCATOR, RECORD);
    const claim = (secret: string) =>
      fetchRoute(
        new Request(`https://creds.id/vault/root/${LOCATOR}/owner`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...bearer(secret) },
          body: JSON.stringify({ meta: META }),
        }),
      );
    expect((await claim(OWNER_SECRET)).status).toBe(200);
    expect((await claim(OWNER_SECRET)).status).toBe(200);
    expect((await claim(OTHER_SECRET)).status).toBe(404);
    const owned = (await (await list(OWNER_SECRET)).json()) as { rows: unknown[] };
    expect(owned.rows).toHaveLength(1);
    const other = (await (await list(OTHER_SECRET)).json()) as { rows: unknown[] };
    expect(other.rows).toHaveLength(0);
  });

  test("deletes only for the owner; an unowned row cannot be deleted", async () => {
    await putVault(LOCATOR, RECORD);
    await putVault(LOCATOR_2, RECORD, bearer(OWNER_SECRET));
    const del = (locator: string, secret?: string) =>
      fetchRoute(
        new Request(`https://creds.id/vault/root/${locator}`, {
          method: "DELETE",
          headers: secret === undefined ? {} : bearer(secret),
        }),
      );
    expect((await del(LOCATOR, OWNER_SECRET)).status).toBe(404);
    expect((await del(LOCATOR_2)).status).toBe(401);
    expect((await del(LOCATOR_2, OTHER_SECRET)).status).toBe(404);
    expect((await del(LOCATOR_2, OWNER_SECRET)).status).toBe(204);
    expect((await fetchRoute(new Request(`https://creds.id/vault/root/${LOCATOR_2}`))).status).toBe(404);
    expect((await fetchRoute(new Request(`https://creds.id/vault/root/${LOCATOR}`))).status).toBe(200);
  });
});
