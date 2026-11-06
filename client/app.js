// The call page: lobby (camera check, name, devices), the call (video tiles, controls, chat, reactions, raised hands, screen
// sharing), and the effects (background blur + touch-up, off the main thread). Talks to the room through sfu-client.js.
import { Room, RoomEvent, ParticipantEvent, Track, createLocalVideoTrack, createLocalAudioTrack, VideoPresets } from "./sfu-client.js";
import { createLiveKitBlurProcessor } from "gregblur/livekit"; // gregblur's processor adapter (the name is the library's)
import { isBlurSupported } from "gregblur/detect";
import { createOffThreadBlur } from "./effects-offthread.js";

const T = {
  title: "Video call", joinNow: "Join call", joining: "Joining…", waiting: "Waiting for others to join",
  readyAlone: "Nobody else is here yet", readyWith: (n) => (n === 1 ? "1 person is in the call" : `${n} people are in the call`),
  camOff: "Camera off", me: "You", other: "Guest",
  micOn: "Mute", micOff: "Unmute", camOnTip: "Stop video", camOffTip: "Start video", share: "Share", stopShare: "Stop sharing",
  leave: "Leave", react: "React", raise: "Hand", lower: "Lower", chat: "Chat", more: "More",
  left: "You left the call", rejoin: "Join again", noBlur: "Background blur isn't available in this browser.",
  denied: "Camera or microphone access is blocked. Allow it for this site in your browser settings, then reload.",
  noDevice: "A camera or microphone couldn't start. Check it's connected and not in use by another app, then reload.",
  needName: "Please enter your name.", needKey: "Please enter the room key.",
  presenting: (n) => `${n} is sharing`, raised: (n) => `${n} raised a hand`, handLabel: "Hand raised",
  blurOn: "Background blur: on", blurOff: "Background blur: off", touchOn: "Touch-up: on", touchOff: "Touch-up: off",
  pip: "Floating window", fullPage: "Full screen", exitFullPage: "Exit full screen", devices: "Devices",
  youPresenting: "You're sharing this tab", presentingScreen: "You're sharing your screen. Others can see it.",
  scrollHint: "Scroll here to scroll the shared tab", clickToScroll: "Click to control the shared tab from here",
  zoomIn: "Zoom in", zoomOut: "Zoom out", backToCall: "Back to the call", stopShort: "Stop",
  pin: "Make this video large", unpin: "Back to the normal layout", full: "Full screen", exitFull: "Exit full screen",
  lost: "Connection lost. Reconnecting…", back: "Reconnected.", recording: "Recording", recordingOff: "Recording paused",
  sysDefault: "System default", noDevices: "None found",
};
const $ = (s) => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

// the room comes from ?room=<name> (default "main"); the key from #key=<ROOM_KEY> (a hash never reaches the server), kept for the
// tab in sessionStorage and removed from the address bar
const ROOM = /^[a-z0-9][a-z0-9-]{0,39}$/.test(qs.get("room") || "") ? qs.get("room") : "main";
const hashKey = new URLSearchParams(location.hash.slice(1)).get("key");
if (hashKey) { try { sessionStorage.setItem(`key-${ROOM}`, hashKey); } catch { /* private mode */ } history.replaceState(null, "", location.pathname + location.search); }
const savedKey = () => { try { return sessionStorage.getItem(`key-${ROOM}`) || ""; } catch { return ""; } };

let room = null, cam = null, mic = null, blurLevel = 0, micWanted = true, camWanted = true, info = { recording: false };

// Phones and tablets get a lighter call: blur off unless turned on there, 360p at 24 fps. ?lite=1 / ?lite=0 force it.
const LITE = qs.has("lite") ? qs.get("lite") !== "0" : !!(navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))); // iPads report "Macintosh"
const BLUR_KEY = LITE ? "call-blur-phone" : "call-blur";
let touchOn = !LITE && qs.get("touchup") !== "0" && (qs.get("touchup") === "1" || store.get("call-touchup") !== "off");
const BLUR_OPTS = { blurRadius: 42, initialEnabled: false, segmentationModel: "selfie-multiclass-256" };
const blur = isBlurSupported().supported
  ? (qs.get("offthread") === "0" ? createLiveKitBlurProcessor(BLUR_OPTS)
    : createOffThreadBlur({ workerUrl: new URL("effects-worker.js", location.href), model: BLUR_OPTS.segmentationModel, options: { blurRadius: BLUR_OPTS.blurRadius, initialEnabled: false },
      fallback: () => createLiveKitBlurProcessor(BLUR_OPTS), touch: touchOn, onLog: (type, data) => console.debug(type, data) }))
  : null;
let blurAttached = false;

