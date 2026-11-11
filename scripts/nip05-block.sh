#!/usr/bin/env bash
# Block a squatted creds.id name: unlink it from its key the way account
# deletion does (pubkey='erased'). That restarts the 7-day cooldown, after
# which anyone may claim it as a rebind (docs/design-nip05.md G3a). To keep a
# word out of circulation for good, add it to RESERVED_NAMES in shared instead.
#
#   bun run block:nip05 <name>            # production D1 (creds.id account login)
#   bun run block:nip05 <name> --local    # the `wrangler dev` D1, for testing
#
# The holder's audit rows are kept (signed evidence; they age out in 90 days).
# The worker's directory cache can serve the old binding for up to 5 minutes.
set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG="wrangler.nip05.jsonc"
DB_NAME="solidarity_id"

name="${1:-}"
target="${2:---remote}"
# The name goes into SQL text below, so this check is the injection guard.
if [[ ! "$name" =~ ^[a-z0-9]{3,30}$ ]] || [[ "$target" != "--remote" && "$target" != "--local" ]]; then
  echo "usage: bun run block:nip05 <name> [--local]   (name: a-z 0-9, 3-30 chars)" >&2
  exit 2
fi

d1() {
  bun x wrangler d1 execute "$DB_NAME" "$target" -c "$CONFIG" --json --command "$1" 2>/dev/null
}

# Prints the row as one JSON line; empty when the name was never registered.
row() {
  d1 "SELECT name, pubkey, status, datetime(updated_at, 'unixepoch') AS updated, rebind_generation FROM nip05_handles WHERE name = '${name}'" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s)[0].results[0];process.stdout.write(r?JSON.stringify(r):"")})'
}

if ! before="$(row)"; then
  echo "✘ could not read the row (wrangler login / account?)" >&2
  exit 1
fi
if [[ -z "$before" ]]; then
  echo "✘ ${name} was never registered; to keep it from being taken, add it to RESERVED_NAMES" >&2
  exit 1
fi
echo "▸ ${target#--}: ${before}"

read -r -p "Type '${name}' to unlink it from its key: " confirm
if [[ "$confirm" != "$name" ]]; then
  echo "✘ not confirmed, nothing changed" >&2
  exit 1
fi

now="$(date +%s)"
d1 "UPDATE nip05_handles SET pubkey = 'erased', status = 'released', relays = '[]', updated_at = ${now}, released_at = COALESCE(released_at, ${now}), redirect_to = NULL, redirect_until = NULL WHERE name = '${name}'" >/dev/null
echo "▸ now: $(row)"
echo "✔ ${name} is unlinked; anyone can claim it after $(date -r $((now + 7 * 24 * 60 * 60)) '+%Y-%m-%d %H:%M')"
