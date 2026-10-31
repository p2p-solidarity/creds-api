import type { D1Database, D1Result } from "@cloudflare/workers-types";
import {
  AUDIT_RETENTION_SECONDS,
  RENAME_WINDOW_SECONDS,
} from "./constants";

type SqlValue = string | number | null;
type HandleStatus = "active" | "released" | "redirected";

interface HandleRow {
  name: string;
  pubkey: string;
  relays: string;
  status: HandleStatus;
  created_at: number;
  updated_at: number;
  released_at: number | null;
  redirect_to: string | null;
  redirect_until: number | null;
  rebind_generation: number;
  rebound_at: number | null;
}

interface SqlCondition {
  sql: string;
  bindings: SqlValue[];
}

interface PreviousRegistration {
  eventId: string;
  name: string;
}

export interface DirectoryEntry {
  name: string;
  pubkey: string;
  relays: string[];
}

export interface RegisterHandleInput {
  name: string;
  pubkey: string;
  relays: string[];
  eventId: string;
  authEvent: string;
  nowSeconds: number;
}

export type RegisterHandleResult =
  | {
      ok: true;
      name: string;
      pubkey: string;
      previousName: string | null;
    }
  | {
      ok: false;
      error: "replay" | "name_taken";
    }
  | {
      ok: false;
      error: "rename_too_soon";
      retryAt: number;
    };

export interface ReleaseHandleInput {
  pubkey: string;
  eventId: string;
  authEvent: string;
  nowSeconds: number;
}

export type ReleaseHandleResult =
  | { ok: true; released: string | null }
  | { ok: false; error: "replay" };

export type StoredNameState =
  | { state: "available" }
  | { state: "taken" }
  | { state: "tombstoned" };