// ---------- icons: simple line drawings, made for this project ----------
const P = {
  mic: '<path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  cam: '<rect x="3" y="7" width="12" height="10" rx="2.5"/><path d="M15 11l6-3v8l-6-3"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4M12 13V7.5M9.5 10l2.5-2.5 2.5 2.5"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4 4 0 0 0 7 0"/><path d="M9.5 9.5h.01M14.5 9.5h.01" stroke-width="2.6"/>',
  hand: '<path d="M8 12V7a1.5 1.5 0 0 1 3 0v4M11 10.5V5a1.5 1.5 0 0 1 3 0v5.5M14 10.5V7a1.5 1.5 0 0 1 3 0v6.5a6.5 6.5 0 0 1-6.5 6.5h-.3A5.2 5.2 0 0 1 5 14.8V12a1.5 1.5 0 0 1 3 0v1"/>',
  chat: '<path d="M4 5.5h16v10.5H9.5L5 19.5V16H4z"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3"/>',
  leave: '<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M15 12H4M8 8l-4 4 4 4"/>',
  blur: '<circle cx="12" cy="9" r="3"/><path d="M6.5 19a5.5 5.5 0 0 1 11 0"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01M20.5 6h.01M20.5 12h.01M20.5 18h.01" stroke-width="2.6"/>',
  sparkle: '<path d="M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z"/><path d="M18.5 16v4M16.5 18h4"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/>',
  full: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/>',
  stop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4M9.5 7.5l5 5M14.5 7.5l-5 5"/>',
  back: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 16V9M9 11.5l3-3 3 3"/>',
};
const slash = '<path d="M4 4l16 16"/>';
const icon = (k, off = false) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[k]}${off ? slash : ""}</svg>`;

// ---------- sound cues: a rising two-note tone when someone joins, falling when they leave ----------
let audio = null;
function tone(notes, gap = 0.16, type = "sine", vol = 0.16) {
  try {
    audio ||= new AudioContext();
    const t0 = audio.currentTime + 0.02;
    notes.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain(), t = t0 + i * gap;
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.5);
    });
  } catch { /* no audio output */ }
}
const chime = (up) => tone(up ? [523.25, 783.99] : [698.46, 466.16]);
const ping = () => tone([1174.66], 0, "sine", 0.1);
const handCue = () => tone([739.99, 987.77], 0.11, "triangle", 0.1);

function say(text, ms = 5000) {
  const m = $("#toast"); m.textContent = text; m.hidden = false;
  clearTimeout(say.t); if (ms) say.t = setTimeout(() => { m.hidden = true; }, ms);
}

// ---------- controls ----------
function setBtn(id, on, iconKey, labelOn, labelOff, offIsAlert = true) {
  const b = $(id); if (!b) return;
  b.querySelector(".ic")?.remove();
  b.insertAdjacentHTML("afterbegin", icon(iconKey, offIsAlert && !on));
  const label = on ? labelOn : labelOff, l = b.querySelector(".lbl");
  if (l) l.textContent = label;
  b.classList.toggle("alert", offIsAlert && !on); b.classList.toggle("active", !offIsAlert && on);
  b.title = label; b.setAttribute("aria-label", label); b.setAttribute("aria-pressed", String(offIsAlert ? !on : on));
}
function setButtons() {
  setBtn("#p-mic", micWanted, "mic", T.micOn, T.micOff); setBtn("#b-mic", micWanted, "mic", T.micOn, T.micOff);
  setBtn("#p-cam", camWanted, "cam", T.camOnTip, T.camOffTip); setBtn("#b-cam", camWanted, "cam", T.camOnTip, T.camOffTip);
  setBtn("#p-blur", blurLevel > 0, "blur", T.blurOn, T.blurOff, false);
  $("#p-blur").hidden = !blur;
  const sharing = !!room?.localParticipant.isScreenShareEnabled;
  setBtn("#b-share", sharing, sharing ? "stop" : "screen", T.stopShare, T.share, false);
  $("#preview-off").hidden = camWanted; $("#preview").hidden = !camWanted;
  $("#me-avatar").hidden = camWanted; $("#me video")?.toggleAttribute("hidden", !camWanted);
  if (room) { myScreenTile(); pipRender(); }
}

// ---------- lobby ----------
async function preview() {
  // each device on its own; a remembered one that isn't connected any more falls back to the default
  const get = async (make, opts, kind) => {
    try { return await make({ ...opts, deviceId: chosen(kind) }); }
    catch (e) { if (e?.name === "NotAllowedError" || !chosen(kind)) throw e; return make(opts); }
  };
  const [v, a] = await Promise.allSettled([get(createLocalVideoTrack, VIDEO_OPTS, "videoinput"), get(createLocalAudioTrack, AUDIO_OPTS, "audioinput")]);
  cam = v.status === "fulfilled" ? v.value : null; mic = a.status === "fulfilled" ? a.value : null;
  if (!cam) camWanted = false;
  if (!mic) micWanted = false;
  if (!cam || !mic) { setButtons(); say((v.reason || a.reason)?.name === "NotAllowedError" ? T.denied : T.noDevice, 0); }
  if (cam) { cam.attach($("#preview")); camCodec = hardwareCodec(); }
  micMeter();
  loadDevices();
  setButtons();
  const saved = store.get(BLUR_KEY);
  setBlur(LITE ? (saved === "on" ? 1 : 0) : (saved === "off" ? 0 : 1), false);
}

async function setBlur(level, save = true) {
  if (!blur || !cam) return;
  if (!level && !blurAttached && !(touchOn && blur?.setTouch)) { blurLevel = 0; if (save) store.set(BLUR_KEY, "off"); setButtons(); return; } // never load the model just to keep it off
  try {
    if (!blurAttached) { await cam.setProcessor(blur); blurAttached = true; }
    blur.setEnabled(!!level);
    blurLevel = level; if (save) store.set(BLUR_KEY, level ? "on" : "off");
  } catch (e) { console.warn("blur", e); blurLevel = 0; say(T.noBlur); }
  setButtons();
}
async function setTouch(on) {
  touchOn = on; store.set("call-touchup", on ? "on" : "off");
  if (on && !blurAttached && cam && blur) { try { await cam.setProcessor(blur); blurAttached = true; blur.setEnabled(!!blurLevel); } catch (e) { console.warn("touch-up", e); } }
  blur?.setTouch?.(on);
}
async function toggleMic() { micWanted = !micWanted; if (mic) await (micWanted ? mic.unmute() : mic.mute()); setButtons(); }
async function toggleCam() { camWanted = !camWanted; if (cam) await (camWanted ? cam.unmute() : cam.mute()); setButtons(); }

// ---------- tiles ----------
const TOOLS = () => `<div class="tools"><button data-act="pin">${icon("pin")}</button><button data-act="full">${icon("full")}</button></div>`;
const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
function fullScreen(el) {
  if (isFull()) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  const go = el.requestFullscreen || el.webkitRequestFullscreen;
  if (go) return go.call(el).catch?.(() => {});
  el.querySelector("video")?.webkitEnterFullscreen?.(); // iPhone: only a video element can go full screen
}
function pinToggle(tile) { $("#stage").classList.toggle("me-big", tile.id === "me" && !$("#stage").classList.contains("me-big")); toolTips(); }
function toolTips() {
  const big = $("#stage").classList.contains("me-big");
  document.querySelectorAll(".tools [data-act]").forEach((b) => {
    const mine = b.closest(".tile")?.id === "me";
    const tip = b.dataset.act === "full" ? (isFull() ? T.exitFull : T.full) : ((mine && big) || (!mine && !big) ? T.unpin : T.pin);
    b.title = tip; b.setAttribute("aria-label", tip);
    if (b.dataset.act === "pin") b.hidden = !mine && !big;
  });
}
document.addEventListener("fullscreenchange", toolTips);

const COLORS = ["#0f766e", "#7c3aed", "#b45309", "#be185d", "#1d4ed8", "#15803d"];
const colorOf = (id) => COLORS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length];
function remoteTile(p, screen) {
  const key = `${p.identity}${screen ? ":screen" : ""}`;
  let t = document.querySelector(`.tile[data-who="${key}"]`);
  if (!t) {
    t = Object.assign(document.createElement("div"), { className: `tile${screen ? " screen" : ""}` });
    t.dataset.who = key;
    t.innerHTML = `<div class="avatar" hidden><span></span></div><span class="name"><span class="muted-ic" hidden>${icon("mic", true)}</span><span class="n"></span></span>${TOOLS()}`;
    t.querySelector(".avatar span").style.background = colorOf(p.identity);
    $("#stage").insertBefore(t, $("#me"));
  }
  const name = p.name || T.other;
  t.querySelector(".n").textContent = screen ? T.presenting(name) : name;
  t.querySelector(".avatar span").textContent = name[0].toUpperCase();
  return t;
}
function refresh() {
  const stage = $("#stage");
  toolTips(); showHands();
  stage.classList.toggle("share", !!stage.querySelector(".tile.screen"));
  $("#waiting").hidden = stage.querySelectorAll(".tile:not(#me):not(.mine)").length > 0;
  for (const p of room?.remoteParticipants.values() || []) {
    const t = stage.querySelector(`.tile[data-who="${p.identity}"]`);
    if (!t) continue;
    const micPub = p.getTrackPublication(Track.Source.Microphone), camPub = p.getTrackPublication(Track.Source.Camera);
    t.querySelector(".muted-ic").hidden = !(micPub?.isMuted ?? true);
    const v = t.querySelector("video");
    const camOn = (camPub && !camPub.isMuted && camPub.track) || (v && v.videoWidth > 0 && !camPub?.isMuted);
    t.querySelector(".avatar").hidden = !!camOn; v?.toggleAttribute("hidden", !camOn);
  }
  $("#count").textContent = String((room?.remoteParticipants.size || 0) + 1);
  pipRender();
}

// ---------- your own share: a shared tab shows live and can be scrolled and zoomed from here (Captured Surface Control,
// Chrome 136+); a whole screen or window shows a note instead (a live copy of a screen would show itself again and again) ----------
function myScreenTile() {
  const t0 = room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
  let tile = $("#myscreen");
  if (!t0) { tile?.remove(); return; }
  if (tile) return;
  const tab = t0.surface === "browser", ctl = t0.controller;
  tile = Object.assign(document.createElement("div"), { id: "myscreen", className: `tile screen mine${tab ? " tab" : ""}` });
  tile.innerHTML = `${tab ? "" : `<div class="present-note">${icon("screen")}<span></span></div>`}
    <div class="present-bar"><span class="pb-t"></span>
      <span class="pb-zoom" hidden><button data-z="-">−</button><span class="pb-lvl"></span><button data-z="+">+</button></span>
      <button class="pb-stop"></button></div><div class="pb-hint" hidden></div>`;
  tile.querySelector(".pb-t").textContent = tab ? T.youPresenting : T.stopShare;
  tile.querySelector(".pb-stop").textContent = T.stopShare;
  tile.querySelector(".pb-stop").onclick = toggleShare;
  if (!tab) { tile.querySelector(".present-note span").textContent = T.presentingScreen; tile.querySelector(".pb-t").textContent = ""; }
  $("#stage").insertBefore(tile, $("#stage").firstChild);
  if (tab) {
    const v = Object.assign(document.createElement("video"), { muted: true, autoplay: true, playsInline: true });
    v.srcObject = new MediaStream([t0.mediaStreamTrack]); v.play?.().catch(() => {});
    tile.prepend(v);
    const hint = tile.querySelector(".pb-hint");
    if (ctl?.forwardWheel) {
      const scroll = () => ctl.forwardWheel(v).then(() => { hint.textContent = T.scrollHint; hint.hidden = false; hint.classList.add("fade"); });
      scroll().catch(() => { hint.textContent = T.clickToScroll; hint.hidden = false; v.addEventListener("click", () => scroll().catch(() => {}), { once: true }); });
    }
    if (ctl?.increaseZoomLevel && ctl.zoomLevel != null) {
      const z = tile.querySelector(".pb-zoom"), lvl = tile.querySelector(".pb-lvl");
      const show = () => { lvl.textContent = `${ctl.zoomLevel}%`; };
      z.hidden = false; show(); ctl.addEventListener("zoomlevelchange", show);
      z.querySelector('[data-z="-"]').title = T.zoomOut; z.querySelector('[data-z="+"]').title = T.zoomIn;
      z.querySelectorAll("[data-z]").forEach((b) => { b.onclick = () => (b.dataset.z === "+" ? ctl.increaseZoomLevel() : ctl.decreaseZoomLevel()).catch(() => {}); });
    }
  }
  refresh();
}

// ---------- faces in a floating window (Document Picture-in-Picture, Chrome 116+): opens by itself when you switch to another
// tab during the call, and from More. It stays on top of other windows and closes when you come back to the call tab. ----------
let pipWin = null;
const pipCSS = `body{margin:0;background:#0b1220;color:#e2e8f0;font:13px/1.3 system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .faces{flex:1;display:grid;gap:6px;padding:6px;grid-auto-rows:1fr;min-height:0;position:relative}
  .face{position:relative;background:#1e293b;border-radius:14px;overflow:hidden;min-height:0;display:flex;align-items:center;justify-content:center}
  .face video{width:100%;height:100%;object-fit:cover}.face.me video{transform:scaleX(-1)}
  .face .nm{position:absolute;left:8px;bottom:6px;font-size:12px;background:#0b1220cc;padding:2px 8px;border-radius:6px}
  .face .ini{width:64px;height:64px;border-radius:16px;background:#0f766e;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:600}
  .faces.two .face.me{position:absolute;left:12px;top:12px;width:36%;aspect-ratio:16/9;z-index:2;box-shadow:0 4px 12px #0009}
  .faces.many{grid-template-columns:1fr 1fr}
  .ctl{display:flex;gap:8px;justify-content:center;padding:8px}
  .ctl button{border:0;border-radius:12px;height:42px;min-width:42px;padding:0 12px;background:#1e293b;color:#e2e8f0;cursor:pointer;display:flex;align-items:center;gap:6px;font:inherit;font-weight:600}
  .ctl .ic{width:20px;height:20px}.ctl button.alert{background:#e11d48}.ctl button.stop{background:#2dd4bf;color:#042f2e}`;
async function openFaces(auto = false) {
  if (!("documentPictureInPicture" in window)) {
    const v = document.querySelector(".tile:not(#me):not(.screen) video") || $("#me video");
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await v?.requestPictureInPicture(); } catch (e) { say(String(e.message || e)); }
    return;
  }
  if (pipWin) { if (!auto) pipWin.close(); return; }
  try { pipWin = await documentPictureInPicture.requestWindow({ width: 420, height: 560 }); }
  catch (e) { pipWin = null; if (!auto) say(String(e.message || e)); return; }
  const d = pipWin.document;
  d.title = T.title;
  d.head.append(Object.assign(d.createElement("style"), { textContent: pipCSS }));
  d.body.innerHTML = `<div class="faces"></div><div class="ctl"></div>`;
  pipWin.addEventListener("pagehide", () => { pipWin = null; });
  pipRender();
}
function pipFace(d, key, name, track, mine) {
  let f = d.querySelector(`.face[data-k="${key}"]`);
  if (!f) {
    f = d.createElement("div"); f.className = `face${mine ? " me" : ""}`; f.dataset.k = key;
    f.innerHTML = `<div class="ini"></div><span class="nm"></span>`;
    d.querySelector(".faces").append(f);
  }
  f.querySelector(".nm").textContent = name; f.querySelector(".ini").textContent = (name || "?")[0].toUpperCase();
  let v = f.querySelector("video");
  if (track) {
    if (!v) { v = d.createElement("video"); v.muted = true; v.autoplay = true; v.playsInline = true; f.prepend(v); }
    if (v.srcObject?.getVideoTracks()[0] !== track) { v.srcObject = new MediaStream([track]); v.play?.().catch(() => {}); }
  } else v?.remove();
  f.querySelector(".ini").hidden = !!track;
}
function pipRender() {
  if (!pipWin || !room) return;
  const d = pipWin.document, keep = new Set(["me"]);
  for (const p of room.remoteParticipants.values()) {
    const pub = p.getTrackPublication(Track.Source.Camera), tr = pub && !pub.isMuted ? pub.track?.mediaStreamTrack : null;
    keep.add(p.identity); pipFace(d, p.identity, p.name || T.other, tr, false);
  }
  pipFace(d, "me", T.me, camWanted ? cam?.mediaStreamTrack : null, true);
  d.querySelectorAll(".face").forEach((f) => { if (!keep.has(f.dataset.k)) f.remove(); });
  const n = room.remoteParticipants.size, faces = d.querySelector(".faces");
  faces.classList.toggle("two", n === 1); faces.classList.toggle("many", n > 1); // two people: you small in a corner; more: equal tiles
  const sharing = !!room.localParticipant.isScreenShareEnabled, ctl = d.querySelector(".ctl");
  ctl.innerHTML = `<button data-a="mic" class="${micWanted ? "" : "alert"}">${icon("mic", !micWanted)}</button>
    <button data-a="cam" class="${camWanted ? "" : "alert"}">${icon("cam", !camWanted)}</button>
    ${sharing ? `<button data-a="share" class="stop">${icon("stop")}<span></span></button>` : ""}<button data-a="back">${icon("back")}</button>`;
  if (sharing) ctl.querySelector(".stop span").textContent = T.stopShort;
  const tips = { mic: micWanted ? T.micOn : T.micOff, cam: camWanted ? T.camOnTip : T.camOffTip, share: T.stopShare, back: T.backToCall };
  ctl.querySelectorAll("[data-a]").forEach((b) => {
    b.title = tips[b.dataset.a];
    b.onclick = () => { const a = b.dataset.a; if (a === "mic") toggleMic(); else if (a === "cam") toggleCam(); else if (a === "share") toggleShare(); else { window.focus(); pipWin?.close(); } };
  });
}
function pipAuto(on) { try { navigator.mediaSession?.setActionHandler("enterpictureinpicture", on ? () => openFaces(true) : null); } catch { /* not supported */ } }

function attachRemote(track, pub, p) {
  if (track.kind === Track.Kind.Audio) { document.body.append(track.attach()); refresh(); return; }
  const t = remoteTile(p, pub.source === Track.Source.ScreenShare);
  t.querySelector("video")?.remove();
  const v = track.attach();
  for (const ev of ["loadeddata", "resize", "playing"]) v.addEventListener(ev, refresh);
  t.prepend(v);
  refresh();
}
function detachRemote(track, pub, p) {
  track.detach().forEach((el) => el.remove());
  if (pub.source === Track.Source.ScreenShare) document.querySelector(`.tile[data-who="${p.identity}:screen"]`)?.remove();
  refresh();
}

// ---------- joining ----------
async function join() {
  const name = $("#name").value.trim(), key = $("#key").value.trim() || savedKey();
  if (!name) { say(T.needName); $("#name").focus(); return; }
  if (!key) { say(T.needKey); $("#key").focus(); return; }
  store.set("call-name", name);
  $("#join").disabled = true; $("#join").textContent = T.joining;
  chime(true); // also unlocks audio playback for the later cues
  room = new Room({
    publishDefaults: {
      videoCodec: LITE ? "vp8" : "vp9",
      videoEncoding: LITE ? { maxBitrate: 600_000, maxFramerate: 24 } : { maxBitrate: 1_800_000, maxFramerate: 30 },
      screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 15 },
      audioPreset: { maxBitrate: 48_000 },
    },
  });
  room.registerTextStreamHandler("chat", async (reader, from) => addMessage(from.identity, await reader.readAll(), false));
  room.registerTextStreamHandler("reaction", async (reader, from) => { const e = await reader.readAll(); if (EMOJIS.includes(e)) floatEmoji(e, nameOf(from.identity)); });
  room.on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
    if (p === room.localParticipant || !("hand" in changed)) return;
    if (changed.hand) { handCue(); say(T.raised(p.name || T.other)); }
    showHands();
  });
  room
    .on(RoomEvent.TrackSubscribed, attachRemote)
    .on(RoomEvent.TrackUnsubscribed, detachRemote)
    .on(RoomEvent.TrackMuted, refresh).on(RoomEvent.TrackUnmuted, refresh)
    .on(RoomEvent.ParticipantConnected, (p) => { chime(true); remoteTile(p, false); refresh(); })
    .on(RoomEvent.ParticipantDisconnected, (p) => { chime(false); document.querySelectorAll(`.tile[data-who^="${p.identity}"]`).forEach((t) => t.remove()); refresh(); })
    .on(RoomEvent.LocalTrackUnpublished, setButtons)
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const ids = new Set(speakers.map((p) => p.identity));
      document.querySelectorAll(".tile").forEach((t) => t.classList.toggle("speaking", ids.has(t.id === "me" ? room.localParticipant.identity : t.dataset.who)));
    })
    .on(RoomEvent.Reconnecting, () => say(T.lost, 0))
    .on(RoomEvent.Reconnected, () => say(T.back))
    .on(RoomEvent.Disconnected, () => left())
    .on("recording", showRecording);
  // the encoder reports it can't keep up: send lighter video instead of stuttering
  room.localParticipant.on(ParticipantEvent.LocalTrackCpuConstrained, (track) => track.prioritizePerformance());
  try {
    await room.connect({ room: ROOM, name, key });
  } catch (e) {
    say(String(e.message || e), 0); $("#join").disabled = false; $("#join").textContent = T.joinNow; room = null; return;
  }
  try { sessionStorage.setItem(`key-${ROOM}`, key); } catch { /* private mode */ }
  for (const p of room.remoteParticipants.values()) remoteTile(p, false);
  if (canPickSpeaker && chosen("audiooutput")) room.switchActiveDevice("audiooutput", chosen("audiooutput")).catch(() => {});
  if (cam) { $("#me video")?.remove(); $("#me").prepend(cam.attach()); }
  $("#me-name").textContent = name;
  document.body.className = "incall";
  setButtons(); refresh(); showHands(); pipAuto(true);
  try { // mic first: being heard matters more than being seen
    if (mic) { await room.localParticipant.publishTrack(mic, { source: Track.Source.Microphone }); if (!micWanted) await mic.mute(); }
    if (cam) {
      const codec = await camCodec;
      if (codec) room.opts.publishDefaults.videoCodec = codec;
      await room.localParticipant.publishTrack(cam, { source: Track.Source.Camera });
      if (!camWanted) await cam.mute();
    }
  } catch (e) { say(String(e.message || e), 0); }
  setButtons();
}

function showRecording(r) {
  const el = $("#rec");
  el.hidden = !r.on;
  el.classList.toggle("paused", r.on && r.streams === 0);
  el.lastChild.textContent = r.on && r.streams > 0 ? T.recording : T.recordingOff;
}

function left() {
  document.body.className = "over";
  pipAuto(false); pipWin?.close(); $("#myscreen")?.remove();
  document.querySelectorAll(".tile:not(#me)").forEach((t) => t.remove());
  try { room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.stop(); } catch { /* none */ } // or the "sharing" bar stays
  cam?.stop(); mic?.stop();
}

async function toggleShare() {
  try { await room.localParticipant.setScreenShareEnabled(!room.localParticipant.isScreenShareEnabled, { contentHint: "text" }); }
  catch (e) { if (e?.name !== "NotAllowedError") console.warn("share", e); } // cancelling the picker is fine
  setButtons();
}

// the mic buttons glow with your voice level, so you can see you're heard (15 times a second, only when it changes)
let meter = null;
function micMeter() {
  if (!mic) return;
  try {
    audio ||= new AudioContext();
    meter?.src.disconnect();
    const an = audio.createAnalyser(); an.fftSize = 512;
    const src = audio.createMediaStreamSource(new MediaStream([mic.mediaStreamTrack])); src.connect(an);
    const first = !meter; meter = { an, src };
    if (!first) return;
    const buf = new Uint8Array(512);
    let last = "";
    setInterval(() => {
      if (document.hidden) return;
      meter.an.getByteTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const lvl = (micWanted ? Math.min(1, peak / 48) : 0).toFixed(1);
      if (lvl === last) return;
      last = lvl;
      document.querySelectorAll("#b-mic, #p-mic").forEach((b) => b.style.setProperty("--lvl", lvl));
    }, 66);
  } catch { /* the meter is a nicety */ }
}

// ---------- chat: relayed by the room to the people in the call; nothing is stored ----------
const nameOf = (identity) => identity === room?.localParticipant.identity ? T.me : room?.remoteParticipants.get(identity)?.name || T.other;
function addMessage(identity, text, mine) {
  const li = document.createElement("li");
  li.className = mine ? "mine" : "";
  li.innerHTML = `<div class="who"><b></b><time></time></div><div class="text"></div>`;
  li.querySelector("b").textContent = nameOf(identity);
  li.querySelector("time").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  li.querySelector(".text").textContent = text;
  const list = $("#chat-list"); list.append(li); list.scrollTop = list.scrollHeight;
  if (mine) return;
  if ($("#chat").hidden) { $("#b-chat").classList.add("unread"); say(`${nameOf(identity)}: ${text}`.slice(0, 140)); }
  ping();
}
function openChat(open) {
  $("#chat").hidden = !open; document.body.classList.toggle("chat-open", open);
  $("#b-chat").classList.toggle("active", open);
  if (open) { $("#b-chat").classList.remove("unread"); $("#chat-input").focus(); }
}
async function sendChat(e) {
  e.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text || !room) return;
  $("#chat-input").value = ""; $("#chat-send").disabled = true;
  try { await room.localParticipant.sendText(text, { topic: "chat" }); addMessage(room.localParticipant.identity, text, true); }
  catch (err) { say(String(err.message || err)); $("#chat-input").value = text; }
}

