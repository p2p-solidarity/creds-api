-- creds Pro license bridge (airmeishi docs/ref/09): one store purchase ↔ one did.
-- `purchase_key` is stable across renewals (ios:<originalTransactionId> /
-- android:<first purchase token>). Rebinding to another did is allowed once
-- per 30 days; the old did's license simply stops renewing.
CREATE TABLE IF NOT EXISTS pro_bindings (
  purchase_key TEXT PRIMARY KEY NOT NULL,
  did TEXT NOT NULL,
  product TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  bound_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pro_bindings_did_idx ON pro_bindings (did);
