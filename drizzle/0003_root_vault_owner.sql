-- Owner index for root vaults (airmeishi docs/ref/08 §1 revision 2026-10-20).
-- `owner` = base64url(sha256(owner secret)); `meta` = AES-GCM sealed row metadata
-- the service cannot read. Ciphertext stays create-once.
ALTER TABLE root_vaults ADD COLUMN owner TEXT;
ALTER TABLE root_vaults ADD COLUMN meta TEXT;
CREATE INDEX IF NOT EXISTS root_vaults_owner_idx ON root_vaults (owner);