// ---------- the camera's codec: the first one this device encodes in hardware (MediaCapabilities "powerEfficient"); H.265
// only when this browser can also decode it. Apple chips have no VP9 encoder and Chrome on a Mac encodes H.264 in software, so
// on a Mac hardware H.265 saves real CPU. Without a hardware encoder it stays VP9 (VP8 on phones). ?codec= forces one. ----------
async function hardwareCodec() {
  const forced = qs.get("codec");
  if (["vp9", "h264", "vp8", "h265"].includes(forced)) return forced;
  const mc = navigator.mediaCapabilities, r = VIDEO_OPTS.resolution;
  if (!mc?.encodingInfo) return null;
  const decodes = (m) => !!RTCRtpReceiver.getCapabilities?.("video")?.codecs.some((x) => x.mimeType === m);
  for (const c of ["h265", "vp9", "h264", "vp8"]) {
    if (c === "h265" && !decodes("video/H265")) continue;
    try {
      const i = await mc.encodingInfo({ type: "webrtc", video: { contentType: `video/${c.toUpperCase()}`, width: r.width, height: r.height, framerate: r.frameRate, bitrate: LITE ? 600_000 : 1_800_000 } });
      if (i.supported && i.powerEfficient) return c;
    } catch { /* this browser can't tell */ }
  }
  return null;
}
let camCodec = Promise.resolve(null);
const VIDEO_OPTS = { resolution: LITE ? { width: 640, height: 360, frameRate: 24 } : VideoPresets.h720.resolution };
const AUDIO_OPTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 };

