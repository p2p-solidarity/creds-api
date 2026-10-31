<div align="center">

# creds-api

**The small, mostly-blind backend behind [creds.id](https://creds.id) and the [creds app](https://github.com/p2p-solidarity/creds-app).**

Cloudflare Workers · Hono + Zod OpenAPI · Drizzle ORM on D1

</div>

creds is built to keep working if this server disappears: identities are keys on your device, and pages are signed by you and checked in the visitor's browser. This repo is what's left over — the few things a phone or a browser can't do alone — and each piece is designed to hold as little as possible:

| Service | What it does | What the server can see |
| --- | --- | --- |
| **Root vault** `creds.id/vault/root` | Syncs your root identity between the app and the web. The key is wrapped on-device with a passkey (WebAuthn PRF) before upload. | Opaque ciphertext under a random locator, plus an optional owner index behind a hashed secret. Never a key, never a passkey. |
| **NIP-05 directory** `name@creds.id` | Nostr identifiers for creds pages: `/.well-known/nostr.json`, plus register, availability, recover, release and history under `/id`. Writes are NIP-98-signed by the holder's key. | The public name → npub mapping (public by design) and an audit trail. |
| **Encrypted inbox** `/seal` `/send` `/sync` `/ack` | Store-and-forward relay with APNs wake-ups. | Sealed device tokens and end-to-end encrypted payloads; rows expire after 24h. |
| **PassKit signing** | Signs Apple Wallet passes (Apple requires a server-held certificate). | The pass contents you ask it to sign. |

### Account deletion

Every delete must be signed by the account's own key — never a bearer secret or an email alone. Requests signed by the root did:key carry `X-Creds-Signature`: a compact ES256 JWS (`kid = <did>#0`) over `{aud: "creds.id", m: <method>, p: <path>, iat, jti}`, valid ±5 minutes and once (`jti` is stored in `signed_request_nonces`) — `src/lib/signedRequest.ts`.

- `PUT /vault/root/:locator` (owned) and `PUT …/owner` need the owner secret **and** a signed request; the row records the signer as `owner_did`. `DELETE /vault/root/:locator` needs both too, from that same did (rows written before 2026-10-31 have no `owner_did` and fall back to the owner secret plus any valid signature).
- `DELETE /id/account` (NIP-98 by the Nostr key, event id single-use): every name the pubkey ever held becomes a released tombstone with pubkey `erased`, and its audit rows are dropped. The rows stay so nobody else can ever register the name and impersonate the old page (G3); with the pubkey gone, the name is no longer linked to the person and can't be reclaimed, not even with the old key.
- `DELETE /pro/binding` (signed by the did): the purchase ↔ did rows are deleted outright. The store subscription itself is cancelled in the App Store / Play, not here.
- `POST /inbox/delete` (Ed25519 over `creds-inbox-delete:<pubkey>:<ts>:<nonce>`, 5 minutes, single-use nonce): only devices that still hold the retired Shoutouts key have anything here, and rows expire after 24h anyway.

The zkTLS notary for social-account verification lives in the app monorepo (`apps/notary`), not here.

## Layout

Two Workers, one codebase — the creds.id zone and the inbox/PassKit worker sit in different Cloudflare accounts, and a Worker route can only be attached from the zone's own account.

| Worker | Entry | Config | D1 | Mounts |
| --- | --- | --- | --- | --- |
| `solidarity-id` | `src/nip05-worker.ts` | `wrangler.nip05.jsonc` | `solidarity_id` | root vault + NIP-05, routed on `creds.id` in front of the Pages site |
| `airmeishi-backend` | `src/index.ts` | `wrangler.jsonc` | `airmeishi_inbox` | inbox, PassKit, NIP-05 |

```
src/
  routes/     rootVault · nip05 · inbox · passkit   (Hono routers, Zod schemas)
  lib/        nip05 (NIP-98 auth, JWS, did:key, recovery, name rules) · inbox (APNs, sealing)
  db/         Drizzle schema  →  drizzle/ SQL migrations
  schedules/  cron cleanup (inbox TTL, NIP-05 audit)
```

The inbox worker serves its OpenAPI document at `/openapi.json`.

## Develop

Requires [bun](https://bun.sh).

```bash
bun install
bun run dev                                  # inbox / PassKit worker
bunx wrangler dev -c wrangler.nip05.jsonc    # id + vault worker; creds-web's dev proxy expects port 8787
bun run typecheck && bun test
```

## Deploy

```bash
bun run deploy          # airmeishi-backend (inbox / PassKit)
bun run deploy:nip05    # solidarity-id: finds/creates D1, applies drizzle/, deploys, probes the public endpoints
```

`deploy:nip05` needs a `wrangler login` with access to the account that owns the creds.id zone; commit `wrangler.nip05.jsonc` if it writes a new database id.

Inbox worker secrets:

- `PUSH_SECRET` — AES-256 key that seals device tokens (base64, hex or raw).
- `APPLE_P8_KEY` — PKCS#8 `.p8` contents (base64 or plain), with `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APNS_TOPIC`, optional `APNS_HOST`.

PassKit certificate setup: [DEPLOYMENT.md](DEPLOYMENT.md). NIP-05 design: [docs/design-nip05.md](docs/design-nip05.md) (written when the domain was solidarity.gg — read it as creds.id).

## Consumers

- **creds app** — root-vault sync and passkey index, `name@creds.id` registration.
- **[creds.id](https://github.com/p2p-solidarity/creds-web)** — passkey sign-up and vault sync, `creds.id/@name` resolution through `@solidarity/shared`'s `Nip05HandleResolver`.

---

Formerly `creds-signserver` — it began as an Apple Wallet signing service and outgrew the name. Part of [Solid(ar)ity](https://github.com/p2p-solidarity).
