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

The Shoutouts inbox and PassKit signing (`airmeishi-backend`) were shut down on 2026-11-04; their D1 is deleted. Only a stub remains, see below.

### Account deletion

Every delete must be signed by the account's own key — never a bearer secret or an email alone. Requests signed by the root did:key carry `X-Creds-Signature`: a compact ES256 JWS (`kid = <did>#0`) over `{aud: "creds.id", m: <method>, p: <path>, iat, jti}`, valid ±5 minutes and once (`jti` is stored in `signed_request_nonces`) — `src/lib/signedRequest.ts`.

- `PUT /vault/root/:locator` (owned) and `PUT …/owner` need the owner secret **and** a signed request; the row records the signer as `owner_did`. `DELETE /vault/root/:locator` needs both too, from that same did (rows written before 2026-10-31 have no `owner_did` and fall back to the owner secret plus any valid signature).
- `DELETE /id/account` (NIP-98 by the Nostr key, event id single-use): every name the pubkey ever held becomes a released tombstone with pubkey `erased`, and its audit rows are dropped. The rows stay so nobody else can ever register the name and impersonate the old page (G3); with the pubkey gone, the name is no longer linked to the person and can't be reclaimed, not even with the old key.
- `DELETE /pro/binding` (signed by the did): the purchase ↔ did rows are deleted outright. The store subscription itself is cancelled in the App Store / Play, not here.
- `POST /inbox/delete` on `airmeishi-backend.kidneyweakx.workers.dev`: app 2.0.0 still calls it, so the retired worker answers `{deleted: 0}` (nothing is held any more) and 410 to everything else. Delete the Worker once 2.0.0 is out of use.

The zkTLS notary for social-account verification lives in the app monorepo (`apps/notary`), not here.

## Layout

Two Workers, one codebase, in different Cloudflare accounts (a Worker route can only be attached from the zone's own account).

| Worker | Entry | Config | D1 | Mounts |
| --- | --- | --- | --- | --- |
| `solidarity-id` | `src/nip05-worker.ts` | `wrangler.nip05.jsonc` | `solidarity_id` | root vault + Pro + NIP-05, routed on `creds.id` in front of the Pages site |
| `airmeishi-backend` | `src/index.ts` | `wrangler.jsonc` | — | retired: the 2.0.0 `/inbox/delete` stub only |

```
src/
  routes/     rootVault · nip05 · pro   (Hono routers, Zod schemas)
  lib/        nip05 (NIP-98 auth, JWS, did:key, recovery, name rules) · pro · signed requests
  db/         Drizzle schema  →  drizzle/ SQL migrations
  schedules/  cron cleanup (NIP-05 audit)
```

## Develop

Requires [bun](https://bun.sh).

```bash
bun install
bunx wrangler dev -c wrangler.nip05.jsonc    # id + vault worker; creds-web's dev proxy expects port 8787
bun run typecheck && bun test
```

## Deploy

```bash
bun run deploy:nip05    # solidarity-id: finds/creates D1, applies drizzle/, deploys, probes the public endpoints
bun run deploy          # airmeishi-backend: the retired /inbox/delete stub
```

`deploy:nip05` needs a `wrangler login` with access to the account that owns the creds.id zone; commit `wrangler.nip05.jsonc` if it writes a new database id.

NIP-05 design: [docs/design-nip05.md](docs/design-nip05.md) (written when the domain was solidarity.gg — read it as creds.id).

## Consumers

- **creds app** — root-vault sync and passkey index, `name@creds.id` registration.
- **[creds.id](https://github.com/p2p-solidarity/creds-web)** — passkey sign-up and vault sync, `creds.id/@name` resolution through `@solidarity/shared`'s `Nip05HandleResolver`.

---

Formerly `creds-signserver` — it began as an Apple Wallet signing service and outgrew the name. Part of [Solid(ar)ity](https://github.com/p2p-solidarity).
