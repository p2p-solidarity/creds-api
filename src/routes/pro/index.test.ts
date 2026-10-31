import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { CloudflareBindings } from "../../types/bindings";
import { didKeyFromScalar } from "../../lib/pro/license";
import { NONCE_TABLE_SQL, signRequest } from "../../testing/signRequest";
import { proRouter } from "./index";

const SCALAR = "33".repeat(32);
const OTHER = "44".repeat(32);

let sqlite: Database;
let env: CloudflareBindings;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec(await Bun.file(new URL("../../../drizzle/0004_pro_bindings.sql", import.meta.url)).text());
  sqlite.exec(NONCE_TABLE_SQL);
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

const remove = (signature?: string) =>
  proRouter.fetch(
    new Request("https://creds.id/pro/binding", {
      method: "DELETE",
      headers: signature === undefined ? {} : { "x-creds-signature": signature },
    }),
    env,
  );

describe("DELETE /pro/binding", () => {
  test("drops only the signing did's rows, once per signed request", async () => {
    const header = signRequest(SCALAR, { m: "DELETE", p: "/pro/binding" });
    const response = await remove(header);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1 });
    expect(sqlite.query("SELECT purchase_key FROM pro_bindings").all()).toEqual([{ purchase_key: "ios:2" }]);
    expect((await remove(header)).status).toBe(401);
  });

  test("refuses unsigned, forged, mis-targeted or stale requests", async () => {
    expect((await remove()).status).toBe(400);
    expect((await remove(signRequest(OTHER, { m: "DELETE", p: "/pro/binding" }, SCALAR))).status).toBe(401);
    expect((await remove(signRequest(SCALAR, { m: "DELETE", p: "/vault/root/x" }))).status).toBe(401);
    expect((await remove(signRequest(SCALAR, { m: "DELETE", p: "/pro/binding", aud: "creds.id/pro/license" }))).status).toBe(401);
    expect((await remove(signRequest(SCALAR, { m: "DELETE", p: "/pro/binding", iat: Math.floor(Date.now() / 1000) - 301 }))).status).toBe(401);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM pro_bindings").get()).toEqual({ n: 2 });
  });
});