// ---------- devices: plain lists in the lobby and in the Devices dialog; choices are remembered per browser ----------
const canPickSpeaker = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
const chosen = (kind) => store.get(`dev-${kind}`) || undefined;
const KINDS = ["audioinput", "audiooutput", "videoinput"];
let devices = { audioinput: [], audiooutput: [], videoinput: [] };
const label = (d) => (d?.label || "").replace(/^Default - /, "").replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "") || "—";
async function loadDevices() {
  const all = await Promise.resolve(navigator.mediaDevices?.enumerateDevices?.() ?? []).catch(() => []);
  for (const k of KINDS) devices[k] = all.filter((d) => d.kind === k && d.deviceId && d.deviceId !== "communications");
  fillSelects();
}
const inUse = (kind) => (kind === "audioinput" ? mic?.mediaStreamTrack?.getSettings().deviceId : kind === "videoinput" ? cam?.raw?.getSettings().deviceId : chosen(kind));
function fillSelects() {
  document.querySelectorAll("select[data-kind]").forEach((s) => {
    const k = s.dataset.kind, cur = inUse(k) || chosen(k) || "default";
    s.innerHTML = devices[k].map((d) => `<option value="${d.deviceId}">${d.deviceId === "default" ? T.sysDefault : ""}</option>`).join("") || `<option value="">${T.noDevices}</option>`;
    [...s.options].forEach((o, i) => { if (devices[k][i] && devices[k][i].deviceId !== "default") o.textContent = label(devices[k][i]); });
    s.value = devices[k].some((d) => d.deviceId === cur) ? cur : s.options[0]?.value || "";
    s.closest("label").hidden = k === "audiooutput" && !canPickSpeaker;
  });
}
async function useDevice(kind, id) {
  store.set(`dev-${kind}`, id);
  try {
    if (room?.state === "connected") await room.switchActiveDevice(kind, id);
    else if (kind === "audioinput" && mic) await mic.restartTrack({ ...AUDIO_OPTS, deviceId: id });
    else if (kind === "videoinput" && cam) await cam.restartTrack({ ...VIDEO_OPTS, deviceId: id });
    else if (kind === "audiooutput") document.querySelectorAll("audio").forEach((a) => a.setSinkId?.(id).catch(() => {}));
    if (kind === "audioinput") micMeter();
  } catch (e) { say(String(e.message || e)); }
  fillSelects();
}

