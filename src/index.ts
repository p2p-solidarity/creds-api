/**
 * `airmeishi-backend` — retired 2026-11-04. The Shoutouts inbox, PassKit
 * signing and the old NIP-05 copy are shut down and the inbox D1 is deleted.
 *
 * One route is left: app 2.0.0's account deletion POSTs `/inbox/delete` to
 * this workers.dev host (hard-coded in that binary) and treats any non-2xx as
 * a failed step, which blocks the local wipe. No message is held anywhere any
 * more, so `deleted: 0` is the true answer for every key and needs no
 * signature check. Delete this Worker once 2.0.0 is no longer in use.
 */
export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/inbox/delete") {
      return Response.json({ deleted: 0 });
    }
    return Response.json({ error: "gone" }, { status: 410 });
  },
};
