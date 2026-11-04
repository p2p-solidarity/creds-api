import { purgeExpiredNip05Data } from "../lib/nip05/repository";
import { purgeExpiredNonces } from "../lib/signedRequest";
import type { CloudflareBindings } from "../types/bindings";

// Handle rows are permanent tombstones (design G3) and are never purged —
// deleting one would quietly free the name for a stranger to take.
export async function runNip05Cleanup(env: CloudflareBindings) {
  const removed = await purgeExpiredNip05Data(
    env.INBOX_DB,
    Math.floor(Date.now() / 1000),
  );
  console.log(`🧹 Purged ${removed.audits} expired NIP-05 audit entries`);
  await purgeExpiredNonces(env.INBOX_DB, Math.floor(Date.now() / 1000));
}
