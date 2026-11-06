# cf-videocall-recorder

A small, self-hosted video call that runs entirely on Cloudflare: **Realtime SFU** for the media, one **Worker** for the
page and API, and a **Durable Object** per room. It has background blur and a touch-up filter that run in a Web Worker, screen
sharing with scroll and zoom of the shared tab, a floating faces window, chat, reactions, raised hands, and **optional
recording to R2** through Cloudflare's WebSocket adapter. A small Python script turns a recording into one audio file per person
plus the shared-screen frames.

Built for small calls (2–4 people) on a free or nearly free Cloudflare account. It is not a meeting product: there are no
accounts, calendars, waiting rooms or moderation tools.

> **An independent community project, not a Cloudflare product.** It is not affiliated
> with, endorsed by or sponsored by Cloudflare, Google or any video-call vendor. Cloudflare and other product names are
> trademarks of their owners and are used here only to describe compatibility.

## Similar projects, and when to use which

- **[Cloudflare Meet](https://github.com/cloudflare/meet)** (formerly Orange Meets), Cloudflare's own open-source video call
  on Realtime SFU. More complete and maintained by Cloudflare. Use it if you want a full meeting app.
- **[RealtimeKit](https://developers.cloudflare.com/realtime/)**, Cloudflare's managed SDKs, with recording, background effects
  and transcription built in, billed by usage. Use it if you'd rather not run any of this yourself.
- **This project** is for the narrower case of **recording calls into your own R2 bucket with each speaker on a separate
  track** (useful for per-speaker transcription), in a small codebase you can read and change: plain JavaScript, one Worker,
  one Durable Object class, no framework or database. It also writes down the problems met along the way (see "How it works"
  below).

It has been used mainly for two-person calls between a few devices; it is not tested at scale.

## Contents

| Path | What it is |
|---|---|
| `src/worker.js` | The Worker: static page, `/api/*`, the room key check, the recording endpoint |
| `src/room.js` | The room (Durable Object): members, tracks, SFU calls with the App Secret, chat relay, optional recording |
| `client/sfu-client.js` | Browser side of the call: one sending and one receiving PeerConnection, each with its own SFU session |
| `client/app.js` | The page: lobby, tiles, controls, chat, screen sharing, floating window, codec choice |
| `client/effects-worker.js` | Touch-up and background blur on the GPU, off the main thread |
| `public/index.html` | Markup and styles (the build writes `app.js` and `effects-worker.js` next to it) |
| `collector/collect.py` | Recording in R2 → `<name>.flac` per person, `mix.m4a`, `screen/*.jpg` |
| `test/` | Tests with a fake SFU (`npm test`) and for the collector (`python -m unittest test/test_collect.py`) |

## Set up

You need a Cloudflare account, Node.js 20+, and (for recordings) Python 3.10+ with ffmpeg.

1. **Create a Realtime app.** In the Cloudflare dashboard: Realtime → SFU → create an application. Note its **App ID** and
   **App Secret**.
2. **Install and log in:**
   ```bash
   npm install
   npx wrangler login
   ```
3. **Set the secrets.** The room key is what people need to join, so pick a long random one:
   ```bash
   npx wrangler secret put RT_APP_ID
   npx wrangler secret put RT_APP_SECRET
   npx wrangler secret put ROOM_KEY
   ```
4. **Deploy:**
   ```bash
   npm run deploy
   ```
5. **Share a link.** `https://<your-worker>.workers.dev/?room=team#key=<ROOM_KEY>` opens room `team` with the key filled in.
   The part after `#` is never sent to the server; the page keeps the key for that browser tab and removes it from the address
   bar. Room names are lowercase letters, digits and dashes. Anyone with the key can join any room, so share it like a password
   and rotate it (`wrangler secret put ROOM_KEY`) if it leaks.

Local development: `npm run dev` (put the secrets in a `.dev.vars` file, which is git-ignored).

## Recording (optional, off by default)

When `RECORD = "on"`, a room records **audio of every microphone and every shared screen (1 frame a second)** while two or
more people are in it. Cameras are not recorded. Everyone sees a notice in the lobby before joining, and a "Recording" badge
during the call.

1. Create a bucket: `npx wrangler r2 bucket create videocall-recordings`, then uncomment the `[[r2_buckets]]` block in
   `wrangler.toml`.
2. Set `RECORD = "on"` in `wrangler.toml` and a random `REC_KEY` secret (`npx wrangler secret put REC_KEY`). The SFU's adapter
   connects back to `/rec/<REC_KEY>/...`; it can't send headers, so the secret is in the path.
3. Deploy again. Recordings land in R2 under `rec/<room>/<session>/`, where the session is the UTC start time.
4. Build one into files:
   ```bash
   pip install -r collector/requirements.txt
   export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... R2_BUCKET=videocall-recordings
   python collector/collect.py list
   python collector/collect.py build team 2026-11-06T02-00-31 --delete
   ```

**Consent and the law are your responsibility.** Recording laws differ by country and state; many require *everyone's*
consent, not just one person's. Tell participants before the call, keep the lobby notice, store recordings only as long as you
need them (`--delete` removes the raw pieces from R2 once built), and don't record people who haven't agreed. Recordings may be
personal data under laws such as the GDPR.

## What it costs

At the time of writing (check Cloudflare's current pricing):

- **Realtime SFU:** the first 1,000 GB of media each month is free, then about $0.05 per GB. A two-person call at 720p uses
  roughly 1.5–2 GB per hour in total.
- **Workers and Durable Objects:** the free plan covers small calls easily (SQLite-backed Durable Objects are on the free plan).
- **R2** (recording only): 10 GB of storage free; one hour of two voices plus a shared screen is about 0.8 GB before building.

## How it works, and the things that were hard to get right

- **Two PeerConnections per person.** One sends (camera, mic, screen), one receives, each with its own SFU session. Every SDP
  exchange goes through the room, one at a time per session.
- **Open the receiving session late.** A receiving session created at join, while nobody else is publishing, goes stale
  ("Session appears to be disconnected"). It is opened at the first subscribe instead.
- **Pull right after publish can fail.** Asking for a track the moment it is published can return `not_found_track_error` or
  `empty_track_error` until the SFU has seen its media. The client retries after 0.3 s, doubling up to six times, and starts
  over once it works.
- **Recording runs in the background.** Starting a WebSocket adapter makes Cloudflare connect back into the same Durable
  Object; awaiting that inside the publish request held up the sharer for about 8 seconds. The room starts adapters after
  replying, and retries tracks that have no packets yet every 3 seconds.
- **Adapter messages can arrive as Blobs.** They are converted in order, so recording pieces stay in sequence. Each message is
  a small protobuf `Packet` whose field 5 is the payload: 48 kHz stereo PCM for audio, a JPEG for video.
- **Screen share starts blurry** because it begins on the camera's leftover bandwidth. While sharing, the camera is capped at
  300 kbps and halved in size, and the screen gets high priority; text is sharp within a couple of seconds.
- **Stop the screen capture on leave**, or the browser keeps showing its "sharing" bar.
- **Hardware video encoding.** The camera uses the first codec the device can encode in hardware (MediaCapabilities
  `powerEfficient`), with H.265 first when the browser can also decode it. On Apple-silicon Macs this matters: there is no VP9
  hardware encoder and Chrome encodes H.264 in software there, while hardware H.265 cut the call's CPU use by about 20%.
- **Effects off the main thread.** Blur and touch-up run in a Web Worker on transferred frame streams, so layout and chat work
  on the page can't drop camera frames. If the browser can't do that, it falls back to the main thread.
- **Fewer stats calls.** Speaking indicators use `getSynchronizationSources()`; full `getStats()` runs once per connection
  every 2 seconds.
- **Phones get a lighter call**: blur off unless turned on, 360p at 24 fps. `?lite=1` / `?lite=0` force it either way.

## Browser support

Tested mostly in Chrome (macOS, Windows, Android), where everything works; Edge should match. Safari and Firefox are less
tested: the call itself uses standard WebRTC, but some extras (blur in a worker, the floating
window, shared-tab scroll and zoom, CPU-pressure signals) are Chromium-only and are hidden or fall back when missing. Phone
browsers can't share their screen.

## Security notes

- The Realtime App Secret stays in the Worker; browsers never see it or any SFU session id.
- Joining needs the room key (compared in constant time). After joining, every request and the room socket need a per-member
  token, so one person can't act for another.
- Chat and reactions are relayed to the people in the call and never stored.
- There is no rate limiting beyond what Cloudflare provides; keep the room key private.

## Contributing

Issues and pull requests are welcome. Run `npm test` before sending changes.

## License

MIT; see [LICENSE](LICENSE). Third-party components keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
