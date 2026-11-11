import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const inbox = sqliteTable("inbox", {
  id: text("id").primaryKey(),
  ownerPubkey: text("owner_pubkey").notNull(),
  blob: text("blob").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const rootVaults = sqliteTable(
  "root_vaults",
  {
    locator: text("locator").primaryKey(),
    version: integer("version", { mode: "number" }).notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    owner: text("owner"),
    meta: text("meta"),
  },
  (table) => [
    check("root_vaults_version_check", sql`${table.version} = 1`),
    index("root_vaults_owner_idx").on(table.owner),
  ],
);

export const nip05Handles = sqliteTable(
  "nip05_handles",
  {
    name: text("name").primaryKey(),
    pubkey: text("pubkey").notNull(),
    relays: text("relays").notNull().default("[]"),
    status: text("status", {
      enum: ["active", "released", "redirected"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    releasedAt: integer("released_at", { mode: "number" }),
    redirectTo: text("redirect_to"),
    redirectUntil: integer("redirect_until", { mode: "number" }),
    /**
     * G5 — how many times this name has been recovered (§3.5). Monotonic and
     * never reset: the viewer renders `>= 1` as a permanent "was rebound"
     * marker so holders of an older printed card can notice the identity
     * behind the name changed. The bidirectional badge check cannot warn
     * them, because after a rebind both directions genuinely agree.
     */
    rebindGeneration: integer("rebind_generation", { mode: "number" })
      .notNull()
      .default(0),
    reboundAt: integer("rebound_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("nip05_handles_active_pubkey_unique")
      .on(table.pubkey)
      .where(sql`${table.status} = 'active'`),
    // Pubkey lookups that don't filter on status = 'active' can't use the
    // partial index above; without this they scan every row.
    index("nip05_handles_pubkey_idx").on(table.pubkey, table.updatedAt),
    // Released rows are permanent tombstones (G3), never purged — this index
    // serves reclaim lookups by the original holder, not cleanup.
    index("nip05_handles_status_idx").on(table.status, table.releasedAt),
    check(
      "nip05_handles_status_check",
      sql`${table.status} IN ('active', 'released', 'redirected')`,
    ),
    check(
      "nip05_handles_release_time_check",
      sql`(${table.status} = 'active' AND ${table.releasedAt} IS NULL)
        OR (${table.status} IN ('released', 'redirected') AND ${table.releasedAt} IS NOT NULL)`,
    ),
    check(
      "nip05_handles_redirect_check",
      sql`(${table.status} IN ('active', 'released') AND ${table.redirectTo} IS NULL AND ${table.redirectUntil} IS NULL)
        OR (${table.status} = 'redirected' AND ${table.redirectTo} IS NOT NULL AND ${table.redirectUntil} IS NOT NULL)`,
    ),
    check(
      "nip05_handles_rebind_time_check",
      sql`(${table.rebindGeneration} = 0 AND ${table.reboundAt} IS NULL)
        OR (${table.rebindGeneration} > 0 AND ${table.reboundAt} IS NOT NULL)`,
    ),
  ],
);

export const nip05Audit = sqliteTable(
  "nip05_audit",
  {
    eventId: text("event_id").primaryKey(),
    /**
     * `recovery_rebind` is still NIP-98 signed (by the applicant's NEW key),
     * so `authEvent` stays NOT NULL. There is deliberately no `admin_*`
     * action: this service has no human approval path (G4).
     */
    action: text("action", {
      enum: ["register", "release", "recovery_rebind"],
    }).notNull(),
    name: text("name").notNull(),
    pubkey: text("pubkey").notNull(),
    authEvent: text("auth_event").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("nip05_audit_pubkey_register_idx").on(
      table.pubkey,
      table.action,
      table.createdAt,
    ),
    index("nip05_audit_cleanup_idx").on(table.createdAt),
    check(
      "nip05_audit_action_check",
      sql`${table.action} IN ('register', 'release', 'recovery_rebind')`,
    ),
  ],
);

export const schema = {
  inbox,
  rootVaults,
  nip05Handles,
  nip05Audit,
};

export type InboxRecord = typeof inbox.$inferSelect;
export type NewInboxRecord = typeof inbox.$inferInsert;
export type RootVaultRecord = typeof rootVaults.$inferSelect;
export type NewRootVaultRecord = typeof rootVaults.$inferInsert;
export type Nip05HandleRecord = typeof nip05Handles.$inferSelect;
export type NewNip05HandleRecord = typeof nip05Handles.$inferInsert;
export type Nip05AuditRecord = typeof nip05Audit.$inferSelect;
export type NewNip05AuditRecord = typeof nip05Audit.$inferInsert;
