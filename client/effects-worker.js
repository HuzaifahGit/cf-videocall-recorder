// Camera effects off the page's main thread: a light touch-up (edge-preserving smoothing + gentle shadow lift) and the
// background blur (gregblur, Apache-2.0). The page hands over the camera's frame stream (MediaStreamTrackProcessor's readable) and
// the output's writable (MediaStreamTrackGenerator); every frame is processed here on the GPU, so chat, stats and layout work on
// the page can't drop camera frames. Built as a classic worker (IIFE): MediaPipe loads its WASM loader with importScripts,
// which module workers don't have. The blur model is only loaded the first time blur is turned on.
import { createGregblurPipeline, createMediaPipeProvider } from "gregblur";

let pipeline = null, loading = null, blurOn = false, touchOn = false, abort = null, cfg = null;

// ---------- touch-up: one WebGL2 pass. 5x5 bilateral (taps 1.5 px apart): grain and skin texture (small colour differences)
// are averaged, edges (eyes, hair, glasses: big differences) are kept; then shadows and mid-tones are lifted a little, highlights
// left as they are. A synthetic test: grain -40%, a hard edge kept exactly, highlights unchanged, ~30 fps at 720p.
const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
uniform sampler2D t; uniform vec2 px; uniform float amt; uniform float lift;
in vec2 uv; out vec4 o;
void main() {
  vec3 c = texture(t, uv).rgb, sum = vec3(0.0); float ws = 0.0;
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) {
    vec2 d = vec2(float(i), float(j)) * 1.5;
    vec3 s = texture(t, uv + d * px).rgb;
    vec3 e = s - c;
    float w = exp(-dot(d, d) / 8.0) * exp(-dot(e, e) / 0.006);
    sum += s * w; ws += w;
  }
  vec3 r = mix(c, sum / ws, amt);
  float y = dot(r, vec3(0.299, 0.587, 0.114));
  r += lift * y * (1.0 - y) * (1.0 - y);
  o = vec4(clamp(r, 0.0, 1.0), 1.0);
}`;
let tc = null, gl = null, prog = null, tex = null, loc = {};
function touchInit(w, h) {
  tc = new OffscreenCanvas(w, h);
  gl = tc.getContext("webgl2", { premultipliedAlpha: false, antialias: false, desynchronized: true, preserveDrawingBuffer: false });
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle covering the screen
  const a = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  loc = { px: gl.getUniformLocation(prog, "px"), amt: gl.getUniformLocation(prog, "amt"), lift: gl.getUniformLocation(prog, "lift") };
  gl.uniform1f(loc.amt, 0.6); gl.uniform1f(loc.lift, 0.22);
}
function touchFrame(frame) {
  const w = frame.displayWidth, h = frame.displayHeight;
  if (!tc) touchInit(w, h);
  if (tc.width !== w || tc.height !== h) { tc.width = w; tc.height = h; }
  gl.viewport(0, 0, w, h); gl.uniform2f(loc.px, 1 / w, 1 / h);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return new VideoFrame(tc, { timestamp: frame.timestamp ?? 0 });
}

function loadBlur() {
  loading ||= (async () => {
    const p = createGregblurPipeline(createMediaPipeProvider({ model: cfg.model }), { ...cfg.options, initialEnabled: true });
    await p.init(cfg.w, cfg.h);
    pipeline = p;
    self.postMessage({ type: "blur-loaded" });
  })().catch((e) => { loading = null; self.postMessage({ type: "frame-error", msg: `blur: ${String(e?.message || e).slice(0, 120)}` }); });
  return loading;
}

self.onmessage = async ({ data: m }) => {
  if (m.type === "enabled") { blurOn = !!m.on; if (blurOn) loadBlur(); return; }
  if (m.type === "touch") { touchOn = !!m.on; return; }
  if (m.type === "stop") { abort?.abort(); pipeline?.destroy(); pipeline = null; return; }
  if (m.type !== "start") return;
  try {
    cfg = m; blurOn = !!m.enabled; touchOn = !!m.touch;
    if (blurOn) await loadBlur();
    abort = new AbortController();
    const fx = new TransformStream({
      transform(frame, out) {
        if (!touchOn && !(blurOn && pipeline)) { out.enqueue(frame); return; } // nothing to do: frames pass straight through
        let cur = frame;
        try {
          if (touchOn) { const t = touchFrame(cur); cur.close(); cur = t; }
          if (blurOn && pipeline) {
            pipeline.processFrame(cur, cur.timestamp != null ? cur.timestamp / 1e3 : performance.now());
            const b = new VideoFrame(pipeline.getCanvas(), { timestamp: cur.timestamp ?? 0 });
            cur.close(); cur = b;
          }
        } catch (e) {
          self.postMessage({ type: "frame-error", msg: String(e?.message || e).slice(0, 120) });
        }
        out.enqueue(cur);
      },
    });
    m.readable.pipeThrough(fx, { signal: abort.signal }).pipeTo(m.writable, { signal: abort.signal }).catch(() => {});
    self.postMessage({ type: "ready" });
  } catch (e) {
    self.postMessage({ type: "error", msg: String(e?.message || e).slice(0, 200) });
  }
};
