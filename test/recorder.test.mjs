// Recording pieces: Cloudflare's adapter packets -> R2 segments (no SFU, no R2: fakes).
import { packetPayload, downmix, Recorder, sessionName } from "../src/room.js";

let fails = 0;
const check = (name, cond) => { console.log(cond ? "ok  " : "FAIL", name); if (!cond) fails++; };

// protobuf Packet { sequenceNumber = 1; timestamp = 2; payload = 5 }
const varint = (v) => { const out = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); return out; };
const packet = (seq, ts, payload) => new Uint8Array([0x08, ...varint(seq), 0x10, ...varint(ts), 0x2a, ...varint(payload.length), ...payload]).buffer;
const stereo = (n, l, r) => { const a = new Int16Array(n * 2); for (let i = 0; i < n; i++) { a[2 * i] = l; a[2 * i + 1] = r; } return new Uint8Array(a.buffer); };

const p = packetPayload(new Uint8Array(packet(300, 4_000_000_000, [1, 2, 3])));
check("packet payload is read past large varints", p && p.join() === "1,2,3");
check("a broken packet gives nothing", packetPayload(new Uint8Array([0x2a, 0x05, 1])) === null);
check("stereo is mixed to mono", downmix(stereo(3, 1000, 3000)).join() === "2000,2000,2000");
check("session names are UTC start times", sessionName(Date.UTC(2026, 10, 6, 2, 0, 31)) === "2026-11-06T02-00-31");

let t = 1_000_000;
const puts = [];
const rec = new Recorder(async (key, body) => { puts.push({ key, body }); }, "rec/main/S/m-0123abcd-microphone", "pcm", () => t);
for (let i = 0; i < 50; i++) { t += 20; rec.add(packet(i, i, stereo(960, 100, 100))); } // 1 s of 20 ms packets
t += 5000; rec.add(packet(51, 51, stereo(960, 7, 7))); // after a 5 s pause (muted)
await rec.flush();
check("a pause starts a new segment", puts.length === 2);
check("first segment holds 1 s of mono audio", puts[0].body.length === 48000 * 2);
check("segments are named by their start time", puts[0].key === "rec/main/S/m-0123abcd-microphone/1000000.pcm" && puts[1].key.endsWith(`/${t - 20}.pcm`));
for (let i = 0; i < 1600; i++) { t += 20; rec.add(packet(i, i, stereo(960, 1, 1))); } // 32 s straight
await rec.flush();
check("long audio is cut into 30 s pieces", puts.length === 4 && puts[2].body.length === 48000 * 2 * 30);

const shots = [];
const vid = new Recorder(async (key, body) => { shots.push({ key, body }); }, "rec/main/S/m-0123abcd-screen_share", "jpeg", () => t);
vid.add(packet(0, 0, [0xff, 0xd8, 9, 0xff, 0xd9])); t += 1000; vid.add(packet(0, 1, [0xff, 0xd8, 8, 0xff, 0xd9]));
t += 3000; vid.idle(); await vid.chain;
const b = shots[0]?.body, dv = b && new DataView(b.buffer);
check("frames are saved with their time and length", shots.length === 1 && shots[0].key.endsWith(".jpgs") && dv.getUint32(8, true) === 5 && b.length === 2 * (12 + 5));

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
