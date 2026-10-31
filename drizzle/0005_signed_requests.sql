-- Signed requests (2026-10-31, account deletion). Every delete — and every write
-- that decides who may delete later — carries a JWS by the account's own key
-- (`src/lib/signedRequest.ts`). `jti` makes each one single-use.
-- `owner_did` binds an owner-index row to the root did:key that may delete it;
-- NULL only on rows written before this migration.
ALTER TABLE root_vaults ADD COLUMN owner_did TEXT;
CREATE TABLE IF NOT EXISTS signed_request_nonces (
  jti TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS signed_request_nonces_expiry_idx ON signed_request_nonces (expires_at);
