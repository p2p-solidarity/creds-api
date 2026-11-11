-- Lookups by pubkey that do not say `status = 'active'` (register's rename /
-- history checks, account deletion) cannot use the partial unique index, so
-- without this they scan the whole table. Rows are never deleted (G3/G3a
-- tombstones), so that scan only grows. `updated_at` serves the
-- most-recent-other-handle ORDER BY.
CREATE INDEX IF NOT EXISTS nip05_handles_pubkey_idx ON nip05_handles (pubkey, updated_at);
