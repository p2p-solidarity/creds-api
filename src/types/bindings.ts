import type { D1Database } from "@cloudflare/workers-types";

export interface CloudflareBindings {
  // Rate limiter binding
  RATE_LIMITER: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };
  REGISTER_RATE_LIMITER: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };

  // The creds.id D1 (`solidarity_id`); the binding name predates the split.
  INBOX_DB: D1Database;

  // creds Pro license bridge (airmeishi docs/ref/09) — creds.id worker only.
  /** Hex P-256 scalar of the license signing key (scripts/license-key.ts). */
  LICENSE_SIGNING_KEY?: string;
  /** App Store Server API: .p8 PEM, key id, issuer id, bundle id. */
  ASC_P8_KEY?: string;
  ASC_KEY_ID?: string;
  ASC_ISSUER_ID?: string;
  IOS_BUNDLE_ID?: string;
  /** Play Developer API service-account JSON + package name. */
  PLAY_SERVICE_ACCOUNT_JSON?: string;
  ANDROID_PACKAGE?: string;
}

export type { CloudflareBindings as default };
