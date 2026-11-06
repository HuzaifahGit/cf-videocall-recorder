// One call room on Cloudflare Realtime SFU, as a Durable Object (one object per room name).
//
// It keeps who is in the call, which tracks each member publishes (microphone, camera, screen), mute states and raised hands, and
// makes every SFU API call with the App Secret (browsers never see it). Members reach it through the Worker at /api/rt/<room>/<op>.
// Joining needs the room key (checked by the Worker); after that each request carries the member id and a per-member token.
// A WebSocket per member carries room state, chat, reactions and attribute changes. Separate publishing and receiving
// PeerConnections, one SFU mutation at a time per session.
//
// Optional recording (RECORD = "on"): while two or more people are in the call, Cloudflare's WebSocket adapter streams each
// microphone (PCM) and shared screen (JPEG, 1 fps) to this Worker's /rec/<REC_KEY>/... address; the Room saves them to R2 under
// rec/<room>/<session>/ and collector/collect.py turns them into audio files and screen frames.

const SFU = "https://rtc.live.cloudflare.com/v1/apps";
const NAMES = new Set(["microphone", "camera", "screen_share"]);
const GONE_MS = 20_000; // a member whose socket closed is removed after this, unless it reconnects
const REC_CODEC = { microphone: "pcm", screen_share: "jpeg" };
const REC_SEGMENT_MS = 30_000; // one R2 object per 30 s of a track
const REC_GAP_MS = 600; // audio that stops for longer than this (mute, network) starts a new segment at its real time
const REC_RESUME_MS = 5 * 60_000; // two people back within this after the call dropped to one: the same recording continues
const REC_RETRY_MS = 3000;
export const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// a recording's name: its start time in UTC, e.g. 2026-11-06T02-00-31
export const sessionName = (ms) => new Date(ms).toISOString().slice(0, 19).replace(/:/g, "-");
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40) || "Guest";
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

// one protobuf Packet { uint32 sequenceNumber = 1; uint32 timestamp = 2; bytes payload = 5; } -> its payload
export function packetPayload(b) {
  let i = 0, payload = null;
  const varint = () => { let v = 0, mul = 1, x; do { if (i >= b.length) throw new Error("truncated"); x = b[i++]; v += (x & 0x7f) * mul; mul *= 128; } while (x & 0x80); return v; };
  try {
    while (i < b.length) {
      const tag = varint(), field = Math.floor(tag / 8), wire = tag & 7;
      if (wire === 0) varint();
      else if (wire === 2) { const len = varint(); if (i + len > b.length) return null; if (field === 5) payload = b.subarray(i, i + len); i += len; }
      else if (wire === 5) i += 4;
      else if (wire === 1) i += 8;
      else return null;
    }
  } catch { return null; }
  return payload;
}
// 48 kHz stereo s16le -> 48 kHz mono s16le
export function downmix(payload) {
  const src = new Int16Array(payload.slice().buffer), out = new Int16Array(src.length >> 1);
  for (let k = 0; k < out.length; k++) out[k] = (src[2 * k] + src[2 * k + 1]) >> 1;
  return out;
}

