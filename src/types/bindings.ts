import type { D1Database } from "@cloudflare/workers-types";

export interface CloudflareBindings {
  // PassKit certificate secrets (base64 encoded PEM files)
  PASS_CERT: string;
  PASS_KEY: string;
  WWDR_CERT: string;

  // Rate limiter binding
  RATE_LIMITER: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };
  REGISTER_RATE_LIMITER: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };

  // Inbox database + crypto secrets
  INBOX_DB: D1Database;
  PUSH_SECRET: string;

  // APNs credentials
  APPLE_P8_KEY: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APNS_TOPIC: string;
  APNS_HOST?: string;

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