export async function findActiveDirectoryEntry(
  db: D1Database,
  name: string,
): Promise<DirectoryEntry | null> {
  const row = await db
    .prepare(
      `SELECT name, pubkey, relays
       FROM nip05_handles
       WHERE name = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(name)
    .first<Pick<HandleRow, "name" | "pubkey" | "relays">>();

  if (row === null) {
    return null;
  }

  return {
    name: row.name,
    pubkey: row.pubkey,
    relays: parseStoredRelays(row.relays),
  };
}

/**
 * A released name NEVER returns to `available` (G3). The row is a permanent
 * tombstone: only its original holder can reclaim it, and to everyone else
 * the name is gone for good. That is what makes `/@name` safe to print.
 */
export async function getStoredNameState(
  db: D1Database,
  name: string,
): Promise<StoredNameState> {
  const row = await getHandleByName(db, name);
  if (row === null) {
    return { state: "available" };
  }
  return row.status === "active"
    ? { state: "taken" }
    : { state: "tombstoned" };
}

export interface HandleRebindInfo {
  name: string;
  status: "active" | "released" | "redirected";
  redirectTo: string | null;
  redirectUntil: number | null;
  rebindGeneration: number;
  reboundAt: number | null;
}

/**
 * The public read side of G5. Covers tombstoned rows too: a name that was
 * recovered and later released still carries the marker, and a viewer
 * rendering a cached/printed link deserves to see it.
 */
export async function getHandleRebindInfo(
  db: D1Database,
  name: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<HandleRebindInfo | null> {
  const row = await getHandleByName(db, name);
  const redirectIsLive =
    row?.status === "redirected" &&
    row.redirect_to !== null &&
    row.redirect_until !== null &&
    row.redirect_until > nowSeconds;
  return row === null
    ? null
    : {
        name: row.name,
        status: redirectIsLive
          ? "redirected"
          : row.status === "active"
            ? "active"
            : "released",
        redirectTo: redirectIsLive ? row.redirect_to : null,
        redirectUntil: redirectIsLive ? row.redirect_until : null,
        rebindGeneration: row.rebind_generation,
        reboundAt: row.rebound_at,
      };
}

export async function registerHandle(
  db: D1Database,
  input: RegisterHandleInput,
): Promise<RegisterHandleResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await hasAuditEvent(db, input.eventId)) {
      return { ok: false, error: "replay" };
    }

    const [target, active, previousRegistration, recentOtherHandle] = await Promise.all([
      getHandleByName(db, input.name),
      getActiveHandleByPubkey(db, input.pubkey),
      getPreviousRegistration(db, input.pubkey),
      getMostRecentOtherHandle(db, input.pubkey, input.name),
    ]);
    // G3: a name is unavailable to anyone but its original holder from the
    // moment it is first taken, forever — active or tombstoned alike.
    if (target !== null && target.pubkey !== input.pubkey) {
      return { ok: false, error: "name_taken" };
    }

    const isActiveRename = active !== null && active.name !== input.name;
    const countsAsRename =
      isActiveRename ||
      (previousRegistration !== null
        ? previousRegistration.name !== input.name
        : await hasOlderDifferentHandle(
            db,
            input.pubkey,
            input.name,
            input.nowSeconds,
          ));
    if (countsAsRename) {
      const retryAt = await getRenameRetryAt(db, input.pubkey);
      if (retryAt !== null && retryAt > input.nowSeconds) {
        return { ok: false, error: "rename_too_soon", retryAt };
      }
    }
    const renameSource = countsAsRename
      ? active !== null && active.name !== input.name
        ? active
        : recentOtherHandle
      : null;

    try {
      await executeRegisterBatch(db, input, {
        target,
        active,
        previousRegistration,
        countsAsRename,
        renameSource,
      });
      return {
        ok: true,
        name: input.name,
        pubkey: input.pubkey,
        previousName: renameSource?.name ?? (isActiveRename ? active.name : null),
      };
    } catch (error) {
      if (await hasAuditEvent(db, input.eventId)) {
        return { ok: false, error: "replay" };
      }
      if (attempt === 2) {
        throw error;
      }
    }
  }

  throw new Error("Unreachable register retry state");
}

export async function releaseHandle(
  db: D1Database,
  input: ReleaseHandleInput,
): Promise<ReleaseHandleResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await hasAuditEvent(db, input.eventId)) {
      return { ok: false, error: "replay" };
    }

    const active = await getActiveHandleByPubkey(db, input.pubkey);
    try {
      await executeReleaseBatch(db, input, active);
      return { ok: true, released: active?.name ?? null };
    } catch (error) {
      if (await hasAuditEvent(db, input.eventId)) {
        return { ok: false, error: "replay" };
      }
      if (attempt === 2) {
        throw error;
      }
    }
  }

  throw new Error("Unreachable release retry state");
}

export interface RecoverHandleInput {
  name: string;
  /** The pubkey the directory currently has bound to `name`. */
  expectedPubkey: string;
  /** The applicant's NEW pubkey — the NIP-98 signer. */
  pubkey: string;
  eventId: string;
  authEvent: string;
  nowSeconds: number;
}

export type RecoverHandleResult =
  | {
      ok: true;
      name: string;
      pubkey: string;
      rebindGeneration: number;
      releasedName: string | null;
    }
  | { ok: false; error: "replay" | "name_not_found" | "state_changed" };

/**
 * Repoint an ACTIVE name at a new pubkey after §3.5's evidence has already
 * been verified by the caller. This function performs NO judgement of its
 * own — it is the storage half only.
 *
 * Tombstoned names are deliberately NOT recoverable: their holder chose to
 * release them, and reviving one through recovery would let a name someone
 * intentionally gave up be taken back on the strength of an old record.
 *
 * If the applicant's new key already holds an active name (the common case —
 * they lost the seed, started over, and registered something new), that name
 * is released in the SAME batch before the recovered one is bound. Without
 * this the partial unique index on `(pubkey) WHERE status = 'active'` would
 * reject every realistic recovery.
 */
export async function recoverHandle(
  db: D1Database,
  input: RecoverHandleInput,
): Promise<RecoverHandleResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await hasAuditEvent(db, input.eventId)) {
      return { ok: false, error: "replay" };
    }

    const [target, active] = await Promise.all([
      getHandleByName(db, input.name),
      getActiveHandleByPubkey(db, input.pubkey),
    ]);

    if (target === null || target.status !== "active") {
      return { ok: false, error: "name_not_found" };
    }
    if (target.pubkey !== input.expectedPubkey) {
      return { ok: false, error: "state_changed" };
    }
    if (active !== null && active.name === input.name) {
      // The name is already theirs; nothing to recover.
      return { ok: false, error: "state_changed" };
    }

    try {
      await executeRecoverBatch(db, input, active);
      return {
        ok: true,
        name: input.name,
        pubkey: input.pubkey,
        rebindGeneration: target.rebind_generation + 1,
        releasedName: active?.name ?? null,
      };
    } catch (error) {
      if (await hasAuditEvent(db, input.eventId)) {
        return { ok: false, error: "replay" };
      }
      if (attempt === 2) {
        throw error;
      }
    }
  }

  throw new Error("Unreachable recover retry state");
}

async function executeRecoverBatch(
  db: D1Database,
  input: RecoverHandleInput,
  active: HandleRow | null,
): Promise<void> {
  // Same transactional-assertion trick the register path uses: the
  // CHECK-constrained `action` column turns a stale snapshot into the value
  // 'invalid', which aborts the entire D1 batch.
  const conditions: SqlCondition[] = [
    {
      sql: `EXISTS (
        SELECT 1 FROM nip05_handles
        WHERE name = ? AND pubkey = ? AND status = 'active'
      )`,
      bindings: [input.name, input.expectedPubkey],
    },
    active === null
      ? {
          sql: `NOT EXISTS (
            SELECT 1 FROM nip05_handles WHERE pubkey = ? AND status = 'active'
          )`,
          bindings: [input.pubkey],
        }
      : {
          sql: `EXISTS (
            SELECT 1 FROM nip05_handles
            WHERE name = ? AND pubkey = ? AND status = 'active'
          )`,
          bindings: [active.name, input.pubkey],
        },
  ];
  const conditionSql = conditions.map((condition) => `(${condition.sql})`).join(" AND ");
  const conditionBindings = conditions.flatMap((condition) => condition.bindings);

  const statements = [
    db
      .prepare(
        `INSERT INTO nip05_audit
          (event_id, action, name, pubkey, auth_event, created_at)
         SELECT
          ?,
          CASE WHEN ${conditionSql} THEN 'recovery_rebind' ELSE 'invalid' END,
          ?, ?, ?, ?`,
      )
      .bind(
        input.eventId,
        ...conditionBindings,
        input.name,
        input.pubkey,
        input.authEvent,
        input.nowSeconds,
      ),
  ];

  // Must precede the rebind: the partial unique index allows only one active
  // name per pubkey, and D1 runs batch statements in order.
  if (active !== null) {
    statements.push(
      db
        .prepare(
          `UPDATE nip05_handles
           SET status = 'released',
               relays = '[]',
               updated_at = ?,
               released_at = ?,
               redirect_to = NULL,
               redirect_until = NULL
           WHERE name = ?
             AND pubkey = ?
             AND status = 'active'
             AND EXISTS (SELECT 1 FROM nip05_audit WHERE event_id = ?)`,
        )
        .bind(
          input.nowSeconds,
          input.nowSeconds,
          active.name,
          input.pubkey,
          input.eventId,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `UPDATE nip05_handles
         SET pubkey = ?,
             updated_at = ?,
             rebind_generation = rebind_generation + 1,
             rebound_at = ?
         WHERE name = ?
           AND pubkey = ?
           AND status = 'active'
           AND EXISTS (SELECT 1 FROM nip05_audit WHERE event_id = ?)`,
      )
      .bind(
        input.pubkey,
        input.nowSeconds,
        input.nowSeconds,
        input.name,
        input.expectedPubkey,
        input.eventId,
      ),
  );

  // Final assertion — if the intended post-state was not reached, flip the
  // audit action to 'invalid' so the CHECK constraint aborts everything.
  statements.push(
    db
      .prepare(
        `UPDATE nip05_audit
         SET action = CASE
           WHEN EXISTS (
             SELECT 1 FROM nip05_handles
             WHERE name = ?
               AND pubkey = ?
               AND status = 'active'
               AND rebound_at = ?
           )
           THEN 'recovery_rebind'
           ELSE 'invalid'
         END
         WHERE event_id = ?`,
      )
      .bind(input.name, input.pubkey, input.nowSeconds, input.eventId),
  );

  await db.batch(statements);
}

/**
 * Only audit rows are ever purged. `nip05_handles` rows are permanent (G3) —
 * deleting a tombstone would silently make the name registrable again by a
 * stranger, which is precisely the outcome the tombstone exists to prevent.
 */
export async function purgeExpiredNip05Data(
  db: D1Database,
  nowSeconds: number,
): Promise<{ audits: number }> {
  const result = await db
    .prepare("DELETE FROM nip05_audit WHERE created_at <= ?")
    .bind(nowSeconds - AUDIT_RETENTION_SECONDS)
    .run();

  return { audits: getChangeCount(result) };
}

/**
 * Stand-in pubkey for an erased holder. Not 64 hex chars, so no NIP-98
 * signer can ever match it: the names stay tombstoned (G3) for everyone,
 * the original holder included.
 */
export const ERASED_PUBKEY = "erased";

/**
 * Account deletion. Every row this pubkey ever held — active, redirected or
 * released — becomes a released tombstone whose pubkey is `ERASED_PUBKEY`,
 * and the signed audit trail for the pubkey is dropped.
 *
 * The rows themselves are kept on purpose: deleting one would free the name
 * for a stranger to print as `name@creds.id` (the impersonation G3 exists to
 * prevent). Dropping the pubkey is what removes the name↔key link; the cost
 * is that the name can never be reclaimed, even with the old key. A replay of
 * the same NIP-98 event inside its 60 s window finds nothing left to change.
 */
export async function eraseHandlesForPubkey(
  db: D1Database,
  input: { pubkey: string; nowSeconds: number },
): Promise<{ erased: string[] }> {
  const rows = await db
    .prepare("SELECT name FROM nip05_handles WHERE pubkey = ?")
    .bind(input.pubkey)
    .all<{ name: string }>();
  await db.batch([
    db
      .prepare(
        `UPDATE nip05_handles
         SET pubkey = ?,
             status = 'released',
             relays = '[]',
             updated_at = ?,
             released_at = COALESCE(released_at, ?),
             redirect_to = NULL,
             redirect_until = NULL
         WHERE pubkey = ?`,
      )
      .bind(ERASED_PUBKEY, input.nowSeconds, input.nowSeconds, input.pubkey),
    db.prepare("DELETE FROM nip05_audit WHERE pubkey = ?").bind(input.pubkey),
  ]);
  return { erased: (rows.results ?? []).map((row) => row.name) };
}

async function executeRegisterBatch(
  db: D1Database,
  input: RegisterHandleInput,
  snapshot: {
    target: HandleRow | null;
    active: HandleRow | null;
    previousRegistration: PreviousRegistration | null;
    countsAsRename: boolean;
    renameSource: HandleRow | null;
  },
): Promise<void> {
  const relays = JSON.stringify(input.relays);
  const expectedActive = buildExpectedActiveCondition(
    snapshot.active,
    input.pubkey,
  );
  const expectedTarget = buildExpectedTargetCondition(
    snapshot.target,
    input.name,
    input.pubkey,
  );
  const expectedHistory = buildExpectedHistoryCondition(
    snapshot.previousRegistration,
    input.pubkey,
  );
  const conditions = [expectedActive, expectedTarget, expectedHistory];

  if (snapshot.countsAsRename) {
    conditions.push({
      sql: `NOT EXISTS (
        SELECT 1
        FROM nip05_handles
        WHERE pubkey = ?
          AND status = 'redirected'
          AND redirect_until > ?
      )`,
      bindings: [input.pubkey, input.nowSeconds],
    });
  }

  const conditionSql = conditions.map((condition) => `(${condition.sql})`).join(" AND ");
  const conditionBindings = conditions.flatMap((condition) => condition.bindings);

  // The CHECK-constrained action is a transactional assertion: stale state
  // becomes "invalid", which aborts the whole D1 batch. The final assertion
  // does the same if the intended post-state was not reached.
  const statements = [
    db
      .prepare(
        `INSERT INTO nip05_audit
          (event_id, action, name, pubkey, auth_event, created_at)
         SELECT
          ?,
          CASE WHEN ${conditionSql} THEN 'register' ELSE 'invalid' END,
          ?, ?, ?, ?`,
      )
      .bind(
        input.eventId,
        ...conditionBindings,
        input.name,
        input.pubkey,
        input.authEvent,
        input.nowSeconds,
      ),
  ];

  if (snapshot.renameSource !== null) {
    const redirectUntil = input.nowSeconds + RENAME_WINDOW_SECONDS;
    statements.push(
      db
        .prepare(
          `UPDATE nip05_handles
           SET status = 'redirected',
               relays = '[]',
               updated_at = ?,
               released_at = ?,
               redirect_to = ?,
               redirect_until = ?
           WHERE name = ?
             AND pubkey = ?
             AND status = ?
             AND EXISTS (
               SELECT 1 FROM nip05_audit WHERE event_id = ?
             )`,
        )
        .bind(
          input.nowSeconds,
          input.nowSeconds,
          input.name,
          redirectUntil,
          snapshot.renameSource.name,
          input.pubkey,
          snapshot.renameSource.status,
          input.eventId,
        ),
    );
  }

  if (snapshot.target === null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO nip05_handles
            (name, pubkey, relays, status, created_at, updated_at, released_at)
           SELECT ?, ?, ?, 'active', ?, ?, NULL
           WHERE EXISTS (
             SELECT 1 FROM nip05_audit WHERE event_id = ?
           )`,
        )
        .bind(
          input.name,
          input.pubkey,
          relays,
          input.nowSeconds,
          input.nowSeconds,
          input.eventId,
        ),
    );
  } else if (snapshot.target.status === "active") {
    statements.push(
      db
        .prepare(
          `UPDATE nip05_handles
           SET relays = ?, updated_at = ?
           WHERE name = ?
             AND pubkey = ?
             AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM nip05_audit WHERE event_id = ?
             )`,
        )
        .bind(
          relays,
          input.nowSeconds,
          input.name,
          input.pubkey,
          input.eventId,
        ),
    );
  } else {
    // Reclaim of the caller's OWN tombstone (G3 — the only way a released row
    // ever goes active again). `created_at` is preserved because this is the
    // same holder resuming the same name, and `pubkey = ?` in the WHERE makes
    // reassigning someone else's tombstone impossible even if the pre-flight
    // check were somehow bypassed.
    statements.push(
      db
        .prepare(
          `UPDATE nip05_handles
           SET relays = ?,
               status = 'active',
               updated_at = ?,
               released_at = NULL,
               redirect_to = NULL,
               redirect_until = NULL
           WHERE name = ?
             AND pubkey = ?
             AND status IN ('released', 'redirected')
             AND EXISTS (
               SELECT 1 FROM nip05_audit WHERE event_id = ?
             )`,
        )
        .bind(
          relays,
          input.nowSeconds,
          input.name,
          input.pubkey,
          input.eventId,
        ),
    );
  }

  const oldNameAssertion =
    snapshot.renameSource !== null
      ? `AND EXISTS (
           SELECT 1
           FROM nip05_handles
           WHERE name = ?
             AND pubkey = ?
             AND status = 'redirected'
             AND released_at = ?
             AND redirect_to = ?
             AND redirect_until = ?
         )`
      : "";
  const oldNameBindings =
    snapshot.renameSource !== null
      ? [
          snapshot.renameSource.name,
          input.pubkey,
          input.nowSeconds,
          input.name,
          input.nowSeconds + RENAME_WINDOW_SECONDS,
        ]
      : [];

  statements.push(
    db
      .prepare(
        `UPDATE nip05_audit
         SET action = CASE
           WHEN EXISTS (
             SELECT 1
             FROM nip05_handles
             WHERE name = ?
               AND pubkey = ?
               AND relays = ?
               AND status = 'active'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM nip05_handles
             WHERE pubkey = ?
               AND status = 'active'
               AND name <> ?
           )
           ${oldNameAssertion}
           THEN action
           ELSE 'invalid'
         END
         WHERE event_id = ?`,
      )
      .bind(
        input.name,
        input.pubkey,
        relays,
        input.pubkey,
        input.name,
        ...oldNameBindings,
        input.eventId,
      ),
  );

  await db.batch(statements);
}

