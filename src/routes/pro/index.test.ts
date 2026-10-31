import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import type { CloudflareBindings } from "../../types/bindings";
import { didKeyFromScalar } from "../../lib/pro/license";
import { proRouter } from "./index";

const utf8 = new TextEncoder();
const SCALAR = "33".repeat(32);
const OTHER = "44".repeat(32);

function signRequest(scalar: string, payload: Record<string, unknown>, kidScalar = scalar): string {
  const header = base64urlnopad.encode(utf8.encode(JSON.stringify({ alg: "ES256", kid: `${didKeyFromScalar(kidScalar)}#0` })));
  const body = base64urlnopad.encode(utf8.encode(JSON.stringify(payload)));
  const sig = p256.sign(sha256(utf8.encode(`${header}.${body}`)), Uint8Array.from(Buffer.from(scalar, "hex")), { prehash: false });
  return `${header}.${body}.${base64urlnopad.encode(sig)}`;
}

let sqlite: Database;
let env: CloudflareBindings;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec(await Bun.file(new URL("../../../drizzle/0004_pro_bindings.sql", import.meta.url)).text());
  const db = {
    prepare: (sql: string) => ({
      bind: (...bindings: unknown[]) => ({
        run: async () => ({ meta: { changes: sqlite.query(sql).run(...(bindings as never[])).changes } }),
      }),
    }),
  };
  env = { INBOX_DB: db } as unknown as CloudflareBindings;
  const insert = sqlite.query("INSERT INTO pro_bindings VALUES (?, ?, 'p', 0, 0)");
  insert.run("ios:1", didKeyFromScalar(SCALAR));
  insert.run("ios:2", didKeyFromScalar(OTHER));
});

const remove = (request: string) =>
  proRouter.fetch(
    new Request("https://creds.id/pro/binding", { method: "DELETE", body: JSON.stringify({ request }) }),
    env,
  );
const now = () => Math.floor(Date.now() / 1000);
const owner = didKeyFromScalar(SCALAR);

describe("DELETE /pro/binding", () => {
  test("drops only the signing did's rows", async () => {
    const response = await remove(signRequest(SCALAR, { did: owner, aud: "creds.id/pro/binding/delete", iat: now() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1 });
    expect(sqlite.query("SELECT purchase_key FROM pro_bindings").all()).toEqual([{ purchase_key: "ios:2" }]);
  });

  test("refuses a request signed by another key, for another audience, or stale", async () => {
    const forged = signRequest(OTHER, { did: owner, aud: "creds.id/pro/binding/delete", iat: now() }, SCALAR);
    expect((await remove(forged)).status).toBe(401);
    const licenseRequest = signRequest(SCALAR, { did: owner, aud: "creds.id/pro/license", iat: now() });
    expect((await remove(licenseRequest)).status).toBe(401);
    const stale = signRequest(SCALAR, { did: owner, aud: "creds.id/pro/binding/delete", iat: now() - 301 });
    expect((await remove(stale)).status).toBe(401);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM pro_bindings").get()).toEqual({ n: 2 });
  });
});
