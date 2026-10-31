// Test-only: an X-Creds-Signature header as the app / web build it.
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import { didKeyFromScalar } from "../lib/pro/license";

const utf8 = new TextEncoder();
let counter = 0;

export function signRequest(
  scalarHex: string,
  claims: { m: string; p: string; iat?: number; jti?: string; aud?: string },
  kidScalarHex = scalarHex,
): string {
  const header = base64urlnopad.encode(utf8.encode(JSON.stringify({ alg: "ES256", kid: `${didKeyFromScalar(kidScalarHex)}#0` })));
  const payload = base64urlnopad.encode(
    utf8.encode(
      JSON.stringify({
        aud: claims.aud ?? "creds.id",
        m: claims.m,
        p: claims.p,
        iat: claims.iat ?? Math.floor(Date.now() / 1000),
        jti: claims.jti ?? `test-nonce-${String(++counter).padStart(8, "0")}`,
      }),
    ),
  );
  const sig = p256.sign(sha256(utf8.encode(`${header}.${payload}`)), Uint8Array.from(Buffer.from(scalarHex, "hex")), { prehash: false });
  return `${header}.${payload}.${base64urlnopad.encode(sig)}`;
}

export const NONCE_TABLE_SQL =
  "CREATE TABLE signed_request_nonces (jti TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL);";