async function executeReleaseBatch(
  db: D1Database,
  input: ReleaseHandleInput,
  active: HandleRow | null,
): Promise<void> {
  const expectedActive = buildExpectedActiveCondition(active, input.pubkey);
  // An idempotent no-op is still a successful signed mutation and must consume
  // its event ID; the non-null audit name is empty because no handle was released.
  const auditName = active?.name ?? "";
  const statements = [
    db
      .prepare(
        `INSERT INTO nip05_audit
          (event_id, action, name, pubkey, auth_event, created_at)
         SELECT
          ?,
          CASE WHEN ${expectedActive.sql} THEN 'release' ELSE 'invalid' END,
          ?, ?, ?, ?`,
      )
      .bind(
        input.eventId,
        ...expectedActive.bindings,
        auditName,
        input.pubkey,
        input.authEvent,
        input.nowSeconds,
      ),
  ];

  if (active !== null) {
    statements.push(
      db
        .prepare(
          `UPDATE nip05_handles
           SET status = 'released',
               relays = '[]',
               updated_at = ?,
               released_at = ?,
               redirect_to = NULL,
               redirect_until = NULL
           WHERE name = ?
             AND pubkey = ?
             AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM nip05_audit WHERE event_id = ?
             )`,
        )
        .bind(
          input.nowSeconds,
          input.nowSeconds,
          active.name,
          input.pubkey,
          input.eventId,
        ),
    );
  }

  const releasedAssertion =
    active === null
      ? ""
      : `AND EXISTS (
           SELECT 1
           FROM nip05_handles
           WHERE name = ?
             AND pubkey = ?
             AND status = 'released'
             AND relays = '[]'
             AND released_at = ?
         )`;
  const releasedBindings =
    active === null
      ? []
      : [active.name, input.pubkey, input.nowSeconds];

  statements.push(
    db
      .prepare(
        `UPDATE nip05_audit
         SET action = CASE
           WHEN NOT EXISTS (
             SELECT 1
             FROM nip05_handles
             WHERE pubkey = ? AND status = 'active'
           )
           ${releasedAssertion}
           THEN action
           ELSE 'invalid'
         END
         WHERE event_id = ?`,
      )
      .bind(input.pubkey, ...releasedBindings, input.eventId),
  );

  await db.batch(statements);
}

