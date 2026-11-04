import type { CloudflareBindings } from "../types/bindings";

/** `/id/register` and `/id/recover` together, per client IP. */
export const NIP05_WRITE_LIMIT = 5;
export const NIP05_WRITE_WINDOW_MS = 60_000;

/**
 * Sliding-log check. A refused attempt is not recorded, so a client that keeps
 * hammering is let back in as soon as its oldest admitted hit leaves the window.
 */
export function admit(
  hits: readonly number[],
  now: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; hits: number[] } {
  const live = hits.filter((t) => t > now - windowMs);
  if (live.length >= limit) return { allowed: false, hits: live };
  return { allowed: true, hits: [...live, now] };
}

/**
 * One Durable Object per client IP. The Workers ratelimit binding never
 * returned 429 in production (2026-11-04: 35 registers in 70 s from one IP all
 * admitted); a DO is single-threaded, so this count is exact.
 */
export class Nip05WriteLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(): Promise<Response> {
    const now = Date.now();
    const stored = (await this.state.storage.get<number[]>("hits")) ?? [];
    const result = admit(stored, now, NIP05_WRITE_LIMIT, NIP05_WRITE_WINDOW_MS);
    await this.state.storage.put("hits", result.hits);
    await this.state.storage.setAlarm(now + NIP05_WRITE_WINDOW_MS);
    return Response.json({ allowed: result.allowed });
  }

  /** Every hit is older than the window by now; drop the IP's row. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

/**
 * Fails open: if the limiter itself is unreachable, a write still needs its
 * NIP-98 signature, and blocking every registration would be worse.
 */
export async function admitNip05Write(
  env: CloudflareBindings,
  clientIp: string,
): Promise<boolean> {
  try {
    const ns = env.NIP05_WRITE_LIMITER;
    const res = await ns.get(ns.idFromName(clientIp)).fetch("https://limiter/admit", {
      method: "POST",
    });
    const body = (await res.json()) as { allowed?: unknown };
    return body.allowed !== false;
  } catch (error) {
    console.error("nip05 write limiter unavailable", error);
    return true;
  }
}