// ---------- reactions and raised hands ----------
const EMOJIS = ["❤️", "👍", "🎉", "👏", "😂", "😮", "🤔", "👎"];
function floatEmoji(emoji, who) {
  const f = Object.assign(document.createElement("div"), { className: "floater" });
  f.innerHTML = `<span class="e"></span><span class="n"></span>`;
  f.querySelector(".e").textContent = emoji; f.querySelector(".n").textContent = who;
  f.style.right = `${10 + Math.random() * 120}px`;
  $("#floaters").append(f); setTimeout(() => f.remove(), 3700);
}
async function sendReaction(emoji) {
  if (!EMOJIS.includes(emoji) || !room) return;
  floatEmoji(emoji, T.me);
  try { await room.localParticipant.sendText(emoji, { topic: "reaction" }); } catch { /* best effort */ }
}
let handUp = false;
async function setHand(up) {
  handUp = up;
  try { await room?.localParticipant.setAttributes({ hand: up ? String(Date.now()) : "" }); } catch (e) { console.warn("hand", e); }
  showHands();
}
function showHands() { // raised hands live in member attributes, so someone joining later still sees them
  const tiles = [["me", handUp], ...[...(room?.remoteParticipants.values() || [])].map((p) => [p.identity, !!p.attributes?.hand])];
  for (const [who, up] of tiles) {
    const t = who === "me" ? $("#me") : document.querySelector(`.tile[data-who="${who}"]`);
    if (!t) continue;
    t.classList.toggle("hand-raised", up);
    let b = t.querySelector(".handup");
    if (up && !b) { b = Object.assign(document.createElement("div"), { className: "handup" }); b.innerHTML = `${icon("hand")}<span></span>`; b.lastChild.textContent = T.handLabel; t.append(b); }
    if (!up) b?.remove();
  }
  setBtn("#b-hand", handUp, "hand", T.lower, T.raise, false);
}

