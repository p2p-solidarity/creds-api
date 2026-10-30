/**
 * Store purchase lookups for the license bridge (airmeishi docs/ref/09).
 * Each asks the store directly over TLS and trusts that answer; nothing the
 * app sends about the purchase is believed except the identifier.
 *
 *   iOS     App Store Server API  GET /inApps/v1/subscriptions/{transactionId}
 *           (ES256 JWT with the App Store Connect .p8 key)
 *   Android Play Developer API    purchases.subscriptionsv2.get
 *           (OAuth service account, RS256 JWT bearer grant)
 */
import { base64urlnopad } from "@scure/base";
import type { CloudflareBindings } from "../../types/bindings";

export interface StorePurchase {
  /** Stable across renewals: originalTransactionId / the Play purchase token. */
  readonly key: string;
  readonly productId: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export type StoreResult =
  | { readonly ok: true; readonly value: StorePurchase }
  | { readonly ok: false; readonly error: "not_configured" | "not_found" | "inactive" | "store_unreachable" };

const utf8 = new TextEncoder();
const b64u = (bytes: Uint8Array | ArrayBuffer) => base64urlnopad.encode(new Uint8Array(bytes));
const b64uJson = (v: unknown) => b64u(utf8.encode(JSON.stringify(v)));

function pemBody(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/gu, "").replace(/\s+/gu, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0)).buffer;
}

function decodeJwsPayload(jws: string): Record<string, unknown> | null {
  try {
    const part = jws.split(".")[1] ?? "";
    return JSON.parse(new TextDecoder().decode(base64urlnopad.decode(part))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function appStoreToken(env: CloudflareBindings, now: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemBody(env.ASC_P8_KEY ?? ""), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const unsigned = `${b64uJson({ alg: "ES256", kid: env.ASC_KEY_ID, typ: "JWT" })}.${b64uJson({
    iss: env.ASC_ISSUER_ID,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
    bid: env.IOS_BUNDLE_ID,
  })}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8.encode(unsigned));
  return `${unsigned}.${b64u(sig)}`;
}

const APP_STORE_HOSTS = ["api.storekit.itunes.apple.com", "api.storekit-sandbox.itunes.apple.com"] as const;

export async function lookupAppStore(env: CloudflareBindings, transactionId: string, now: number): Promise<StoreResult> {
  if (!env.ASC_P8_KEY || !env.ASC_KEY_ID || !env.ASC_ISSUER_ID || !env.IOS_BUNDLE_ID) return { ok: false, error: "not_configured" };
  if (!/^[0-9]{1,32}$/u.test(transactionId)) return { ok: false, error: "not_found" };
  let body: { data?: { lastTransactions?: { status?: number; signedTransactionInfo?: string }[] }[] } | null = null;
  try {
    const token = await appStoreToken(env, now);
    // Apple's order: production first, sandbox on 404. TestFlight, sandbox
    // testers and App Review all buy in sandbox, even with a production build.
    for (const host of APP_STORE_HOSTS) {
      const res = await fetch(`https://${host}/inApps/v1/subscriptions/${transactionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404) continue;
      if (!res.ok) return { ok: false, error: "store_unreachable" };
      body = await res.json();
      break;
    }
  } catch {
    return { ok: false, error: "store_unreachable" };
  }
  if (body === null) return { ok: false, error: "not_found" };
  for (const group of body.data ?? []) {
    for (const t of group.lastTransactions ?? []) {
      // status 1 = active, 4 = billing grace period.
      if (t.status !== 1 && t.status !== 4) continue;
      const info = t.signedTransactionInfo ? decodeJwsPayload(t.signedTransactionInfo) : null;
      const expires = typeof info?.["expiresDate"] === "number" ? Math.floor(info["expiresDate"] / 1000) : 0;
      if (info === null || expires <= now || info["bundleId"] !== env.IOS_BUNDLE_ID) continue;
      return {
        ok: true,
        value: { key: `ios:${String(info["originalTransactionId"])}`, productId: String(info["productId"]), expiresAt: expires },
      };
    }
  }
  return { ok: false, error: "inactive" };
}

async function playToken(env: CloudflareBindings, now: number): Promise<string | null> {
  const sa = JSON.parse(env.PLAY_SERVICE_ACCOUNT_JSON ?? "{}") as { client_email?: string; private_key?: string };
  if (!sa.client_email || !sa.private_key) return null;
  const key = await crypto.subtle.importKey("pkcs8", pemBody(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const unsigned = `${b64uJson({ alg: "RS256", typ: "JWT" })}.${b64uJson({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 600,
  })}`;
  const assertion = `${unsigned}.${b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(unsigned)))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) return null;
  const body: { access_token?: string } = await res.json();
  return body.access_token ?? null;
}

export async function lookupPlay(env: CloudflareBindings, purchaseToken: string, now: number): Promise<StoreResult> {
  if (!env.PLAY_SERVICE_ACCOUNT_JSON || !env.ANDROID_PACKAGE) return { ok: false, error: "not_configured" };
  if (!/^[A-Za-z0-9._-]{10,512}$/u.test(purchaseToken)) return { ok: false, error: "not_found" };
  try {
    const token = await playToken(env, now);
    if (token === null) return { ok: false, error: "store_unreachable" };
    const res = await fetch(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${env.ANDROID_PACKAGE}/purchases/subscriptionsv2/tokens/${purchaseToken}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404 || res.status === 410) return { ok: false, error: "not_found" };
    if (!res.ok) return { ok: false, error: "store_unreachable" };
    const body: { subscriptionState?: string; linkedPurchaseToken?: string; lineItems?: { productId?: string; expiryTime?: string }[] } =
      await res.json();
    if (body.subscriptionState !== "SUBSCRIPTION_STATE_ACTIVE" && body.subscriptionState !== "SUBSCRIPTION_STATE_IN_GRACE_PERIOD") {
      return { ok: false, error: "inactive" };
    }
    const item = (body.lineItems ?? []).find((i) => i.expiryTime && Date.parse(i.expiryTime) / 1000 > now);
    if (!item?.productId || !item.expiryTime) return { ok: false, error: "inactive" };
    return {
      ok: true,
      value: {
        // An upgrade/renewal chain keeps pointing at its first token.
        key: `android:${body.linkedPurchaseToken ?? purchaseToken}`,
        productId: item.productId,
        expiresAt: Math.floor(Date.parse(item.expiryTime) / 1000),
      },
    };
  } catch {
    return { ok: false, error: "store_unreachable" };
  }
}
