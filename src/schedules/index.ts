import { purgeExpiredNip05Data } from "../lib/nip05/repository";
import { purgeExpiredNonces } from "../lib/signedRequest";
import type { CloudflareBindings } from "../types/bindings";

// Handle rows are never purged (design G3/G3a) — deleting one would free the
// name with no rebind marker for holders of an old link.
export async function runNip05Cleanup(env: CloudflareBindings) {
  const removed = await purgeExpiredNip05Data(
    env.INBOX_DB,
    Math.floor(Date.now() / 1000),
  );
  console.log(`🧹 Purged ${removed.audits} expired NIP-05 audit entries`);
  await purgeExpiredNonces(env.INBOX_DB, Math.floor(Date.now() / 1000));
}