// ---------- popovers: reactions and More ----------
function closePops() { document.querySelectorAll(".popover").forEach((p) => { p.hidden = true; }); document.querySelectorAll(".dock [aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false")); }
function openPop(id, btn) {
  const pop = $(id), open = pop.hidden;
  closePops();
  if (!open) return;
  if (id === "#more") {
    const items = [
      ...(blur ? [["blur", "blur", blurLevel ? T.blurOn : T.blurOff]] : []),
      ...(blur?.setTouch && !LITE ? [["touch", "sparkle", touchOn ? T.touchOn : T.touchOff]] : []),
      ...("documentPictureInPicture" in window || document.pictureInPictureEnabled ? [["pip", "pip", T.pip]] : []),
      ["full", "full", isFull() ? T.exitFullPage : T.fullPage],
      ["devices", "sliders", T.devices],
    ];
    pop.innerHTML = items.map(([k, ic]) => `<button data-more="${k}">${icon(ic)}<span></span></button>`).join("");
    pop.querySelectorAll("[data-more]").forEach((b, i) => { b.querySelector("span").textContent = items[i][2]; });
  }
  const r = btn.getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - pop.offsetWidth / 2, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.bottom = `${innerHeight - r.top + 10}px`;
  btn.setAttribute("aria-expanded", "true");
}
function moreAction(k) {
  closePops();
  if (k === "full") fullScreen(document.documentElement);
  if (k === "pip") openFaces();
  if (k === "blur") setBlur(blurLevel ? 0 : 1);
  if (k === "touch") setTouch(!touchOn);
  if (k === "devices") { loadDevices(); $("#devices-dialog").showModal(); }
}

