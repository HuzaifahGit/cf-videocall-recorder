// The Worker: serves the call page (static assets), the room API and the recording endpoint.
//
//   GET  /api/info                        { keyRequired, recording } for the lobby (recording: shown before anyone joins)
//   POST /api/rt/<room>/join              needs the room key (header x-room-key) -> member id + token
//   POST /api/rt/<room>/<op>              session | publish | unpublish | subscribe | answer | unsubscribe | leave (member + token)
//   GET  /api/rt/<room>/ws?member=&token= the member's WebSocket
//   WS   /rec/<REC_KEY>/<room>/<session>/<member>/<track>   Cloudflare's WebSocket adapter delivering media (recording only)
//
// Secrets: RT_APP_ID, RT_APP_SECRET (Cloudflare Realtime app), ROOM_KEY (anyone joining needs it), REC_KEY (recording only).
import { Room, ROOM_RE } from "./room.js";

export { Room };

const OPS = /^(join|leave|session|publish|unpublish|subscribe|answer|unsubscribe|ws)$/;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// constant-time comparison, so the key can't be guessed from response timing
function sameKey(a, b) {
  const x = new TextEncoder().encode(String(a || "")), y = new TextEncoder().encode(String(b || ""));
  if (!x.length || x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const recordingOn = (env) => env.RECORD === "on" && !!(env.DATA && env.REC_KEY);

export default {
  async fetch(request, env) {
    const url = new URL(request.url), parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "rec") { // the SFU's adapter (it can't send headers, so the secret is in the path)
      if (!recordingOn(env) || !sameKey(parts[1], env.REC_KEY) || !ROOM_RE.test(parts[2] || "")) return new Response("Not found", { status: 404 });
      const stub = env.ROOM.get(env.ROOM.idFromName(parts[2]));
      return stub.fetch(new Request(`https://room/rec/${parts.slice(3).join("/")}`, { headers: { upgrade: request.headers.get("upgrade") || "", "x-room": parts[2] } }));
    }

    if (parts[0] === "api") {
      if (parts[1] === "info") return json({ keyRequired: true, recording: recordingOn(env) });
      if (parts[1] !== "rt" || !ROOM_RE.test(parts[2] || "") || !OPS.test(parts[3] || "") || parts.length !== 4) return json({ detail: "Not found" }, 404);
      const [room, op] = [parts[2], parts[3]];
      if (op === "join") {
        if (!env.ROOM_KEY) return json({ detail: "Set the ROOM_KEY secret first (see README)." }, 503);
        if (!sameKey(request.headers.get("x-room-key"), env.ROOM_KEY)) return json({ detail: "Wrong room key" }, 403);
      }
      const headers = new Headers({ "x-room": room, "x-colo": String(request.cf?.colo || ""), "x-origin": url.origin, "content-type": "application/json" });
      if (request.headers.get("upgrade")) headers.set("upgrade", request.headers.get("upgrade"));
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(new Request(`https://room/${op}${url.search}`, { method: request.method, headers,
        body: request.method === "POST" ? await request.text() : undefined }));
    }

    return env.ASSETS.fetch(request);
  },
};
