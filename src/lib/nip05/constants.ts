export const NIP05_DOMAIN = "creds.id";

/**
 * Name syntax (design §4 / G1). Two deliberate restrictions:
 *
 * - **No `.`** — `alice.dev` would be a valid name here AND a valid ATProto
 *   handle shape. The app/web `matchHandleResolver` registry is
 *   first-match-wins (ENS → ATProto → DNS), so `/@alice.dev` would be claimed
 *   by the ATProto resolver and resolve to the wrong person. Excluding `.`
 *   makes `matches` a pure syntactic partition: dotted → atproto/ens/dns,
 *   dotless → nip05. The two namespaces then cannot collide by construction.
 * - **No punctuation** — v1 issues only lowercase ASCII letters and digits.
 *   This avoids lookalike and routing edge cases as one entire class.
 * - **Minimum 3** — short names are part of the free identity surface; there
 *   is no paid short-name inventory.
 */
export const NIP05_NAME_MIN_LENGTH = 3;
export const NIP05_NAME_MAX_LENGTH = 30;

/**
 * Words never issued as names. Every name-shaped top-level path on creds.id
 * must be in here before it ships: add the word while it is still available
 * (`GET /id/availability`) — a name already issued is never taken back.
 * Design and per-group reasons: airmeishi docs/ref/15-plan-bare-name-url.md §3–§4.
 */
export const RESERVED_NIP05_NAMES: ReadonlySet<string> = new Set([
  // Paths the site, app links and workers already use (`_`, `c` and `id`
  // cannot match the name shape).
  "app", "edit", "privacy", "terms", "websign", "pear", "vault", "pro", "api",
  "assets", "index", "_", "c", "id",
  // Likely future site pages and product words.
  "account", "accounts", "login", "logout", "signin", "signout", "signup",
  "register", "settings", "profile", "profiles", "about", "docs", "faq",
  "blog", "download", "downloads", "pricing", "upgrade", "status", "search",
  "explore", "new", "create", "claim", "share", "scan", "check", "present",
  "people", "contacts", "card", "cards", "page", "pages", "link", "links",
  "embed", "widget", "home", "dashboard", "inbox", "notary", "witness",
  "witnesses", "badge", "badges", "proof", "proofs", "passport", "passkey",
  "passkeys", "recover", "recovery", "backup", "restore", "delete", "oauth",
  "auth", "callback", "sso", "license", "licenses", "cookies", "policy",
  "policies", "contact", "feedback", "report", "dmca", "copyright", "careers",
  "jobs", "press", "brand", "community", "developer", "developers", "sdk",
  "static", "media", "images", "files", "uploads", "cdn", "sitemap", "robots",
  "favicon", "manifest", "rss", "feed", "webhook", "webhooks", "graphql",
  "relay", "relays", "nip05", "did", "lnurl", "ios", "android", "user",
  "users", "wallet", "attest", "attestation",
  // Trust and impersonation.
  "admin", "administrator", "root", "system", "official", "verified",
  "verification", "verify", "security", "abuse", "support", "help",
  "helpdesk", "moderator", "mod", "staff", "team", "bot", "solidarity",
  "solidaritygg", "airmeishi", "creds", "credsid", "credentials", "nostr",
  "legal", "billing", "pay", "payment", "invoice",
  // Mailbox and DNS names: `name@creds.id` reads as an email address, and CAs
  // validate a domain through admin@, administrator@, webmaster@, hostmaster@
  // and postmaster@.
  "postmaster", "hostmaster", "webmaster", "www", "mail", "smtp", "ftp",
  "ns1", "ns2", "info", "noc", "noreply", "mailerdaemon",
  // Placeholders and examples shown in copy; mika/theo/rin/ada are the home
  // page personas.
  "you", "yourname", "name", "username", "handle", "example", "demo", "test",
  "dev", "staging", "null", "undefined", "none", "nobody", "anonymous",
  "everyone", "true", "false", "mika", "theo", "rin", "ada",
  // Platforms a Page shows badges for, and the resolver scheme names.
  "twitter", "github", "telegram", "bluesky", "bsky", "youtube", "spotify",
  "instagram", "threads", "tiktok", "linkedin", "facebook", "apple", "google",
  "atproto", "ens", "dns",
]);

export const AUDIT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const RENAME_WINDOW_SECONDS = 90 * 24 * 60 * 60;
export const MAX_RENAMES_PER_WINDOW = 1;

// NOTE — no quarantine-window constant exists any more, and adding one back
// would be a regression. Released names are tombstoned PERMANENTLY (design
// §4 / G3): the row is never deleted and never reassigned to a different
// pubkey, though the original holder may reclaim it indefinitely. That is
// what lets `/@name` be printed on a business card — a recyclable handle
// eventually points at a stranger, which is exactly why the app repo's
// research notes §2.5 ruled handles unfit for print.

/**
 * DoH endpoint for the recovery flow's `_did.<domain>` TXT lookup. Workers
 * cannot issue native DNS queries, so this is transport infrastructure, not a
 * trust root — the binding check itself still runs locally against the
 * supplied record (design §3.5 step 5).
 */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** Hard cap on a supplied old-record JWS, checked before any crypto work. */
export const MAX_OLD_RECORD_JWS_BYTES = 16_384;