function tick() { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

(async () => {
  document.title = `${T.title} · ${ROOM}`;
  document.querySelectorAll("[data-room]").forEach((el) => { el.textContent = ROOM; });
  $("#name").value = store.get("call-name") || "";
  $("#key-row").hidden = !!savedKey();
  info = await fetch("api/info").then((r) => r.json()).catch(() => ({}));
  $("#rec-notice").hidden = !info.recording;
  tick(); setInterval(tick, 15000);
  $("#lobby-form").onsubmit = (e) => { e.preventDefault(); join(); };
  ["#p-mic", "#b-mic"].forEach((id) => { $(id).onclick = toggleMic; });
  ["#p-cam", "#b-cam"].forEach((id) => { $(id).onclick = toggleCam; });
  $("#p-blur").onclick = () => setBlur(blurLevel ? 0 : 1);
  $("#b-share").onclick = toggleShare;
  $("#b-share").hidden = !navigator.mediaDevices?.getDisplayMedia; // phones can't share the screen from a browser
  $("#b-leave").onclick = () => room?.disconnect();
  $("#rejoin").onclick = () => location.reload();
  $("#b-react").onclick = (e) => { e.stopPropagation(); openPop("#reactions", $("#b-react")); };
  $("#b-more").onclick = (e) => { e.stopPropagation(); openPop("#more", $("#b-more")); };
  $("#b-hand").onclick = () => setHand(!handUp);
  $("#reactions").innerHTML = EMOJIS.map((x) => `<button data-emoji="${x}" aria-label="${x}">${x}</button>`).join("");
  $("#reactions").onclick = (e) => { e.stopPropagation(); const b = e.target.closest("[data-emoji]"); if (b) sendReaction(b.dataset.emoji); };
  $("#more").onclick = (e) => { e.stopPropagation(); const b = e.target.closest("[data-more]"); if (b) moreAction(b.dataset.more); };
  addEventListener("click", closePops);
  addEventListener("keydown", (e) => { if (e.key === "Escape") closePops(); });
  document.querySelectorAll("select[data-kind]").forEach((s) => { s.onchange = () => useDevice(s.dataset.kind, s.value); });
  navigator.mediaDevices?.addEventListener?.("devicechange", loadDevices);
  for (const [id, ic, l] of [["#b-react", "smile", T.react], ["#b-chat", "chat", T.chat], ["#b-more", "more", T.more], ["#b-leave", "leave", T.leave]]) {
    $(id).insertAdjacentHTML("afterbegin", icon(ic)); $(id).querySelector(".lbl").textContent = l; $(id).title = l; $(id).setAttribute("aria-label", l);
  }
  $("#chat-close").innerHTML = icon("close"); $("#chat-send").innerHTML = icon("send");
  $("#me").insertAdjacentHTML("beforeend", TOOLS());
  $("#stage").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"), tile = e.target.closest(".tile");
    if (b && tile) { e.stopPropagation(); if (b.dataset.act === "pin") pinToggle(tile); else fullScreen(tile); return; }
    if (tile && matchMedia("(hover: none)").matches) tile.classList.toggle("show-tools"); // touch screens: tap shows the buttons
  });
  $("#stage").addEventListener("dblclick", (e) => { const tile = e.target.closest(".tile"); if (tile && !e.target.closest("[data-act]")) pinToggle(tile); });
  $("#b-chat").onclick = () => openChat($("#chat").hidden);
  $("#chat-close").onclick = () => openChat(false);
  $("#chat-form").onsubmit = sendChat;
  $("#chat-input").oninput = () => { $("#chat-send").disabled = !$("#chat-input").value.trim(); };
  toolTips(); showHands(); setButtons();
  await preview();
})();
