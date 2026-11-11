import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { ERASED_NAME_COOLDOWN_SECONDS } from "./constants";
import {
  ERASED_PUBKEY,
  eraseHandlesForPubkey,
  findActiveDirectoryEntry,
  getHandleRebindInfo,
  getStoredNameState,
  purgeExpiredNip05Data,
  recoverHandle,
  registerHandle,
  releaseHandle,
  type RecoverHandleInput,
  type RegisterHandleInput,
  type ReleaseHandleInput,
} from "./repository";

/** Far enough ahead to have outlived any window the old quarantine used. */
const A_YEAR = 365 * 24 * 60 * 60;

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

  async all<T>(): Promise<{ results: T[] }> {
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

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);
const PUBKEY_C = "c".repeat(64);
const START_TIME = 2_000_000_000;

let sqlite: Database;
let d1: D1Database;
let eventSequence: number;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  const migration = await Bun.file(
    new URL("../../../drizzle/0001_nip05.sql", import.meta.url),
  ).text();
  sqlite.exec(migration);
  d1 = new TestD1Database(sqlite) as unknown as D1Database;
  eventSequence = 0;
});

afterEach(() => {
  sqlite.close();
});

function registration(
  name: string,
  overrides: Partial<RegisterHandleInput> = {},
): RegisterHandleInput {
  eventSequence += 1;
  return {
    name,
    pubkey: PUBKEY_A,
    relays: [],
    eventId: eventSequence.toString(16).padStart(64, "0"),
    authEvent: `{"sequence":${eventSequence}}`,
    nowSeconds: START_TIME + eventSequence,
    ...overrides,
  };
}

function deletion(
  overrides: Partial<ReleaseHandleInput> = {},
): ReleaseHandleInput {
  eventSequence += 1;
  return {
    pubkey: PUBKEY_A,
    eventId: eventSequence.toString(16).padStart(64, "0"),
    authEvent: `{"sequence":${eventSequence}}`,
    nowSeconds: START_TIME + eventSequence,
    ...overrides,
  };
}

