import { RESERVED_NAMES } from "@solidarity/shared/credsPath";

export const NIP05_DOMAIN = "creds.id";

/**
 * Name syntax (design §4 / G1). Two deliberate restrictions:
 *
 * - **No `.`** — `alice.dev` would be a valid name here AND a valid ATProto
 *   handle shape. The app/web `matchHandleResolver` registry is
 *   first-match-wins (ENS → ATProto → DNS), so `/@alice.dev` would be claimed
 *   by the ATProto resolver and resolve to the wrong person. Excluding `.`
 *   makes `matches` a pure syntactic partition: dotted → atproto/ens/dns,
 *   dotless → nip05. The two namespaces then cannot collide by construction.
 * - **No punctuation** — v1 issues only lowercase ASCII letters and digits.
 *   This avoids lookalike and routing edge cases as one entire class.
 * - **Minimum 3** — short names are part of the free identity surface; there
 *   is no paid short-name inventory.
 */
export const NIP05_NAME_MIN_LENGTH = 3;
export const NIP05_NAME_MAX_LENGTH = 30;

/**
 * Words never issued as names — the same table every creds.id URL reader uses
 * (`@solidarity/shared` handles/credsPath.ts, airmeishi docs/ref/15). Add a word
 * there, re-vendor shared, deploy this Worker, then ship the page.
 */
export const RESERVED_NIP05_NAMES: ReadonlySet<string> = RESERVED_NAMES;

export const AUDIT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const RENAME_WINDOW_SECONDS = 90 * 24 * 60 * 60;
export const MAX_RENAMES_PER_WINDOW = 1;

/**
 * G3a: an ERASED name (account deleted, or blocked by the operator) becomes
 * claimable by any key this long after the erase. Ordinary released names stay
 * tombstoned for everyone but their holder (G3) — only erased rows, whose
 * holder is gone, ever change hands, and they do so as a rebind on the same row
 * so G5 tells holders of an old link that the key behind the name changed.
 * Kidney 2026-11-11: short on purpose, so blocking squatters stays manageable.
 */
export const ERASED_NAME_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

/**
 * DoH endpoint for the recovery flow's `_did.<domain>` TXT lookup. Workers
 * cannot issue native DNS queries, so this is transport infrastructure, not a
 * trust root — the binding check itself still runs locally against the
 * supplied record (design §3.5 step 5).
 */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** Hard cap on a supplied old-record JWS, checked before any crypto work. */
export const MAX_OLD_RECORD_JWS_BYTES = 16_384;
