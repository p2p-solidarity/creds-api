import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { CloudflareBindings } from "../../types/bindings";
import { bytesToBase64 } from "../../lib/inbox/crypto";
import { NONCE_TABLE_SQL } from "../../testing/signRequest";
import { deleteAllPayload } from "./deleteAll";
import { inboxRouter } from "./index";

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUBKEY = bytesToBase64(ed25519.getPublicKey(SECRET));

let sqlite: Database;
let env: CloudflareBindings;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec(await Bun.file(new URL("../../../drizzle/0000_inbox.sql", import.meta.url)).text());
  sqlite.exec(NONCE_TABLE_SQL);
  const db = {
    prepare: (sql: string) => ({
      bind: (...bindings: unknown[]) => ({
        run: async () => ({ meta: { changes: sqlite.query(sql).run(...(bindings as never[])).changes } }),
      }),
    }),
  };
  env = { INBOX_DB: db } as unknown as CloudflareBindings;
  const insert = sqlite.query("INSERT INTO inbox VALUES (?, ?, 'blob', 0)");
  insert.run("a", PUBKEY);
  insert.run("b", PUBKEY);
  insert.run("c", "someone-else");
});

const send = (body: unknown) =>
  inboxRouter.fetch(
    new Request("https://x.test/inbox/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
const now = () => Math.floor(Date.now() / 1000);
const NONCE = "nonce-0123456789abcdef";
const sign = (payload: Uint8Array) => bytesToBase64(ed25519.sign(payload, SECRET));

describe("POST /inbox/delete", () => {
  test("deletes every message of the signing key and nothing else, once per nonce", async () => {
    const ts = now();
    const request = { pubkey: PUBKEY, ts, nonce: NONCE, sig: sign(deleteAllPayload(PUBKEY, ts, NONCE)) };
    const response = await send(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 2 });
    expect(sqlite.query("SELECT id FROM inbox").all()).toEqual([{ id: "c" }]);
    expect((await send(request)).status).toBe(401);
  });

  test("refuses the static sync signature and stale requests", async () => {
    const ts = now();
    const syncSig = sign(new TextEncoder().encode(PUBKEY));
    expect((await send({ pubkey: PUBKEY, ts, nonce: NONCE, sig: syncSig })).status).toBe(401);
    const old = ts - 301;
    expect((await send({ pubkey: PUBKEY, ts: old, nonce: NONCE, sig: sign(deleteAllPayload(PUBKEY, old, NONCE)) })).status).toBe(401);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM inbox").get()).toEqual({ n: 3 });
  });
});
