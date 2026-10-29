/**
 * Make the creds Pro license signing key (airmeishi docs/ref/09).
 *
 *   bun scripts/license-key.ts | bunx wrangler secret put LICENSE_SIGNING_KEY -c wrangler.nip05.jsonc
 *
 * Prints only the scalar on stdout (for the pipe) and the issuer did:key on
 * stderr. Pin that did in airmeishi packages/shared/src/pro/license.ts
 * (CREDS_LICENSE_ISSUERS) — until it is pinned every license fails closed.
 */
import { p256 } from "@noble/curves/nist.js";
import { didKeyFromScalar } from "../src/lib/pro/license";

const scalar = Buffer.from(p256.utils.randomSecretKey()).toString("hex");
console.error(`license issuer (pin this): ${didKeyFromScalar(scalar)}`);
process.stdout.write(scalar);
