/**
 * creds Pro license minting (airmeishi docs/ref/09 license bridge). The
 * license is a compact ES256 JWS under the service's own did:key — the same
 * shape `@solidarity/shared` `verifyProLicense` checks against its pinned
 * issuer list. At most 7 days, never past the store expiry, so a purchase
 * rebound to another did stops renewing the old license within a week.
 */
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64urlnopad } from "@scure/base";

export const LICENSE_TYP = "creds.pro.license/v1";
export const LICENSE_MAX_SECONDS = 7 * 86_400;

const utf8 = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(hex)) throw new Error("license key must be 32-byte hex");
  return Uint8Array.from(hex.match(/../gu) ?? [], (h) => parseInt(h, 16));
}

/** did:key of a P-256 public key: z + base58btc(0x80 0x24 || compressed point). */
export function didKeyFromScalar(scalarHex: string): string {
  const compressed = p256.getPublicKey(hexToBytes(scalarHex), true);
  const bytes = new Uint8Array(2 + compressed.length);
  bytes.set([0x80, 0x24]);
  bytes.set(compressed, 2);
  return `did:key:z${base58.encode(bytes)}`;
}

/** Same key order as the app's `stableJSON` (sorted), so the payload bytes are canonical. */
function stableJSON(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])));
}

export function mintLicense(
  scalarHex: string,
  claim: { sub: string; product: string; storeExpiry: number },
  nowSeconds: number,
): string {
  const did = didKeyFromScalar(scalarHex);
  const header = base64urlnopad.encode(utf8.encode(JSON.stringify({ alg: "ES256", kid: `${did}#0` })));
  const exp = Math.min(nowSeconds + LICENSE_MAX_SECONDS, claim.storeExpiry);
  const payload = base64urlnopad.encode(
    utf8.encode(stableJSON({ typ: LICENSE_TYP, sub: claim.sub, product: claim.product, iat: nowSeconds, exp })),
  );
  const signingInput = `${header}.${payload}`;
  const sig = p256.sign(sha256(utf8.encode(signingInput)), hexToBytes(scalarHex), { prehash: false });
  return `${signingInput}.${base64urlnopad.encode(sig)}`;
}
