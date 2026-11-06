// A track processor (init / restart / destroy / setEnabled / processedTrack) that runs the camera effects in effects-worker.js.
// Falls back to the usual main-thread processor when the browser can't hand frame streams to a worker, or the worker doesn't
// get going within 10 s (e.g. MediaPipe can't load there), so blur never stops working because of this.
const canOffload = () => typeof Worker === "function" && typeof globalThis.MediaStreamTrackProcessor === "function"
  && typeof globalThis.MediaStreamTrackGenerator === "function" && typeof OffscreenCanvas === "function";

export function createOffThreadBlur({ workerUrl, model, options, fallback, touch = false, onLog = () => {} }) {
  let worker = null, generator = null, mainThread = null, enabled = !!options.initialEnabled, touchOn = !!touch;
  const p = {
    name: "gregblur-worker",
    processedTrack: undefined,
    get offThread() { return !!worker; },
    async init(opts) {
      await stop();
      if (mainThread || !canOffload()) return useMainThread(opts, mainThread ? null : "unsupported");
      const track = opts.track, set = track.getSettings();
      const w = set.width || 1280, h = set.height || 720;
      const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      const gen = new MediaStreamTrackGenerator({ kind: "video" });
      const wk = new Worker(workerUrl);
      const started = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("worker timeout")), 10_000);
        wk.onmessage = ({ data }) => {
          if (data.type === "ready") { clearTimeout(t); resolve(); }
          else if (data.type === "error") { clearTimeout(t); reject(new Error(data.msg)); }
          else if (data.type === "frame-error") onLog("blur-frame-error", { msg: data.msg });
          else if (data.type === "blur-loaded") onLog("blur-loaded", {});
        };
        wk.onerror = (e) => { clearTimeout(t); reject(new Error(e.message || "worker error")); };
      });
      wk.postMessage({ type: "start", readable: processor.readable, writable: gen.writable, w, h, model, options, enabled, touch: touchOn }, [processor.readable, gen.writable]);
      try { await started; } catch (e) { wk.terminate(); gen.stop(); return useMainThread(opts, String(e.message || e)); }
      worker = wk; generator = gen; p.processedTrack = gen;
      onLog("blur-engine", { thread: "worker", w, h, touch: touchOn });
    },
    async restart(opts) { await p.init(opts); },
    async destroy() { await stop(); if (mainThread) await mainThread.destroy(); },
    setEnabled(on) { enabled = !!on; worker?.postMessage({ type: "enabled", on: enabled }); mainThread?.setEnabled(enabled); },
    isEnabled() { return enabled; },
    get canTouch() { return !!worker; }, // the touch-up only exists in the worker (the main-thread fallback has blur only)
    setTouch(on) { touchOn = !!on; worker?.postMessage({ type: "touch", on: touchOn }); },
  };
  async function stop() {
    if (worker) { worker.postMessage({ type: "stop" }); const w = worker; setTimeout(() => w.terminate(), 500); worker = null; }
    generator?.stop(); generator = null; p.processedTrack = undefined;
  }
  async function useMainThread(opts, why) {
    if (!mainThread) { mainThread = fallback(); if (why) onLog("blur-engine", { thread: "main", why: why.slice(0, 120) }); }
    await mainThread.init(opts);
    mainThread.setEnabled(enabled);
    p.processedTrack = mainThread.processedTrack;
  }
  return p;
}
