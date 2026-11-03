export type LimitedBody =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly tooLarge: boolean };

/**
 * Reads a request body, giving up as soon as it passes `maxBytes`, so a
 * client cannot make the Worker buffer an arbitrarily large upload before any
 * check runs. A declared Content-Length over the cap is refused unread.
 */
export async function readLimitedBody(request: Request, maxBytes: number): Promise<LimitedBody> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
  const reader = request.body?.getReader();
  if (reader === undefined) return { ok: true, bytes: new Uint8Array(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
