// The room (Durable Object) against a fake Realtime SFU: join, tokens, publish, subscribe, mapping, chat relay, mute, leave.
import { Room } from "../src/room.js";

let fails = 0;
const check = (name, cond) => { console.log(cond ? "ok  " : "FAIL", name); if (!cond) fails++; };

const sfuCalls = [];
let sid = 0;
globalThis.fetch = async (url, init) => {
  const path = url.replace(/^https:\/\/rtc\.live\.cloudflare\.com\/v1\/apps\/APP/, "");
  const body = init.body ? JSON.parse(init.body) : null;
  sfuCalls.push({ path, method: init.method, body, auth: init.headers.authorization });
  const ok = (d) => new Response(JSON.stringify(d), { status: 200 });
  if (path === "/sessions/new") return ok({ sessionId: `S${++sid}` });
  if (path.endsWith("/tracks/new") && body.sessionDescription) return ok({ sessionDescription: { type: "answer", sdp: "ANSWER" }, tracks: body.tracks.map((t) => ({ trackName: t.trackName, mid: t.mid })) });
  if (path.endsWith("/tracks/new")) return ok({ requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: "OFFER" }, tracks: body.tracks.map((t, i) => ({ mid: String(10 + i), trackName: t.trackName })) });
  if (path.endsWith("/renegotiate")) return ok({});
  if (path.endsWith("/tracks/close")) return ok({ sessionDescription: { type: "answer", sdp: "ANSWER2" } });
  return new Response("{}", { status: 404 });
};
const store = new Map(), sockets = [];
const ctx = {
  storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }, setAlarm: async () => {} },
  acceptWebSocket: (ws, tags) => { ws.tags = tags; sockets.push(ws); },
  getWebSockets: (tag) => sockets.filter((s) => !tag || s.tags[0] === tag),
  getTags: (ws) => ws.tags,
};
globalThis.WebSocketPair = class { constructor() { const mk = () => ({ sent: [], readyState: 1, send(d) { this.sent.push(JSON.parse(d)); } }); this[0] = mk(); this[1] = mk(); } };
const OrigResponse = Response;
globalThis.Response = class extends OrigResponse { constructor(body, init = {}) { super(body, init.status === 101 ? { status: 200 } : init); if (init.webSocket) this.webSocket = init.webSocket; } };

const room = new Room(ctx, { RT_APP_ID: "APP", RT_APP_SECRET: "SECRET" });
const req = (op, body, extra = {}) => room.fetch(new Request(`https://room/${op}`, {
  method: body === undefined ? "GET" : "POST", headers: { "x-room": "main", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }));
const J = async (p) => (await p).json();

const a = await J(req("join", { name: "Alice" }));
const b = await J(req("join", { name: "<b>Bob</b>\u0007" }));
const A = { member: a.memberId, token: a.token }, B = { member: b.memberId, token: b.token };
check("members get ids and secret tokens", /^m-[0-9a-f]{8}$/.test(a.memberId) && /^[0-9a-f]{32}$/.test(a.token) && a.token !== b.token);
check("names are cleaned", b.name === "bBob/b");
check("join gives Cloudflare's STUN server", a.iceServers?.[0]?.urls === "stun:stun.cloudflare.com:3478");
let r = await req("session", { member: a.memberId, token: b.token, kind: "pub" });
check("a wrong token is refused", r.status === 403);
r = await req(`ws?member=${a.memberId}&token=nope`, undefined, { upgrade: "websocket" });
check("a socket with a wrong token is refused", r.status === 400);

await req(`ws?member=${a.memberId}&token=${a.token}`, undefined, { upgrade: "websocket" });
const serverA = sockets[0];
await req(`ws?member=${b.memberId}&token=${b.token}`, undefined, { upgrade: "websocket" });
const serverB = sockets[1];
check("sockets get the room state, without tokens", serverA.sent.at(-1)?.t === "state" && serverA.sent.at(-1).members.length === 2 && !JSON.stringify(serverA.sent).includes(a.token));

await J(req("session", { ...A, kind: "pub" }));
await J(req("session", { ...B, kind: "sub" }));
const pub = await J(req("publish", { ...A, sdp: "OFFER-A", tracks: [{ mid: "0", name: "microphone" }, { mid: "1", name: "camera" }, { mid: "2", name: "evil" }] }));
check("publish returns the SFU answer", pub.sdp === "ANSWER");
const pubCall = sfuCalls.find((c) => c.path.endsWith("/tracks/new") && c.body.sessionDescription);
check("publish sends only known track names, with the App Secret", pubCall.body.tracks.length === 2 && pubCall.auth === "Bearer SECRET");
const st = serverA.sent.at(-1).members.find((m) => m.id === a.memberId);
check("state lists tracks but no SFU session ids", st.tracks.join() === "microphone,camera" && !JSON.stringify(serverA.sent.at(-1)).includes("S1"));

const sub = await J(req("subscribe", { ...B, wants: [{ member: a.memberId, name: "camera" }, { member: a.memberId, name: "microphone" }, { member: b.memberId, name: "camera" }] }));
check("subscribe maps receiving mids to the member and track", sub.sdp === "OFFER" && sub.tracks.length === 2 && sub.tracks[0].member === a.memberId && sub.tracks[0].mid === "10");
const subCall = sfuCalls.filter((c) => c.path.endsWith("/tracks/new")).at(-1);
check("subscribe pulls from the publisher's session, never your own", subCall.path === "/sessions/S2/tracks/new" && subCall.body.tracks.every((t) => t.sessionId === "S1"));
await J(req("answer", { ...B, sdp: "ANSWER-B" }));
check("the subscriber's answer goes to renegotiate", sfuCalls.at(-1).path === "/sessions/S2/renegotiate");

serverA.sent.length = 0;
await room.webSocketMessage(serverB, JSON.stringify({ t: "text", topic: "chat", text: "hello" }));
check("chat goes to the others only", serverA.sent.some((m) => m.t === "text" && m.text === "hello" && m.from === b.memberId) && !serverB.sent.some((m) => m.t === "text"));
await room.webSocketMessage(serverA, JSON.stringify({ t: "mute", name: "microphone", muted: true }));
check("mute state reaches the room", serverB.sent.at(-1).members.find((m) => m.id === a.memberId).muted.microphone === true);
await room.webSocketMessage(serverB, JSON.stringify({ t: "attrs", attrs: { hand: "123", "BAD KEY": "x" } }));
check("a raised hand is kept; odd attribute names are ignored", JSON.stringify(serverA.sent.at(-1).members.find((m) => m.id === b.memberId).attrs) === '{"hand":"123"}');

const un = await J(req("unpublish", { ...A, sdp: "OFFER-A2", mids: ["1"] }));
check("unpublish drops the track from the room", un.sdp === "ANSWER2" && serverB.sent.at(-1).members.find((m) => m.id === a.memberId).tracks.join() === "microphone");
await J(req("leave", A));
check("leaving removes the member", serverB.sent.at(-1).members.length === 1);
check("no recording without RECORD=on", !store.has("rec"));

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