function buildExpectedActiveCondition(
  active: HandleRow | null,
  pubkey: string,
): SqlCondition {
  if (active === null) {
    return {
      sql: `NOT EXISTS (
        SELECT 1
        FROM nip05_handles
        WHERE pubkey = ? AND status = 'active'
      )`,
      bindings: [pubkey],
    };
  }

  return {
    sql: `EXISTS (
      SELECT 1
      FROM nip05_handles
      WHERE name = ? AND pubkey = ? AND status = 'active'
    )`,
    bindings: [active.name, pubkey],
  };
}

function buildExpectedTargetCondition(
  target: HandleRow | null,
  name: string,
  pubkey: string,
): SqlCondition {
  if (target === null) {
    return {
      sql: "NOT EXISTS (SELECT 1 FROM nip05_handles WHERE name = ?)",
      bindings: [name],
    };
  }

  if (target.status === "active") {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM nip05_handles
        WHERE name = ? AND pubkey = ? AND status = 'active'
      )`,
      bindings: [name, pubkey],
    };
  }

  // Only the original holder can ever reclaim a tombstoned name (G3). The
  // caller already refuses a foreign pubkey, so this assertion re-states that
  // invariant inside the transaction: if the row somehow belongs to someone
  // else by the time the batch runs, the condition is false and the whole
  // batch aborts rather than reassigning a tombstone.
  return {
    sql: `EXISTS (
      SELECT 1
      FROM nip05_handles
      WHERE name = ? AND pubkey = ? AND status IN ('released', 'redirected')
    )`,
    bindings: [name, pubkey],
  };
}

function buildExpectedHistoryCondition(
  previousRegistration: PreviousRegistration | null,
  pubkey: string,
): SqlCondition {
  if (previousRegistration === null) {
    return {
      sql: `NOT EXISTS (
        SELECT 1
        FROM nip05_audit
        WHERE pubkey = ? AND action = 'register'
      )`,
      bindings: [pubkey],
    };
  }

  return {
    sql: `(
      SELECT event_id
      FROM nip05_audit
      WHERE pubkey = ? AND action = 'register'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    ) = ?`,
    bindings: [pubkey, previousRegistration.eventId],
  };
}

async function getHandleByName(
  db: D1Database,
  name: string,
): Promise<HandleRow | null> {
  return db
    .prepare(
      `SELECT
         name,
         pubkey,
         relays,
         status,
         created_at,
         updated_at,
         released_at,
         redirect_to,
         redirect_until,
         rebind_generation,
         rebound_at
       FROM nip05_handles
       WHERE name = ?
       LIMIT 1`,
    )
    .bind(name)
    .first<HandleRow>();
}

async function getPreviousRegistration(
  db: D1Database,
  pubkey: string,
): Promise<PreviousRegistration | null> {
  const row = await db
    .prepare(
      `SELECT event_id, name
       FROM nip05_audit
       WHERE pubkey = ? AND action = 'register'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .bind(pubkey)
    .first<{ event_id: string; name: string }>();

  return row === null ? null : { eventId: row.event_id, name: row.name };
}