describe("NIP-05 repository", () => {
  test("registers atomically, updates relays idempotently, and rejects event replay", async () => {
    const first = registration("alice", {
      relays: ["wss://relay.one"],
    });
    expect(await registerHandle(d1, first)).toEqual({
      ok: true,
      name: "alice",
      pubkey: PUBKEY_A,
      previousName: null,
    });
    expect(await findActiveDirectoryEntry(d1, "alice")).toEqual({
      name: "alice",
      pubkey: PUBKEY_A,
      relays: ["wss://relay.one"],
    });

    expect(await registerHandle(d1, first)).toEqual({
      ok: false,
      error: "replay",
    });

    expect(
      await registerHandle(
        d1,
        registration("alice", { relays: ["wss://relay.two"] }),
      ),
    ).toMatchObject({ ok: true, previousName: null });
    expect(await findActiveDirectoryEntry(d1, "alice")).toMatchObject({
      relays: ["wss://relay.two"],
    });
  });

  test("redirects an old name for 90 days and permits only one rename in that window", async () => {
    const firstRenameAt = START_TIME + 10;
    const redirectExpiresAt = firstRenameAt + 90 * 24 * 60 * 60;

    await registerHandle(d1, registration("alice", { nowSeconds: START_TIME }));
    expect(
      await registerHandle(
        d1,
        registration("bravo", { nowSeconds: firstRenameAt }),
      ),
    ).toMatchObject({ ok: true, previousName: "alice" });

    expect(
      await getHandleRebindInfo(d1, "alice", firstRenameAt + 1),
    ).toMatchObject({
      status: "redirected",
      redirectTo: "bravo",
      redirectUntil: redirectExpiresAt,
    });
    expect(
      await registerHandle(
        d1,
        registration("charlie", { nowSeconds: redirectExpiresAt - 1 }),
      ),
    ).toEqual({
      ok: false,
      error: "rename_too_soon",
      retryAt: redirectExpiresAt,
    });

    expect(
      await getHandleRebindInfo(d1, "alice", redirectExpiresAt),
    ).toMatchObject({ status: "released", redirectTo: null, redirectUntil: null });
    expect(
      await registerHandle(
        d1,
        registration("charlie", { nowSeconds: redirectExpiresAt }),
      ),
    ).toMatchObject({ ok: true, previousName: "bravo" });
  });

  test("allows the first rename and rejects another before 90 days", async () => {
    await registerHandle(d1, registration("alice"));
    await registerHandle(d1, registration("alice"));

    expect(await registerHandle(d1, registration("bravo"))).toMatchObject({
      ok: true,
      previousName: "alice",
    });
    expect(await registerHandle(d1, registration("charlie"))).toMatchObject({
      ok: false,
      error: "rename_too_soon",
    });
    expect(await getStoredNameState(d1, "alice")).toEqual({
      state: "tombstoned",
    });
    expect(await findActiveDirectoryEntry(d1, "bravo")).not.toBeNull();
  });

  test("does not let releases reset the rename window", async () => {
    await registerHandle(d1, registration("alice"));
    await registerHandle(d1, registration("bravo"));
    await releaseHandle(d1, deletion());
    expect(await registerHandle(d1, registration("charlie"))).toMatchObject({
      ok: false,
      error: "rename_too_soon",
    });
  });

  test("keeps enforcing the rename window after its audit row ages out", async () => {
    const oldRegistrationTime = START_TIME - 100 * 24 * 60 * 60;
    await registerHandle(
      d1,
      registration("alice", { nowSeconds: oldRegistrationTime }),
    );
    await registerHandle(
      d1,
      registration("bravo", { nowSeconds: START_TIME }),
    );
    await purgeExpiredNip05Data(d1, START_TIME + 1);

    expect(
      await registerHandle(
        d1,
        registration("charlie", { nowSeconds: START_TIME + 2 }),
      ),
    ).toMatchObject({ ok: false, error: "rename_too_soon" });
  });

  // G3. This is what makes `/@name` safe to print on a business card: a
  // released name can never come back pointing at a stranger.
  test("tombstones released names permanently while still allowing owner reclaim", async () => {
    await registerHandle(d1, registration("alice"));
    const releasedAt = START_TIME + 10;
    expect(
      await releaseHandle(d1, deletion({ nowSeconds: releasedAt })),
    ).toEqual({ ok: true, released: "alice" });

    expect(
      await registerHandle(
        d1,
        registration("alice", { pubkey: PUBKEY_B, nowSeconds: releasedAt + 1 }),
      ),
    ).toEqual({ ok: false, error: "name_taken" });

    // A year on — the old quarantine would long since have expired here.
    expect(
      await registerHandle(
        d1,
        registration("alice", {
          pubkey: PUBKEY_B,
          nowSeconds: releasedAt + A_YEAR,
        }),
      ),
    ).toEqual({ ok: false, error: "name_taken" });
    expect(await getStoredNameState(d1, "alice")).toEqual({
      state: "tombstoned",
    });

    // The original holder can still take it back, indefinitely.
    expect(
      await registerHandle(
        d1,
        registration("alice", { nowSeconds: releasedAt + A_YEAR + 1 }),
      ),
    ).toMatchObject({ ok: true, previousName: null });
    expect(await findActiveDirectoryEntry(d1, "alice")).toMatchObject({
      pubkey: PUBKEY_A,
    });
  });

  test("never purges handle rows, only aged-out audit rows", async () => {
    await registerHandle(d1, registration("alice"));
    await releaseHandle(d1, deletion({ nowSeconds: START_TIME + 10 }));

    const purged = await purgeExpiredNip05Data(d1, START_TIME + 10 * A_YEAR);
    expect(purged.audits).toBeGreaterThan(0);

    // Surviving the purge is the whole point: if the row were deleted the
    // name would silently become registrable by anyone.
    expect(await getStoredNameState(d1, "alice")).toEqual({
      state: "tombstoned",
    });
  });

  describe("recoverHandle", () => {
    function recovery(
      name: string,
      overrides: Partial<RecoverHandleInput> = {},
    ): RecoverHandleInput {
      eventSequence += 1;
      return {
        name,
        expectedPubkey: PUBKEY_A,
        pubkey: PUBKEY_B,
        eventId: eventSequence.toString(16).padStart(64, "0"),
        authEvent: `{"sequence":${eventSequence}}`,
        nowSeconds: START_TIME + eventSequence,
        ...overrides,
      };
    }

    test("rebinds the name and stamps a permanent generation marker", async () => {
      await registerHandle(d1, registration("alice"));

      expect(await recoverHandle(d1, recovery("alice"))).toMatchObject({
        ok: true,
        pubkey: PUBKEY_B,
        rebindGeneration: 1,
        releasedName: null,
      });
      expect(await findActiveDirectoryEntry(d1, "alice")).toMatchObject({
        pubkey: PUBKEY_B,
      });

      // G5: monotonic, never reset — a second recovery keeps counting.
      expect(
        await recoverHandle(
          d1,
          recovery("alice", { expectedPubkey: PUBKEY_B, pubkey: PUBKEY_A }),
        ),
      ).toMatchObject({ ok: true, rebindGeneration: 2 });
    });

    test("releases the applicant's current name so the unique index allows the rebind", async () => {
      await registerHandle(d1, registration("alice"));
      await registerHandle(d1, registration("bravo0", { pubkey: PUBKEY_B }));

      expect(await recoverHandle(d1, recovery("alice"))).toMatchObject({
        ok: true,
        releasedName: "bravo0",
      });
      expect(await findActiveDirectoryEntry(d1, "alice")).toMatchObject({
        pubkey: PUBKEY_B,
      });
      expect(await getStoredNameState(d1, "bravo0")).toEqual({
        state: "tombstoned",
      });
    });

    test("refuses when the directory moved under the request", async () => {
      await registerHandle(d1, registration("alice"));
      expect(
        await recoverHandle(d1, recovery("alice", { expectedPubkey: PUBKEY_B })),
      ).toEqual({ ok: false, error: "state_changed" });
    });

    test("refuses unknown and tombstoned names", async () => {
      expect(await recoverHandle(d1, recovery("ghost0"))).toEqual({
        ok: false,
        error: "name_not_found",
      });

      await registerHandle(d1, registration("alice"));
      await releaseHandle(d1, deletion());
      // A name its holder deliberately gave up must not be recoverable.
      expect(await recoverHandle(d1, recovery("alice"))).toEqual({
        ok: false,
        error: "name_not_found",
      });
    });

    test("rejects a replayed recovery event", async () => {
      await registerHandle(d1, registration("alice"));
      const input = recovery("alice");
      expect(await recoverHandle(d1, input)).toMatchObject({ ok: true });
      expect(await recoverHandle(d1, input)).toEqual({
        ok: false,
        error: "replay",
      });
    });
  });

  test("audits idempotent no-op deletion so the signed event cannot replay", async () => {
    const input = deletion();
    expect(await releaseHandle(d1, input)).toEqual({
      ok: true,
      released: null,
    });
    expect(await releaseHandle(d1, input)).toEqual({
      ok: false,
      error: "replay",
    });
  });

  // G3a. An erased name (account deleted, or blocked by the operator) has no
  // holder left who could reclaim it, so after the cooldown anyone may take it
  // over — on the SAME row, so G5's rebind marker tells holders of an old link.
  describe("erased-name release", () => {
    const ERASED_AT = START_TIME + 1_000;
    const COOLED = ERASED_AT + ERASED_NAME_COOLDOWN_SECONDS;

    function rawRow(name: string) {
      return sqlite
        .query("SELECT * FROM nip05_handles WHERE name = ?")
        .get(name) as Record<string, unknown>;
    }

    test("stays taken for everyone until the cooldown ends", async () => {
      await registerHandle(d1, registration("alice"));
      await eraseHandlesForPubkey(d1, { pubkey: PUBKEY_A, nowSeconds: ERASED_AT });

      expect(await getStoredNameState(d1, "alice", COOLED - 1)).toEqual({ state: "tombstoned" });
      expect(
        await registerHandle(d1, registration("alice", { pubkey: PUBKEY_B, nowSeconds: COOLED - 1 })),
      ).toEqual({ ok: false, error: "name_taken" });
      expect(rawRow("alice")).toMatchObject({ pubkey: ERASED_PUBKEY, status: "released" });
    });

    test("after the cooldown a new key takes over the same row as a rebind", async () => {
      await registerHandle(d1, registration("alice"));
      await eraseHandlesForPubkey(d1, { pubkey: PUBKEY_A, nowSeconds: ERASED_AT });

      expect(await getStoredNameState(d1, "alice", COOLED)).toEqual({ state: "available" });
      expect(
        await registerHandle(
          d1,
          registration("alice", { pubkey: PUBKEY_B, relays: ["wss://relay.example"], nowSeconds: COOLED }),
        ),
      ).toEqual({ ok: true, name: "alice", pubkey: PUBKEY_B, previousName: null });

      expect(await findActiveDirectoryEntry(d1, "alice")).toEqual({
        name: "alice",
        pubkey: PUBKEY_B,
        relays: ["wss://relay.example"],
      });
      expect(await getHandleRebindInfo(d1, "alice", COOLED)).toMatchObject({
        status: "active",
        rebindGeneration: 1,
        reboundAt: COOLED,
      });
      expect(rawRow("alice")).toMatchObject({ created_at: COOLED, released_at: null });
      expect(await getStoredNameState(d1, "alice", COOLED)).toEqual({ state: "taken" });
    });

    test("the cooldown runs from the erase, not from an older release", async () => {
      await registerHandle(d1, registration("alice"));
      await registerHandle(d1, registration("bravo"));
      // `alice` was released by the rename long before the account went away.
      const erasedAt = START_TIME + A_YEAR;
      await eraseHandlesForPubkey(d1, { pubkey: PUBKEY_A, nowSeconds: erasedAt });

      expect(
        await registerHandle(d1, registration("alice", { pubkey: PUBKEY_B, nowSeconds: erasedAt + 1 })),
      ).toEqual({ ok: false, error: "name_taken" });
      expect(
        await registerHandle(
          d1,
          registration("alice", { pubkey: PUBKEY_B, nowSeconds: erasedAt + ERASED_NAME_COOLDOWN_SECONDS }),
        ),
      ).toMatchObject({ ok: true, pubkey: PUBKEY_B });
    });

    test("a claimant who already holds a name renames under the usual window", async () => {
      await registerHandle(d1, registration("alice"));
      await registerHandle(d1, registration("delta", { pubkey: PUBKEY_C }));
      await eraseHandlesForPubkey(d1, { pubkey: PUBKEY_A, nowSeconds: ERASED_AT });
      await eraseHandlesForPubkey(d1, { pubkey: PUBKEY_C, nowSeconds: ERASED_AT });
      await registerHandle(d1, registration("carol", { pubkey: PUBKEY_B, nowSeconds: ERASED_AT + 1 }));

      expect(
        await registerHandle(d1, registration("alice", { pubkey: PUBKEY_B, nowSeconds: COOLED })),
      ).toEqual({ ok: true, name: "alice", pubkey: PUBKEY_B, previousName: "carol" });
      expect(await getHandleRebindInfo(d1, "carol", COOLED)).toMatchObject({
        status: "redirected",
        redirectTo: "alice",
      });
      expect(
        await registerHandle(d1, registration("delta", { pubkey: PUBKEY_B, nowSeconds: COOLED + 1 })),
      ).toMatchObject({ ok: false, error: "rename_too_soon" });
      expect(rawRow("delta")).toMatchObject({ pubkey: ERASED_PUBKEY });
    });

    test("once claimed, the name is the new holder's G3 tombstone", async () => {
      await registerHandle(d1, registration("alice"));
      await eraseHandlesForPubkey(d1, { pubkey: PUBKEY_A, nowSeconds: ERASED_AT });
      await registerHandle(d1, registration("alice", { pubkey: PUBKEY_B, nowSeconds: COOLED }));

      expect(
        await registerHandle(d1, registration("alice", { pubkey: PUBKEY_C, nowSeconds: COOLED + 1 })),
      ).toEqual({ ok: false, error: "name_taken" });

      await releaseHandle(d1, deletion({ pubkey: PUBKEY_B, nowSeconds: COOLED + 2 }));
      expect(
        await registerHandle(d1, registration("alice", { pubkey: PUBKEY_C, nowSeconds: COOLED + A_YEAR })),
      ).toEqual({ ok: false, error: "name_taken" });
      expect(await getStoredNameState(d1, "alice", COOLED + A_YEAR)).toEqual({ state: "tombstoned" });
    });
  });
});
