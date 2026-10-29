/**
 * The minted license must verify under the same did:key JWS rules the app's
 * `verifyProLicense` uses (exact {alg, kid} header, kid = <did>#0, raw r||s),
 * and must never outlive 7 days or the store expiry.
 */
import { describe, expect, test } from "bun:test";
import { verifyCompact } from "../nip05/jws";
import { didKeyFromScalar, LICENSE_TYP, mintLicense } from "./license";

const SCALAR = "11".repeat(32);
const NOW = 1_800_000_000;

describe("mintLicense", () => {
  test("verifies under the issuer did and carries the claim", () => {
    const jws = mintLicense(SCALAR, { sub: "did:key:zBuyer", product: "creds.pro.monthly", storeExpiry: NOW + 30 * 86_400 }, NOW);
    const r = verifyCompact(jws, didKeyFromScalar(SCALAR));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ typ: LICENSE_TYP, sub: "did:key:zBuyer", product: "creds.pro.monthly", iat: NOW, exp: NOW + 7 * 86_400 });
  });
  test("never outlives the store", () => {
    const jws = mintLicense(SCALAR, { sub: "did:key:zBuyer", product: "p", storeExpiry: NOW + 3600 }, NOW);
    const r = verifyCompact(jws, didKeyFromScalar(SCALAR));
    expect(r.ok && r.payload["exp"]).toBe(NOW + 3600);
  });
  test("does not verify under another did", () => {
    const jws = mintLicense(SCALAR, { sub: "did:key:zBuyer", product: "p", storeExpiry: NOW + 3600 }, NOW);
    expect(verifyCompact(jws, didKeyFromScalar("22".repeat(32))).ok).toBe(false);
  });
});