async function hasOlderDifferentHandle(
  db: D1Database,
  pubkey: string,
  name: string,
  nowSeconds: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found
       FROM nip05_handles
       WHERE pubkey = ? AND name <> ? AND created_at < ?
       LIMIT 1`,
    )
    .bind(pubkey, name, nowSeconds)
    .first<{ found: number }>();
  return row !== null;
}

async function getActiveHandleByPubkey(
  db: D1Database,
  pubkey: string,
): Promise<HandleRow | null> {
  return db
    .prepare(
      `SELECT
         name,
         pubkey,
         relays,
         status,
         created_at,
         updated_at,
         released_at,
         redirect_to,
         redirect_until,
         rebind_generation,
         rebound_at
       FROM nip05_handles
       WHERE pubkey = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(pubkey)
    .first<HandleRow>();
}

async function getMostRecentOtherHandle(
  db: D1Database,
  pubkey: string,
  name: string,
): Promise<HandleRow | null> {
  return db
    .prepare(
      `SELECT
         name,
         pubkey,
         relays,
         status,
         created_at,
         updated_at,
         released_at,
         redirect_to,
         redirect_until,
         rebind_generation,
         rebound_at
       FROM nip05_handles
       WHERE pubkey = ? AND name <> ?
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
    )
    .bind(pubkey, name)
    .first<HandleRow>();
}

async function getRenameRetryAt(
  db: D1Database,
  pubkey: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MAX(redirect_until) AS retry_at
       FROM nip05_handles
       WHERE pubkey = ? AND status = 'redirected'`,
    )
    .bind(pubkey)
    .first<{ retry_at: number | null }>();
  return row?.retry_at ?? null;
}

async function hasAuditEvent(
  db: D1Database,
  eventId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM nip05_audit WHERE event_id = ? LIMIT 1")
    .bind(eventId)
    .first<{ found: number }>();
  return row !== null;
}

function parseStoredRelays(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((relay) => typeof relay === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function getChangeCount(result: D1Result | undefined): number {
  return result?.meta?.changes ?? 0;
}
