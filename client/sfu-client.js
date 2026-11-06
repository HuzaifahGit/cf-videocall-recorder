// The browser side of a call on Cloudflare Realtime SFU. Its API shape (Room, RoomEvent, Track, LocalTrack...) follows the
// familiar one of open-source WebRTC client SDKs, so the page code stays simple; the implementation is this file's own.
// Media: one sending PeerConnection (camera, mic, screen) and one receiving PeerConnection, each with its own SFU session; every
// SDP exchange goes through the room (/api/rt/<room>/*, a Durable Object holding the App Secret) and runs one at a time per
// connection. Room state, chat, reactions, mute and raised hands travel over the room's WebSocket.

export const Track = {
  Kind: { Audio: "audio", Video: "video" },
  Source: { Camera: "camera", Microphone: "microphone", ScreenShare: "screen_share" },
};
export const VideoPresets = {
  h720: { resolution: { width: 1280, height: 720, frameRate: 30 } },
  h1080: { resolution: { width: 1920, height: 1080, frameRate: 30 } },
};
export const RoomEvent = {
  TrackSubscribed: "trackSubscribed", TrackUnsubscribed: "trackUnsubscribed", TrackMuted: "trackMuted", TrackUnmuted: "trackUnmuted",
  ParticipantConnected: "participantConnected", ParticipantDisconnected: "participantDisconnected", LocalTrackUnpublished: "localTrackUnpublished",
  ActiveSpeakersChanged: "activeSpeakersChanged", Reconnecting: "reconnecting", Reconnected: "reconnected", Disconnected: "disconnected",
  ConnectionQualityChanged: "connectionQualityChanged", ParticipantAttributesChanged: "participantAttributesChanged",
};
export const ParticipantEvent = { LocalTrackCpuConstrained: "localTrackCpuConstrained" };