// Collects one adapter stream and writes it to R2 in pieces: <prefix>/<start ms>.pcm (raw mono 48 kHz s16le, continuous
// from that start) or <prefix>/<start ms>.jpgs (frames, each: 8-byte float64 ms + 4-byte uint32 length + JPEG).
export class Recorder {
  constructor(put, prefix, kind, now = () => Date.now()) {
    this.put = put; this.prefix = prefix; this.kind = kind; this.now = now;
    this.parts = []; this.bytes = 0; this.start = 0; this.last = 0; this.chain = Promise.resolve(); this.count = 0;
  }
  add(data) {
    const payload = packetPayload(new Uint8Array(data));
    if (!payload || !payload.length) return;
    const now = this.now();
    if (this.kind === "pcm") {
      const mono = downmix(payload), ms = mono.length / 48;
      const end = this.start + this.bytes / 2 / 48;
      if (this.bytes && (now - end > REC_GAP_MS || this.bytes / 96 >= REC_SEGMENT_MS)) this.flush(); // 96 bytes = 1 ms
      if (!this.bytes) this.start = now - ms;
      this.parts.push(new Uint8Array(mono.buffer)); this.bytes += mono.byteLength;
    } else {
      if (this.bytes && now - this.start >= REC_SEGMENT_MS) this.flush();
      if (!this.bytes) this.start = now;
      const head = new DataView(new ArrayBuffer(12));
      head.setFloat64(0, now, true); head.setUint32(8, payload.length, true);
      this.parts.push(new Uint8Array(head.buffer), payload.slice()); this.bytes += 12 + payload.length;
    }
    this.last = now;
  }
  idle() { if (this.bytes && this.now() - this.last > 2000) this.flush(); } // nothing for 2 s: save what there is
  flush() {
    if (!this.bytes) return this.chain;
    const body = new Uint8Array(this.bytes);
    let o = 0; for (const p of this.parts) { body.set(p, o); o += p.length; }
    const key = `${this.prefix}/${Math.round(this.start)}.${this.kind === "pcm" ? "pcm" : "jpgs"}`;
    this.parts = []; this.bytes = 0; this.count++;
    this.chain = this.chain.then(() => this.put(key, body)).catch((e) => console.error("rec put", key, e));
    return this.chain;
  }
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.members = null; // memberId -> { id, token, name, pub, sub, tracks: {name: mid}, muted: {name: bool}, attrs, gone }
    this.queues = new Map(); // sessionId -> promise chain: one SFU mutation at a time per session
    this.rec = undefined; // { session, startedAt, endedAt, names, adapters: {"<member>/<track>": adapterId}, failed }
    this.recorders = new Set();
  }

  async load() {
    if (!this.members) this.members = new Map(Object.entries((await this.ctx.storage.get("members")) || {}));
    if (this.room === undefined) this.room = (await this.ctx.storage.get("room")) || "";
    if (this.origin === undefined) this.origin = (await this.ctx.storage.get("origin")) || "";
  }
  save() { return this.ctx.storage.put("members", Object.fromEntries(this.members)); }

  serial(sessionId, fn) {
    const prev = this.queues.get(sessionId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(sessionId, next.finally(() => { if (this.queues.get(sessionId) === next) this.queues.delete(sessionId); }));
    return next;
  }

  async sfu(path, method, body) {
    const r = await fetch(`${SFU}/${this.env.RT_APP_ID}${path}`, {
      method, headers: { authorization: `Bearer ${this.env.RT_APP_SECRET}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    const detail = data.errorDescription || (data.tracks || []).map((t) => t.errorCode).filter(Boolean).join(", ");
    if (!r.ok || data.errorCode) throw Object.assign(new Error(detail || `SFU HTTP ${r.status}`), { status: r.status >= 400 ? r.status : 502, data });
    return data;
  }

  // what every member sees: no SFU session ids or tokens, only member ids, names and published track names
  snapshot() {
    return [...this.members.values()].filter((m) => !m.gone).map((m) => ({
      id: m.id, name: m.name, tracks: Object.keys(m.tracks), muted: m.muted, attrs: m.attrs,
    }));
  }
  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const tag = this.ctx.getTags(ws)[0] || "";
      if (except && tag === except) continue;
      try { ws.send(data); } catch { /* closing */ }
    }
  }
  async changed() {
    this.broadcast({ t: "state", members: this.snapshot(), rec: this.recStatus() });
    await this.save();
    // Recording runs in the background, never inside the request: starting an adapter makes Cloudflare connect back into this
    // Room, and awaiting that inside a publish held the sharer's "Share" for ~8 s. It must never break or slow the call.
    const rec = this.recSync().catch((e) => console.error("recording", e)).then(() => this.recBroadcast());
    if (this.ctx.waitUntil) this.ctx.waitUntil(rec);
  }
  recBroadcast() { const r = this.recStatus(), k = JSON.stringify(r); if (k !== (this.recSent || '{"on":false,"streams":0}')) { this.recSent = k; this.broadcast({ t: "rec", rec: r }); } }
  // what the page shows: recording on, and how many streams (mics, screen) are arriving right now
  recStatus() { const on = !!(this.rec && !this.rec.endedAt); return { on, streams: on ? this.recorders.size : 0 }; }

  // ---------- recording (optional) ----------
  recReady() { return this.env.RECORD === "on" && !!(this.env.DATA && this.env.REC_KEY && (this.env.REC_URL || this.origin)); }
  // Record while two or more people are in the call: one adapter per published microphone and shared screen.
  recSync() {
    if (!this.recReady()) return Promise.resolve();
    return this.serial("rec", async () => {
      if (this.rec === undefined) this.rec = (await this.ctx.storage.get("rec")) || null;
      const now = Date.now(), present = [...this.members.values()].filter((m) => !m.gone);
      let rec = this.rec;
      const before = JSON.stringify(rec);
      if (present.length >= 2) {
        if (!rec || (rec.endedAt && now - rec.endedAt > REC_RESUME_MS)) rec = this.rec = { session: sessionName(now), startedAt: now, endedAt: 0, names: {}, adapters: {}, failed: 0 };
        rec.endedAt = 0;
        const want = new Map();
        for (const m of present) {
          rec.names[m.id] = m.name;
          for (const name of Object.keys(m.tracks)) if (REC_CODEC[name] && m.pub) want.set(`${m.id}/${name}`, { m, name });
        }
        rec.failed = 0;
        const base = (this.env.REC_URL || this.origin).replace(/\/+$/, "");
        for (const [key, { m, name }] of want) {
          if (rec.adapters[key]) continue;
          const endpoint = `${base.replace(/^http/, "ws")}/rec/${this.env.REC_KEY}/${this.room}/${rec.session}/${m.id}/${name}`;
          try {
            const r = await this.sfu("/adapters/websocket/new", "POST", { tracks: [{ location: "remote", sessionId: m.pub, trackName: name, endpoint, outputCodec: REC_CODEC[name] }] });
            const t = (r.tracks || [])[0] || {};
            if (t.adapterId) rec.adapters[key] = t.adapterId;
            else { rec.failed++; if (t.errorCode !== "not_found_track_error") this.recNote(rec, `${name}: ${t.errorCode || "no adapter"} ${t.errorDescription || ""}`); }
          } catch (e) { rec.failed++; if (!/not_found_track/.test(e.message)) this.recNote(rec, `${name}: ${e.message}`); }
        }
        const gone = Object.keys(rec.adapters).filter((k) => !want.has(k));
        if (gone.length) await this.recClose(gone);
      } else if (rec && !rec.endedAt) {
        await this.recClose(Object.keys(rec.adapters));
        rec.endedAt = now;
      }
      // a track the SFU hasn't had packets for yet ("not_found_track_error"): keep trying every few seconds until it starts
      if (rec?.failed && !rec.endedAt) await this.ctx.storage.setAlarm(now + REC_RETRY_MS);
      if (!rec || JSON.stringify(rec) === before) return;
      await this.ctx.storage.put("rec", rec);
      const { adapters, ...meta } = rec;
      await this.env.DATA.put(`rec/${this.room}/${rec.session}/meta.json`, JSON.stringify({ ...meta, room: this.room }), { httpMetadata: { contentType: "application/json" } });
    });
  }
  recNote(rec, msg) { console.error("recording", msg); rec.errors = [...(rec.errors || []), `${new Date().toISOString().slice(11, 19)} ${msg}`.slice(0, 300)].slice(-8); }
  async recClose(keys) {
    const ids = keys.map((k) => this.rec.adapters[k]).filter(Boolean);
    for (const k of keys) delete this.rec.adapters[k];
    for (let i = 0; i < ids.length; i += 4) {
      await this.sfu("/adapters/websocket/close", "POST", { tracks: ids.slice(i, i + 4).map((adapterId) => ({ adapterId })) }).catch((e) => console.error("adapter close", e.message));
    }
  }
  // the SFU's adapter connects here (through the Worker's /rec route; the key is already checked)
  recSocket(request, parts) {
    const [, session, member, track] = parts; // rec/<session>/<member>/<track>
    if (!/^[0-9T-]{19}$/.test(session || "") || !/^m-[0-9a-f]{8}$/.test(member || "") || !REC_CODEC[track]) return json({ detail: "Bad recording path" }, 400);
    if (request.headers.get("upgrade") !== "websocket") return json({ detail: "WebSocket only" }, 426);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept(); // not hibernatable on purpose: the Room stays awake while media flows, so nothing buffered is lost
    try { server.binaryType = "arraybuffer"; } catch { /* older runtimes: Blobs, converted below */ }
    const r = new Recorder((key, body) => this.env.DATA.put(key, body), `rec/${this.room}/${session}/${member}-${track}`, REC_CODEC[track]);
    this.recorders.add(r);
    this.recBroadcast();
    const tick = setInterval(() => r.idle(), 1000);
    let queue = Promise.resolve();
    const end = () => queue.then(() => { clearInterval(tick); r.flush(); this.recorders.delete(r); this.recBroadcast(); });
    server.addEventListener("message", (e) => {
      const d = e.data;
      if (typeof d === "string") return;
      // binary messages can arrive as Blobs; convert in order (a chain), so pieces stay in sequence
      queue = queue.then(async () => {
        const buf = d instanceof ArrayBuffer ? d : ArrayBuffer.isView(d) ? d.buffer : await d.arrayBuffer();
        try { r.add(buf); } catch (err) { console.error("recording add", track, err.message); }
      });
    });
    server.addEventListener("close", end);
    server.addEventListener("error", end);
    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(request) {
    if (!this.env.RT_APP_ID || !this.env.RT_APP_SECRET) return json({ detail: "This call isn't set up yet (RT_APP_ID / RT_APP_SECRET)." }, 503);
    await this.load();
    const url = new URL(request.url);
    const op = url.pathname.replace(/^\/+/, "");
    const room = request.headers.get("x-room") || "";
    if (ROOM_RE.test(room) && room !== this.room) { this.room = room; await this.ctx.storage.put("room", room); }
    if (op.startsWith("rec/")) return this.recSocket(request, op.split("/"));

    if (op === "ws") {
      const m = this.members.get(url.searchParams.get("member") || "");
      if (!m || m.token !== url.searchParams.get("token") || request.headers.get("upgrade") !== "websocket") return json({ detail: "Bad member" }, 400);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [m.id]);
      if (m.gone) { m.gone = 0; await this.changed(); }
      server.send(JSON.stringify({ t: "state", members: this.snapshot(), rec: this.recStatus() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    let body = {};
    if (request.method === "POST") {
      const text = await request.text();
      if (text.length > 200_000) return json({ detail: "Too large" }, 413);
      try { body = text ? JSON.parse(text) : {}; } catch { return json({ detail: "Bad JSON" }, 400); }
    }
    if (op === "join") { // the Worker has checked the room key
      const origin = request.headers.get("x-origin") || "";
      if (origin && origin !== this.origin) { this.origin = origin; await this.ctx.storage.put("origin", origin); }
      const id = `m-${hex(4)}`, token = hex(16), name = cleanName(body.name);
      this.members.set(id, { id, token, name, pub: "", sub: "", tracks: {}, muted: {}, attrs: {}, gone: 0 });
      await this.changed();
      return json({ memberId: id, token, name, colo: request.headers.get("x-colo") || "", iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
    }
    const m = this.members.get(String(body.member || ""));
    if (!m || m.token !== body.token) return json({ detail: "Not a member of this call" }, 403);

    try {
      if (op === "leave") {
        this.members.delete(m.id);
        await this.changed();
        return json({ ok: true });
      }
      if (op === "session") { // a PeerConnection's SFU session: kind "pub" (sending) or "sub" (receiving)
        const kind = body.kind === "sub" ? "sub" : "pub";
        const { sessionId } = await this.sfu("/sessions/new", "POST");
        m[kind] = sessionId;
        if (kind === "pub") m.tracks = {};
        await this.changed();
        return json({ sessionId });
      }
      if (op === "publish") { // browser offer with new sendonly transceivers -> SFU answer
        const tracks = (body.tracks || []).filter((t) => NAMES.has(t.name) && typeof t.mid === "string");
        if (!m.pub || !tracks.length || typeof body.sdp !== "string") return json({ detail: "Bad publish" }, 400);
        const r = await this.serial(m.pub, () => this.sfu(`/sessions/${m.pub}/tracks/new`, "POST", {
          sessionDescription: { type: "offer", sdp: body.sdp }, tracks: tracks.map((t) => ({ location: "local", mid: t.mid, trackName: t.name })) }));
        for (const t of r.tracks || []) if (!t.errorCode && t.trackName) m.tracks[t.trackName] = t.mid;
        await this.changed();
        return json({ sdp: r.sessionDescription?.sdp, tracks: r.tracks });
      }
      if (op === "unpublish") { // browser offer after stopping transceivers -> SFU answer
        const mids = (body.mids || []).filter((x) => typeof x === "string");
        if (!m.pub || !mids.length || typeof body.sdp !== "string") return json({ detail: "Bad unpublish" }, 400);
        const r = await this.serial(m.pub, () => this.sfu(`/sessions/${m.pub}/tracks/close`, "PUT", {
          sessionDescription: { type: "offer", sdp: body.sdp }, tracks: mids.map((mid) => ({ mid })), force: false }));
        for (const [n, mid] of Object.entries(m.tracks)) if (mids.includes(mid)) delete m.tracks[n];
        await this.changed();
        return json({ sdp: r.sessionDescription?.sdp });
      }
      if (op === "subscribe") { // pull other members' tracks onto this member's receiving session -> SFU offer
        if (!m.sub) return json({ detail: "No receiving session" }, 400);
        const wants = (body.wants || []).map((w) => ({ w, pub: this.members.get(String(w.member)) }))
          .filter(({ w, pub }) => pub && pub.id !== m.id && pub.pub && pub.tracks[w.name] && NAMES.has(w.name));
        if (!wants.length) return json({ tracks: [] });
        const r = await this.serial(m.sub, () => this.sfu(`/sessions/${m.sub}/tracks/new`, "POST", {
          tracks: wants.map(({ w, pub }) => ({ location: "remote", sessionId: pub.pub, trackName: w.name })) }));
        // tell the browser which receiving mid carries which member's track
        const tracks = (r.tracks || []).map((t, i) => ({ mid: t.mid, member: wants[i].pub.id, name: wants[i].w.name, error: t.errorCode || "" }));
        return json({ sdp: r.requiresImmediateRenegotiation ? r.sessionDescription?.sdp : "", tracks });
      }
      if (op === "answer") { // the browser's answer to an SFU offer on its receiving session
        if (!m.sub || typeof body.sdp !== "string") return json({ detail: "Bad answer" }, 400);
        await this.serial(m.sub, () => this.sfu(`/sessions/${m.sub}/renegotiate`, "PUT", { sessionDescription: { type: "answer", sdp: body.sdp } }));
        return json({ ok: true });
      }
      if (op === "unsubscribe") { // drop received tracks that ended (the other member unpublished or left)
        const mids = (body.mids || []).filter((x) => typeof x === "string");
        if (!m.sub || !mids.length) return json({ ok: true });
        const r = await this.serial(m.sub, () => this.sfu(`/sessions/${m.sub}/tracks/close`, "PUT", { tracks: mids.map((mid) => ({ mid })), force: true }));
        return json({ sdp: r.requiresImmediateRenegotiation ? r.sessionDescription?.sdp : "" });
      }
    } catch (e) {
      return json({ detail: e.message }, e.status || 502);
    }
    return json({ detail: "Unknown operation" }, 404);
  }

  // ---------- the member's socket: chat/reactions are relayed, mute states and attributes update the room ----------
  async webSocketMessage(ws, raw) {
    await this.load();
    const id = this.ctx.getTags(ws)[0], m = this.members.get(id);
    if (!m || typeof raw !== "string" || raw.length > 8000) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === "text" && typeof msg.text === "string" && /^(chat|reaction)$/.test(msg.topic)) {
      this.broadcast({ t: "text", topic: msg.topic, text: msg.text.slice(0, 2000), from: id }, id);
    } else if (msg.t === "mute" && NAMES.has(msg.name)) {
      m.muted[msg.name] = !!msg.muted; await this.changed();
    } else if (msg.t === "attrs" && msg.attrs && typeof msg.attrs === "object") {
      for (const [k, v] of Object.entries(msg.attrs).slice(0, 8)) if (/^[a-z]{1,16}$/.test(k)) m.attrs[k] = String(v).slice(0, 64);
      await this.changed();
    } else if (msg.t === "ping") {
      ws.send(JSON.stringify({ t: "pong" }));
    }
  }
  async webSocketClose(ws) { await this.dropped(ws); }
  async webSocketError(ws) { await this.dropped(ws); }
  async dropped(ws) {
    await this.load();
    const id = this.ctx.getTags(ws)[0], m = this.members.get(id);
    if (!m || this.ctx.getWebSockets(id).some((s) => s !== ws && s.readyState === 1)) return;
    m.gone = Date.now(); await this.save();
    await this.ctx.storage.setAlarm(Date.now() + GONE_MS);
  }
  async alarm() {
    await this.load();
    let removed = false;
    for (const [id, m] of this.members) if (m.gone && Date.now() - m.gone >= GONE_MS - 500) { this.members.delete(id); removed = true; }
    if (removed) await this.changed();
    else await this.recSync(); // retries recording streams that had no packets yet
    if ([...this.members.values()].some((m) => m.gone)) await this.ctx.storage.setAlarm(Date.now() + GONE_MS);
  }
}
