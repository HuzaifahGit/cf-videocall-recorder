# Third-party notices

This project's own code is under the MIT License (see `LICENSE`). It uses the following third-party software and models, each
under its own license. Nothing here is affiliated with or endorsed by their authors.

## Bundled into the built page (`public/app.js`, `public/effects-worker.js`)

**gregblur** 0.1.3, https://github.com/gregce/gregblur
Licensed under the Apache License, Version 2.0. The full license text is in `node_modules/gregblur/LICENSE` after
`npm install`, and at https://www.apache.org/licenses/LICENSE-2.0. This project uses it unmodified, through its published
entry points (`gregblur`, `gregblur/livekit`, `gregblur/detect`).

## Loaded by the browser at runtime (not included in this repository)

**MediaPipe Tasks Vision** (`@mediapipe/tasks-vision`), https://github.com/google-ai-edge/mediapipe
Licensed under the Apache License, Version 2.0. gregblur loads its JavaScript bundle and WebAssembly from the jsDelivr CDN
when background blur is first turned on.

**MediaPipe selfie segmentation model** (`selfie_multiclass_256x256`), downloaded from Google's model storage
(storage.googleapis.com/mediapipe-models) when background blur is first turned on. It is provided by Google under the terms
in its model card; check them before redistributing the model file itself.

## Build and deploy tools (development only, not shipped)

- **esbuild**, MIT License, https://github.com/evanw/esbuild
- **Wrangler**, Apache-2.0 / MIT, https://github.com/cloudflare/workers-sdk

## Services

The call runs on Cloudflare Realtime (SFU), Cloudflare Workers, Durable Objects and, optionally, R2, under your own Cloudflare
account and Cloudflare's terms of service.

## Icons

The interface icons are simple line drawings made for this project (in `client/app.js`), released under this project's MIT
License.