class Emitter {
  constructor() { this._h = {}; }
  on(e, f) { (this._h[e] ||= []).push(f); return this; }
  emit(e, ...a) { for (const f of this._h[e] || []) { try { f(...a); } catch (err) { console.error(e, err); } } }
}
let ROOM = "main", AUTH = {}; // the room name, and { member, token } once joined
const api = async (op, body, headers = {}) => {
  const r = await fetch(`api/rt/${ROOM}/${op}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ...AUTH, ...(body || {}) }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `room ${op}: HTTP ${r.status}`);
  return d;
};
// one SDP exchange at a time per PeerConnection (Cloudflare: serialize mutations per session)
const queue = () => { let p = Promise.resolve(); return (fn) => (p = p.catch(() => {}).then(fn).catch((e) => { diag("error", { msg: String(e?.message || e).slice(0, 200) }); throw e; })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// diagnostics: negotiation steps, track arrival, timings (the page can listen for "sfu-log")
const diag = (type, data = {}) => { try { dispatchEvent(new CustomEvent("sfu-log", { detail: { type, ...data } })); } catch { /* no window */ } };

function attachTo(mediaTrack, el) {
  el ||= document.createElement(mediaTrack.kind === "audio" ? "audio" : "video");
  el.autoplay = true; el.playsInline = true;
  if (mediaTrack.kind === "video") el.muted = true;
  el.srcObject = new MediaStream([mediaTrack]);
  el.play?.().catch(() => {});
  return el;
}

// ---------- local tracks (camera, mic, screen) ----------
class LocalTrack {
  constructor(kind, source, raw, constraints) {
    this.kind = kind; this.source = source; this.raw = raw; this.constraints = constraints;
    this.processor = null; this.sender = null; this.isMuted = false; this.elements = []; this.codec = "";
    this._bytes = null; this.currentBitrate = 0;
  }
  get mediaStreamTrack() { return this.processor?.processedTrack || this.raw; }
  attach(el) { const e = attachTo(this.mediaStreamTrack, el); if (!this.elements.includes(e)) this.elements.push(e); return e; }
  detach() { const els = this.elements; this.elements = []; return els; }
  async _swap() { // after the processor or the device changes: preview and sender carry the new track
    for (const e of this.elements) e.srcObject = new MediaStream([this.mediaStreamTrack]);
    if (this.sender) await this.sender.replaceTrack(this.isMuted && this.kind === "audio" ? null : this.mediaStreamTrack);
  }
  async mute() { this.isMuted = true; this.raw.enabled = false; if (this.processor?.processedTrack) this.processor.processedTrack.enabled = false; this.room?._muted(this, true); }
  async unmute() { this.isMuted = false; this.raw.enabled = true; if (this.processor?.processedTrack) this.processor.processedTrack.enabled = true; this.room?._muted(this, false); }
  async setProcessor(p) {
    if (this.processor && this.processor !== p) await this.processor.destroy?.();
    this.processor = p;
    await p.init({ track: this.raw, kind: this.kind, element: this.elements[0] });
    await this._swap();
  }
  async stopProcessor() { const p = this.processor; this.processor = null; await p?.destroy?.(); await this._swap(); }
  async restartTrack(opts = {}) {
    const c = this.kind === "video" ? videoConstraints(opts) : audioConstraints(opts);
    const s = await navigator.mediaDevices.getUserMedia(this.kind === "video" ? { video: c } : { audio: c });
    const old = this.raw; this.raw = s.getTracks()[0]; this.raw.enabled = !this.isMuted; old.stop();
    if (this.processor) await this.processor.restart?.({ track: this.raw, kind: this.kind, element: this.elements[0] });
    await this._swap();
  }
  prioritizePerformance() {
    const p = this.sender?.getParameters();
    this._perf = true;
    if (p?.encodings?.[0]) { p.encodings[0].scaleResolutionDownBy = 2; this.sender.setParameters(p).catch(() => {}); }
  }
  async getSenderStats() {
    if (!this.sender) return [];
    const out = [];
    (await this.sender.getStats()).forEach((s) => {
      if (s.type === "outbound-rtp") out.push({ rid: s.rid || "", frameWidth: s.frameWidth, frameHeight: s.frameHeight, framesPerSecond: s.framesPerSecond,
        targetBitrate: s.targetBitrate, qualityLimitationReason: s.qualityLimitationReason, bytesSent: s.bytesSent,
        encoderImplementation: s.encoderImplementation, powerEfficientEncoder: s.powerEfficientEncoder });
    });
    return out;
  }
  stop() { this.raw.stop(); this.processor?.destroy?.(); }
}
const videoConstraints = (o) => ({ width: { ideal: o.resolution?.width || 1280 }, height: { ideal: o.resolution?.height || 720 }, frameRate: { ideal: o.resolution?.frameRate || 30 },
  ...(o.deviceId ? { deviceId: { exact: o.deviceId } } : {}) });
const audioConstraints = (o) => ({ echoCancellation: o.echoCancellation ?? true, noiseSuppression: o.noiseSuppression ?? true, autoGainControl: o.autoGainControl ?? true,
  channelCount: o.channelCount || 1, sampleRate: o.sampleRate || 48000, ...(o.deviceId ? { deviceId: { exact: o.deviceId } } : {}) });

export async function createLocalVideoTrack(opts = {}) {
  const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(opts) });
  return new LocalTrack("video", Track.Source.Camera, s.getVideoTracks()[0], opts);
}
export async function createLocalAudioTrack(opts = {}) {
  const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(opts) });
  return new LocalTrack("audio", Track.Source.Microphone, s.getAudioTracks()[0], opts);
}

// ---------- remote side ----------
class RemoteTrack {
  constructor(kind, source, mediaStreamTrack, receiver) { this.kind = kind; this.source = source; this.mediaStreamTrack = mediaStreamTrack; this.receiver = receiver; this.elements = []; this.currentBitrate = 0; this._bytes = null; }
  attach(el) { const e = attachTo(this.mediaStreamTrack, el); if (this.kind === "audio" && Room._sink && e.setSinkId) e.setSinkId(Room._sink).catch(() => {}); this.elements.push(e); return e; }
  detach() { const els = this.elements; this.elements = []; return els; }
  async getReceiverStats() {
    let out = null, codecs = {};
    const stats = await this.receiver.getStats();
    stats.forEach((s) => { if (s.type === "codec") codecs[s.id] = s.mimeType; });
    stats.forEach((s) => { if (s.type === "inbound-rtp") out = { frameWidth: s.frameWidth, frameHeight: s.frameHeight, framesDecoded: s.framesDecoded, packetsLost: s.packetsLost,
      jitter: s.jitter, framesDropped: s.framesDropped, mimeType: codecs[s.codecId] || "", bytesReceived: s.bytesReceived, audioLevel: s.audioLevel }; });
    return out;
  }
}
class Publication {
  constructor(source, kind) { this.source = source; this.kind = kind; this.track = null; this.isMuted = false; this.mid = ""; }
  get videoTrack() { return this.kind === "video" ? this.track : null; }
}
class RemoteParticipant {
  constructor(m) { this.identity = m.id; this.name = m.name; this.attributes = { ...(m.attrs || {}) }; this.trackPublications = new Map(); }
  get videoTrackPublications() { return new Map([...this.trackPublications].filter(([, p]) => p.kind === "video")); }
  getTrackPublication(source) { return this.trackPublications.get(source); }
}
const kindOf = (name) => name === Track.Source.Microphone ? "audio" : "video";

// ---------- you ----------
class LocalParticipant extends Emitter {
  constructor(room) { super(); this.room = room; this.identity = ""; this.name = ""; this.attributes = {}; this.pubs = new Map(); }
  get isScreenShareEnabled() { return this.pubs.has(Track.Source.ScreenShare); }
  getTrackPublication(source) { const t = this.pubs.get(source); return t && { track: t, videoTrack: t.kind === "video" ? t : null, isMuted: t.isMuted, source }; }
  async publishTrack(track, { source } = {}) {
    track.source = source || track.source; track.room = this.room;
    await this.room._publish(track);
    this.pubs.set(track.source, track);
  }
  async setScreenShareEnabled(on, opts = {}) {
    if (!on) { const t = this.pubs.get(Track.Source.ScreenShare); if (t) await this._unpublish(t); return; }
    if (this.isScreenShareEnabled) return;
    const tClick = performance.now();
    // A CaptureController lets the call page scroll and zoom a shared tab (Captured Surface Control, Chrome 136+ desktop)
    const controller = globalThis.CaptureController ? new CaptureController() : undefined;
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false, ...(controller ? { controller } : {}) });
    const raw = s.getVideoTracks()[0];
    if (opts.contentHint) raw.contentHint = opts.contentHint;
    const t = new LocalTrack("video", Track.Source.ScreenShare, raw, {});
    t.controller = controller; t.surface = raw.getSettings().displaySurface || "";
    raw.addEventListener("ended", () => { if (this.pubs.get(Track.Source.ScreenShare) === t) this._unpublish(t); });
    const tPicked = performance.now(), set = raw.getSettings();
    await this._cameraCap(true); // free the bandwidth before the first screen frames go out
    try { await this.publishTrack(t, { source: Track.Source.ScreenShare }); } catch (e) { this._cameraCap(false); raw.stop(); throw e; }
    diag("share-timing", { pickerMs: Math.round(tPicked - tClick), publishMs: Math.round(performance.now() - tPicked), w: set.width, h: set.height, surface: set.displaySurface || "" });
    this.room._ramp("send", Track.Source.ScreenShare, () => t.sender.getStats(), "outbound-rtp", "framesEncoded");
  }
  // While sharing, the camera drops to a thumbnail's bitrate so the screen gets the bandwidth at once (otherwise the screen
  // starts on the camera's leftovers, ~260 kbps and blurry, and takes ~10 s to sharpen). Back to normal when sharing stops.
  async _cameraCap(on) {
    const cam = this.pubs.get(Track.Source.Camera);
    if (!cam?.sender) return;
    try {
      const p = cam.sender.getParameters();
      if (!p.encodings?.length) return;
      p.encodings[0].maxBitrate = on ? 300_000 : this.room.opts.publishDefaults?.videoEncoding?.maxBitrate || 1.8e6;
      // and half the size: the camera is a thumbnail next to the screen, and the laptop has the screen to encode as well
      p.encodings[0].scaleResolutionDownBy = on || cam._perf ? 2 : 1;
      await cam.sender.setParameters(p);
    } catch (e) { diag("error", { msg: `camera cap: ${String(e?.message || e).slice(0, 120)}` }); }
  }
  async _unpublish(t) {
    if (t.source === Track.Source.ScreenShare) this._cameraCap(false);
    this.pubs.delete(t.source);
    await this.room._unpublish(t);
    t.stop();
    this.room.emit(RoomEvent.LocalTrackUnpublished, t);
  }
  async sendText(text, { topic } = {}) { this.room._send({ t: "text", topic, text }); return {}; }
  async setAttributes(attrs) { Object.assign(this.attributes, attrs); this.room._send({ t: "attrs", attrs }); }
}

export class Room extends Emitter {
  constructor(opts = {}) {
    super();
    this.opts = opts; this.state = "disconnected"; this.serverInfo = {};
    this.localParticipant = new LocalParticipant(this);
    this.remoteParticipants = new Map();
    this.textHandlers = {}; this.pub = null; this.sub = null; this.pubQ = queue(); this.subQ = queue();
    this.midMap = new Map(); // receiving mid -> { member, name }
    this.speakers = ""; this.timers = [];
  }
  registerTextStreamHandler(topic, fn) { this.textHandlers[topic] = fn; }

  // room: the room name; name: your display name; key: the room key (the Worker's ROOM_KEY secret)
  async connect({ room = "main", name = "", key = "" } = {}) {
    ROOM = room; AUTH = {};
    const j = await api("join", { name }, { "x-room-key": key });
    AUTH = { member: j.memberId, token: j.token };
    this.member = j.memberId; this.localParticipant.identity = j.memberId; this.localParticipant.name = j.name;
    this.serverInfo = { region: `cloudflare ${j.colo || ""}`.trim() };
    const ice = j.iceServers || [{ urls: "stun:stun.cloudflare.com:3478" }];
    this.ice = ice;
    this.pub = new RTCPeerConnection({ iceServers: ice, bundlePolicy: "max-bundle" });
    this._watch("pub", this.pub);
    // The receiving session is opened at the first subscribe, not here: an SFU session whose PeerConnection never
    // connects goes stale ("Session appears to be disconnected"), so whoever waited alone could never receive.
    // The sending session and the room socket don't depend on each other: set both up at once (one round trip less).
    const [pubSession] = await Promise.all([api("session", { kind: "pub" }), this._openSocket()]);
    this.pubSession = pubSession.sessionId;
    this.state = "connected";
    this.timers.push(setInterval(() => this._tick(), 500), setInterval(() => this._send({ t: "ping" }), 15000));
    addEventListener("pagehide", () => this._leaveBeacon());
  }

  async disconnect() {
    if (this.state === "disconnected") return;
    this.state = "disconnected";
    this.timers.forEach(clearInterval);
    try { this.ws?.close(1000); } catch { /* closed */ }
    await api("leave").catch(() => {});
    this.pub?.close(); this.sub?.close();
    // stop every capture we own, or Chrome keeps showing "sharing your screen" after the call (the page stops its camera and mic too)
    for (const t of this.localParticipant.pubs.values()) { try { t.stop(); } catch { /* already stopped */ } }
    this.localParticipant.pubs.clear();
    this.emit(RoomEvent.Disconnected, "client");
  }
  _leaveBeacon() { if (this.state === "connected") navigator.sendBeacon?.(`api/rt/${ROOM}/leave`, new Blob([JSON.stringify(AUTH)], { type: "application/json" })); }

  async switchActiveDevice(kind, deviceId) {
    if (kind === "audiooutput") {
      Room._sink = deviceId;
      await Promise.all([...document.querySelectorAll("audio")].map((a) => a.setSinkId?.(deviceId).catch(() => {})));
      return true;
    }
    const t = this.localParticipant.pubs.get(kind === "audioinput" ? Track.Source.Microphone : Track.Source.Camera);
    if (t) await t.restartTrack({ ...t.constraints, deviceId });
    return true;
  }

  // ---------- the room's socket ----------
  _openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}${location.pathname.replace(/[^/]*$/, "")}api/rt/${ROOM}/ws?${new URLSearchParams(AUTH)}`);
      let first = true;
      ws.onmessage = (e) => { const m = JSON.parse(e.data); this._message(m); if (first && m.t === "state") { first = false; resolve(); } };
      ws.onerror = () => { if (first) reject(new Error("Couldn't reach the call room")); };
      ws.onclose = () => { if (this.state === "connected") this._socketLost(); };
      this.ws = ws;
    });
  }
  async _socketLost() {
    diag("socket-lost");
    this.emit(RoomEvent.Reconnecting);
    for (let i = 0; i < 8 && this.state === "connected"; i++) {
      await sleep(1000 * Math.min(2 ** i, 8));
      try { await this._openSocket(); this.emit(RoomEvent.Reconnected); return; } catch { /* retry */ }
    }
    if (this.state === "connected") { this.state = "disconnected"; this.emit(RoomEvent.Disconnected, "lost"); }
  }
  _send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  _muted(track, muted) { if (this.localParticipant.pubs.get(track.source) === track) this._send({ t: "mute", name: track.source, muted }); }
  _message(m) {
    if (m.t === "state") this._state(m.members || []);
    if (m.rec) { this.recording = m.rec; this.emit("recording", m.rec); } // the room's recording state (when recording is on)
    if (m.t === "text") this.textHandlers[m.topic]?.({ readAll: async () => m.text }, { identity: m.from });
  }

  // room state -> participants, publications, subscriptions, mute and attribute events
  _state(members) {
    const seen = new Set(), wants = [];
    for (const m of members) {
      if (m.id === this.member) continue;
      seen.add(m.id);
      let p = this.remoteParticipants.get(m.id);
      // people already in the call when you join are just there (no "connected" event, so no second join chime)
      if (!p) { p = new RemoteParticipant(m); this.remoteParticipants.set(m.id, p); if (this._synced) this.emit(RoomEvent.ParticipantConnected, p); }
      const changed = {};
      for (const [k, v] of Object.entries(m.attrs || {})) if (p.attributes[k] !== v) changed[k] = v;
      if (Object.keys(changed).length) { Object.assign(p.attributes, changed); this.emit(RoomEvent.ParticipantAttributesChanged, changed, p); }
      for (const name of m.tracks) {
        let pub = p.trackPublications.get(name);
        if (!pub) { pub = new Publication(name, kindOf(name)); p.trackPublications.set(name, pub); wants.push({ member: m.id, name }); }
        const muted = !!(m.muted || {})[name];
        if (pub.isMuted !== muted) { pub.isMuted = muted; this.emit(muted ? RoomEvent.TrackMuted : RoomEvent.TrackUnmuted, pub, p); }
      }
      for (const [name, pub] of [...p.trackPublications]) if (!m.tracks.includes(name)) this._dropPub(p, name, pub);
    }
    for (const [id, p] of [...this.remoteParticipants]) {
      if (seen.has(id)) continue;
      for (const [name, pub] of [...p.trackPublications]) this._dropPub(p, name, pub);
      this.remoteParticipants.delete(id);
      this.emit(RoomEvent.ParticipantDisconnected, p);
    }
    this._synced = true;
    if (wants.length) this._subscribe(wants);
  }
  _dropPub(p, name, pub) {
    p.trackPublications.delete(name);
    if (pub.track) this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p);
    if (pub.mid) { this.midMap.delete(pub.mid); this._closeSub([pub.mid]); }
  }

  // ---------- media negotiation ----------
  _publish(track) {
    return this.pubQ(async () => {
      const isVideo = track.kind === "video", screen = track.source === Track.Source.ScreenShare;
      const enc = isVideo ? { maxBitrate: screen ? this.opts.publishDefaults?.screenShareEncoding?.maxBitrate || 3e6 : this.opts.publishDefaults?.videoEncoding?.maxBitrate || 1.8e6,
        maxFramerate: screen ? 15 : this.opts.publishDefaults?.videoEncoding?.maxFramerate || 30, ...(screen ? { priority: "high", networkPriority: "high" } : {}) } : { maxBitrate: this.opts.publishDefaults?.audioPreset?.maxBitrate || 48000 };
      const tr = this.pub.addTransceiver(track.mediaStreamTrack, { direction: "sendonly", sendEncodings: [enc] });
      if (isVideo && RTCRtpSender.getCapabilities) { // the page's codec first, then VP9/VP8, the rest as fallbacks
        const codecs = RTCRtpSender.getCapabilities("video")?.codecs || [];
        const want = `video/${(screen ? "vp9" : this.opts.publishDefaults?.videoCodec || "vp9").toUpperCase()}`;
        // H.264: the widely decodable profile first (constrained baseline, packetization-mode 1), like other browsers expect
        const h264 = (c) => (/42e01f/i.test(c.sdpFmtpLine || "") && /packetization-mode=1/.test(c.sdpFmtpLine || "") ? 0 : 0.5);
        const rank = (c) => (c.mimeType === want ? (want === "video/H264" ? h264(c) : 0) : c.mimeType === "video/VP9" ? 1 : c.mimeType === "video/VP8" ? 2 : 3);
        try { tr.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b))); } catch { /* browser keeps its order */ }
      }
      track.sender = tr.sender; track.transceiver = tr;
      await this.pub.setLocalDescription(await this.pub.createOffer());
      const r = await api("publish", { sdp: this.pub.localDescription.sdp, tracks: [{ mid: tr.mid, name: track.source }] });
      await this.pub.setRemoteDescription({ type: "answer", sdp: r.sdp });
      diag("published", { name: track.source, mid: tr.mid, codec: (r.sdp.match(/a=rtpmap:\d+ (VP9|VP8|H264|AV1|opus)/i) || [])[1] || "" });
      if (isVideo) this._firstFrame("first-sent", track.source, () => tr.sender.getStats(), "outbound-rtp", "framesEncoded");
      if (track.isMuted) this._muted(track, true);
    });
  }
  _unpublish(track) {
    return this.pubQ(async () => {
      const mid = track.transceiver?.mid;
      track.transceiver?.stop();
      await this.pub.setLocalDescription(await this.pub.createOffer());
      const r = await api("unpublish", { sdp: this.pub.localDescription.sdp, mids: [mid] });
      if (r.sdp) await this.pub.setRemoteDescription({ type: "answer", sdp: r.sdp });
    });
  }
  _watch(name, pc) {
    pc.onconnectionstatechange = () => { diag("pc", { pc: name, state: pc.connectionState }); this._connState(pc); };
    pc.oniceconnectionstatechange = () => diag("ice", { pc: name, state: pc.iceConnectionState });
  }
  // a new receiving PeerConnection + SFU session (the old one, if any, is dropped with everything it carried)
  async _newSub() {
    const old = this.sub;
    if (old) { old.onconnectionstatechange = old.oniceconnectionstatechange = old.ontrack = null; old.close(); }
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: "max-bundle" });
    pc.ontrack = (e) => this._onTrack(e);
    this._watch("sub", pc);
    this.sub = pc; this.midMap.clear();
    this.subSession = (await api("session", { kind: "sub" })).sessionId;
    diag("sub-session", { fresh: !!old });
  }
  _subscribe(wants) {
    return this.subQ(async () => {
      if (!this.sub) await this._newSub();
      for (let attempt = 1; ; attempt++) {
        try { return await this._pull(wants); } catch (e) {
          if (attempt >= 3 || this.state !== "connected") throw e;
          diag("retry", { attempt, msg: String(e?.message || e).slice(0, 160) });
          // start over on a fresh receiving session and pull every remote track again
          for (const p of this.remoteParticipants.values()) for (const pub of p.trackPublications.values()) {
            if (pub.track) { this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p); pub.track = null; }
            pub.mid = "";
          }
          await new Promise((res) => setTimeout(res, 1000 * attempt));
          await this._newSub();
          wants = [...this.remoteParticipants].flatMap(([member, p]) => [...p.trackPublications.keys()].map((name) => ({ member, name })));
          if (!wants.length) return;
        }
      }
    });
  }
  async _pull(wants) {
    {
      const r = await api("subscribe", { wants });
      diag("subscribed", { wants: wants.map((w) => w.name), tracks: (r.tracks || []).map((t) => `${t.name}:${t.mid || "-"}${t.error ? `!${t.error}` : ""}`), offer: !!r.sdp });
      const missing = [];
      for (const t of r.tracks || []) {
        if (t.error || !t.mid) { missing.push({ member: t.member, name: t.name }); continue; }
        this._tries?.delete(`${t.member}/${t.name}`);
        this.midMap.set(t.mid, { member: t.member, name: t.name });
        const pub = this.remoteParticipants.get(t.member)?.trackPublications.get(t.name);
        if (pub) pub.mid = t.mid;
      }
      if (missing.length) this._retryMissing(missing);
      if (!r.sdp) return;
      await this.sub.setRemoteDescription({ type: "offer", sdp: r.sdp });
      await this.sub.setLocalDescription(await this.sub.createAnswer());
      await api("answer", { sdp: this.sub.localDescription.sdp });
    }
  }
  // A track pulled the moment it is published can come back "not_found_track_error" / "empty_track_error" (the SFU hasn't
  // seen its media yet). Ask again after 0.3, 0.6, 1.2, 2.4, 4.8, 9.6 s while the publication is still there and still has
  // nothing; the count starts over once it works (a second screen share mustn't inherit the first one's waits).
  _retryMissing(missing) {
    this._tries = this._tries || new Map();
    for (const w of missing) {
      const key = `${w.member}/${w.name}`, n = (this._tries.get(key) || 0) + 1;
      if (n > 6) { diag("gave-up", { track: w.name }); this._tries.delete(key); continue; }
      this._tries.set(key, n);
      setTimeout(() => {
        const pub = this.remoteParticipants.get(w.member)?.trackPublications.get(w.name);
        if (this.state !== "connected" || !pub || pub.mid) return;
        diag("retry-track", { track: w.name, attempt: n });
        this._subscribe([w]).catch(() => {});
      }, 300 * 2 ** (n - 1));
    }
  }
  _closeSub(mids) {
    return this.subQ(async () => {
      if (!this.sub) return;
      const r = await api("unsubscribe", { mids }).catch(() => ({}));
      if (!r.sdp) return;
      await this.sub.setRemoteDescription({ type: "offer", sdp: r.sdp });
      await this.sub.setLocalDescription(await this.sub.createAnswer());
      await api("answer", { sdp: this.sub.localDescription.sdp });
    });
  }
  _onTrack(e) {
    const where = this.midMap.get(e.transceiver.mid);
    diag("track", { mid: e.transceiver.mid, kind: e.track.kind, mapped: where ? `${where.name}` : "no" });
    if (!where) return;
    const p = this.remoteParticipants.get(where.member), pub = p?.trackPublications.get(where.name);
    if (!pub) return;
    pub.track = new RemoteTrack(e.track.kind, where.name, e.track, e.receiver);
    this.emit(RoomEvent.TrackSubscribed, pub.track, pub, p);
    if (e.track.kind === "video") this._firstFrame("first-frame", where.name, () => e.receiver.getStats(), "inbound-rtp", "framesDecoded");
    if (where.name === Track.Source.ScreenShare) this._ramp("recv", where.name, () => e.receiver.getStats(), "inbound-rtp", "framesDecoded");
  }
  // how long until a video really shows (receiver: first decoded frame) or really leaves (sender: first encoded frame)
  _firstFrame(type, name, stats, kind, field) {
    const t0 = performance.now();
    const poll = async () => {
      if (this.state !== "connected" || performance.now() - t0 > 60000) return;
      let n = 0;
      (await stats().catch(() => new Map())).forEach((x) => { if (x.type === kind && x[field]) n = x[field]; });
      if (n > 0) diag(type, { track: name, ms: Math.round(performance.now() - t0) });
      else setTimeout(poll, 200);
    };
    setTimeout(poll, 200);
  }
  // the first 15 s of a video, second by second: size, frames, kbps and average QP (lower = sharper), to see how long a
  // shared screen takes to become readable (dir: send on the sharer, recv on the viewer)
  _ramp(dir, name, stats, kind, framesField) {
    let last = null, n = 0;
    const tick = async () => {
      if (this.state !== "connected" || n++ >= 15) return;
      let x = null;
      (await stats().catch(() => new Map())).forEach((v) => { if (v.type === kind) x = v; });
      if (x) {
        const f = x[framesField] || 0, b = x.bytesSent ?? x.bytesReceived ?? 0, q = x.qpSum || 0;
        if (last) {
          const df = f - last.f;
          diag("share-ramp", { dir, s: n - 1, w: x.frameWidth || 0, h: x.frameHeight || 0, frames: df, kbps: Math.round(((b - last.b) * 8) / 1000),
            qp: df > 0 ? Math.round((q - last.q) / df) : null, limit: x.qualityLimitationReason || undefined });
        }
        last = { f, b, q };
      }
      setTimeout(tick, 1000);
    };
    tick();
  }
  _connState(pc) {
    const s = pc.connectionState;
    if (s === "disconnected") { this._wasDown = true; this.emit(RoomEvent.Reconnecting); }
    if (s === "connected" && this._wasDown) { this._wasDown = false; this.emit(RoomEvent.Reconnected); }
    if (s === "failed" && this.state === "connected") { this.state = "disconnected"; this.emit(RoomEvent.Disconnected, "media failed"); }
  }

  // ---------- every 500 ms: who is speaking; every 2 s: bitrates and the CPU safety net (one getStats per connection) ----------
  // Was ~8 getStats calls every 500 ms (one per sender/receiver; each gathers the whole connection's report on the page's main
  // thread, which the blur also uses). Now: speaking from the cheap synchronization sources and one sender report per tick.
  async _tick() {
    if (this.state !== "connected") return;
    this._q = (this._q || 0) + 1;
    const speaking = [];
    const mic = this.localParticipant.pubs.get(Track.Source.Microphone);
    const full = this._q % 4 === 0, now = performance.now();
    const pubStats = this.pub && ((mic?.sender && !mic.isMuted) || full) ? await this.pub.getStats().catch(() => new Map()) : new Map();
    if (mic?.sender && !mic.isMuted) pubStats.forEach((s) => { if (s.type === "media-source" && s.kind === "audio" && s.audioLevel > 0.03) speaking.push(this.localParticipant); });
    for (const p of this.remoteParticipants.values()) {
      const a = p.trackPublications.get(Track.Source.Microphone);
      const lvl = a?.track && !a.isMuted ? a.track.receiver?.getSynchronizationSources?.()[0]?.audioLevel : 0;
      if (lvl > 0.03) speaking.push(p);
    }
    const key = speaking.map((p) => p.identity).sort().join(",");
    if (key !== this.speakers) { this.speakers = key; this.emit(RoomEvent.ActiveSpeakersChanged, speaking); }
    if (!full) return;
    const rate = (t, bytes) => { if (t._bytes && bytes != null) t.currentBitrate = ((bytes - t._bytes.b) * 8000) / (now - t._bytes.at); if (bytes != null) t._bytes = { b: bytes, at: now }; };
    const out = {}; pubStats.forEach((s) => { if (s.type === "outbound-rtp" && s.mid != null) (out[s.mid] ||= []).push(s); });
    for (const t of this.localParticipant.pubs.values()) {
      const st = out[t.transceiver?.mid] || [];
      rate(t, st.reduce((n, x) => n + (x.bytesSent || 0), 0));
      if (t.source === Track.Source.Camera && st.some((x) => x.qualityLimitationReason === "cpu") && !t._cpu) { t._cpu = true; this.localParticipant.emit(ParticipantEvent.LocalTrackCpuConstrained, t); }
    }
    const inb = {};
    if (this.sub) (await this.sub.getStats().catch(() => new Map())).forEach((s) => { if (s.type === "inbound-rtp" && s.mid != null) inb[s.mid] = s; });
    for (const p of this.remoteParticipants.values()) for (const pub of p.trackPublications.values()) {
      if (pub.track && pub.mid) rate(pub.track, inb[pub.mid]?.bytesReceived);
    }
    if (this._q % 20 === 0) { // every 10 s: round trip and loss of the receiving connection, as a quality level
      let rtt = 0;
      for (const pc of [this.sub, this.pub].filter(Boolean)) {
        if (rtt) break;
        const st = await pc.getStats().catch(() => new Map()), pairs = {};
        let sel = "";
        st.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) sel = s.selectedCandidatePairId; if (s.type === "candidate-pair") pairs[s.id] = s; });
        const pair = pairs[sel] || Object.values(pairs).find((p) => p.state === "succeeded" && p.nominated);
        if (pair?.currentRoundTripTime) rtt = pair.currentRoundTripTime * 1000;
      }
      const q = !rtt ? "unknown" : rtt < 150 ? "excellent" : rtt < 300 ? "good" : "poor";
      if (q !== this._quality) { this._quality = q; this.emit(RoomEvent.ConnectionQualityChanged, q, this.localParticipant); }
      this.serverInfo.rttMs = Math.round(rtt);
    }
  }
}
