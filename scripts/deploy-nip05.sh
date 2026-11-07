#!/usr/bin/env bash
# Deploy the NIP-05 directory worker (`solidarity-id`) into the Cloudflare
# account that owns the creds.id zone. Idempotent:
#   1. find or create the D1 database `solidarity_id` in that account,
#   2. write its id into wrangler.nip05.jsonc (commit that afterwards),
#   3. apply the `drizzle/` migrations to it,
#   4. deploy the worker onto the creds.id routes (read from the config),
#   5. probe the three public endpoints.
# Needs a `wrangler login` session with access to that account.
#
# Every wrangler call carries `-c wrangler.nip05.jsonc`: wrangler takes the
# account from the config file it is given (CLOUDFLARE_ACCOUNT_ID alone does
# NOT redirect `d1` commands away from the default wrangler.jsonc), and the
# inbox / PassKit worker's config points at a different account.
set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG="wrangler.nip05.jsonc"
DB_NAME="solidarity_id"
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

w() {
  bun x wrangler "$@" -c "$CONFIG"
}

account="$(grep -oE '"account_id":[[:space:]]*"[0-9a-f]{32}"' "$CONFIG" | grep -oE '[0-9a-f]{32}')"
echo "▸ account ${account} (from ${CONFIG})"

# 1. D1 — reuse if it exists, otherwise create it. The list is fetched with
#    the nip05 config so it is THAT account's list.
# A failed list must stop the run: reading it as "no database" would try to create one.
if ! list_out="$(w d1 list --json 2>/dev/null)"; then
  echo "✘ wrangler d1 list failed; not creating a database. Re-run, or check 'wrangler whoami'." >&2
  exit 1
fi
if ! db_id="$(printf '%s' "$list_out" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const rows=JSON.parse(s);const hit=rows.find(r=>r.name===process.argv[1]);process.stdout.write(hit?hit.uuid:"")})' "$DB_NAME")"; then
  echo "✘ could not read the D1 list as JSON; not creating a database." >&2
  exit 1
fi
if [ -z "$db_id" ]; then
  echo "▸ creating D1 ${DB_NAME}"
  if ! out="$(w d1 create "$DB_NAME" 2>&1)"; then
    printf '%s\n' "$out" >&2
    echo "✘ wrangler d1 create failed (raw output above)" >&2
    exit 1
  fi
  printf '%s\n' "$out"
  db_id="$(printf '%s' "$out" | grep -oE "$UUID_RE" | head -1 || true)"
  if [ -z "$db_id" ]; then
    echo "✘ could not read the new database id from the output above" >&2
    exit 1
  fi
fi
echo "▸ D1 ${DB_NAME} = ${db_id}"

# 2. Pin the id in the config (the placeholder on first run, or a stale id).
sed -E -i '' "s/(\"database_id\": \")${UUID_RE}(\")/\1${db_id}\2/" "$CONFIG"
if ! grep -q "\"database_id\": \"${db_id}\"" "$CONFIG"; then
  echo "✘ failed to write database_id into ${CONFIG}" >&2
  exit 1
fi

# 3. Schema.
echo "▸ applying migrations"
w d1 migrations apply "$DB_NAME" --remote

# 4. Worker + routes.
echo "▸ deploying solidarity-id"
w deploy --minify

# 5. Smoke test — every answer must be JSON from the directory, never the
#    viewer's SPA HTML. The host is the first route's host in the config.
#    Routes propagate a few seconds after a deploy; an HTML answer right away
#    is lag, re-probe before reading it as a failure.
host="$(grep -oE '"pattern":[[:space:]]*"[^/"]+' "$CONFIG" | head -1 | grep -oE '[^"]+$')"
echo "▸ probing ${host}"
for ep in '/.well-known/nostr.json?name=_' '/id/availability?name=probe' '/id/history?name=probe'; do
  printf '  %-40s ' "$ep"
  curl -sS -m 20 -o /dev/null -w '%{http_code} %{content_type}\n' "https://${host}${ep}"
done
echo "▸ done — commit ${CONFIG} if the database id changed"
