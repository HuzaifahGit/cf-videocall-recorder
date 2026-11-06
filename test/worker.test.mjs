// The Worker's routing: the room key at join, room names, the recording route, static assets.
import worker from "../src/worker.js";

let fails = 0;
const check = (name, cond) => { console.log(cond ? "ok  " : "FAIL", name); if (!cond) fails++; };

const seen = [];
const env = {
  ROOM_KEY: "correct-horse", RECORD: "off",
  ASSETS: { fetch: async () => new Response("page") },
  ROOM: { idFromName: (n) => n, get: (id) => ({ fetch: async (req) => { seen.push({ id, url: req.url, room: req.headers.get("x-room") }); return new Response("{}"); } }) },
};
const call = (path, init = {}) => worker.fetch(new Request(`https://call.example${path}`, init), env);

let r = await call("/api/rt/main/join", { method: "POST", body: "{}" });
check("join without the key is refused", r.status === 403 && seen.length === 0);
r = await call("/api/rt/main/join", { method: "POST", body: "{}", headers: { "x-room-key": "correct-horsf" } });
check("a wrong key is refused", r.status === 403);
r = await call("/api/rt/main/join", { method: "POST", body: "{}", headers: { "x-room-key": "correct-horse" } });
check("the right key reaches the room", r.status === 200 && seen.at(-1).id === "main" && seen.at(-1).room === "main");
r = await call("/api/rt/Bad_Room/join", { method: "POST", body: "{}", headers: { "x-room-key": "correct-horse" } });
check("odd room names are refused", r.status === 404);
r = await call("/api/rt/main/session", { method: "POST", body: "{}" });
check("other operations go to the room (it checks the member token)", r.status === 200 && seen.at(-1).url === "https://room/session");
r = await call("/rec/anything/main/S/m-00000000/microphone");
check("the recording route is closed when recording is off", r.status === 404);
r = await call("/api/info");
check("info says whether recording is on", (await r.json()).recording === false);
check("anything else is the page", (await (await call("/")).text()) === "page");
r = await worker.fetch(new Request("https://call.example/api/rt/main/join", { method: "POST", body: "{}", headers: { "x-room-key": "x" } }), { ...env, ROOM_KEY: "" });
check("no ROOM_KEY set: nobody can join", r.status === 503);

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
