"""Turn a recorded call in R2 into ordinary files: one audio track per person, a mixed track, and the shared-screen frames.

The room saves recordings to R2 as:

  rec/<room>/<session>/meta.json                               {session, startedAt, endedAt, names: {member: name}, room}
  rec/<room>/<session>/<member>-microphone/<start ms>.pcm      raw mono 48 kHz s16le, continuous from <start ms>
  rec/<room>/<session>/<member>-screen_share/<ms>.jpgs         frames: float64 ms + uint32 length + JPEG, repeated

This lays every piece on one timeline starting at startedAt, so pauses (mute, dropouts) stay silent and the voices stay in
step, and writes <out>/<room>/<session>/: <name>.flac per person, mix.m4a, screen/<seconds>.jpg, call.json.

  python collect.py list                         recordings in the bucket
  python collect.py build <room> <session>       build one (add --delete to remove its R2 objects afterwards)

Needs: Python 3.10+, numpy, ffmpeg on PATH, and environment variables CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (with R2 read,
and edit for --delete) and R2_BUCKET.
"""
import argparse
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

RATE = 48000


def _api(path: str, query: dict | None = None, method: str = "GET") -> bytes:
    acct, bucket, token = (os.environ.get(k, "") for k in ("CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "CLOUDFLARE_API_TOKEN"))
    if not (acct and bucket and token):
        sys.exit("Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and R2_BUCKET first.")
    url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/r2/buckets/{bucket}/objects{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url, method=method, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def list_objects(prefix: str, delimiter: str | None = None) -> tuple[list[dict], list[str]]:
    objects, folders, cursor = [], [], None
    while True:
        q = {"prefix": prefix, "per_page": 1000, **({"delimiter": delimiter} if delimiter else {}), **({"cursor": cursor} if cursor else {})}
        d = json.loads(_api("", q))
        objects += d.get("result") or []
        info = d.get("result_info") or {}
        folders += info.get("delimited") or []
        cursor = info.get("cursor")
        if not info.get("is_truncated") or not cursor:
            return objects, folders


def get(key: str) -> bytes:
    return _api("/" + urllib.parse.quote(key, safe="/"))


def frames_of(blob: bytes):
    """(ms, jpeg) from one .jpgs piece."""
    i = 0
    while i + 12 <= len(blob):
        ms, n = struct.unpack_from("<dI", blob, i)
        yield ms, blob[i + 12:i + 12 + n]
        i += 12 + n


def place(pieces: list[tuple[float, bytes]], t0: float, t1: float) -> np.ndarray:
    """Lay (start ms, mono 48 kHz s16le) pieces on a silent timeline from t0 to t1. Overlapping pieces are mixed."""
    out = np.zeros(max(0, int((t1 - t0) * RATE / 1000)), dtype=np.int32)
    for start, raw in sorted(pieces):
        a = np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2")
        at = int(round((start - t0) * RATE / 1000))
        if at < 0:
            a, at = a[-at:], 0
        n = min(len(a), len(out) - at)
        if n > 0:
            out[at:at + n] += a[:n]
    return np.clip(out, -32768, 32767).astype(np.int16)


def safe(name: str) -> str:
    return re.sub(r"[^\w.-]+", "_", name, flags=re.UNICODE).strip("._") or "guest"


def flac(samples: np.ndarray, out: Path) -> None:
    with tempfile.NamedTemporaryFile(suffix=".raw") as f:
        f.write(samples.tobytes())
        f.flush()
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(RATE), "-ac", "1", "-i", f.name, str(out)], check=True)


def build(room: str, session: str, out_root: Path, delete: bool = False) -> Path:
    prefix = f"rec/{room}/{session}/"
    meta = json.loads(get(prefix + "meta.json"))
    d = out_root / room / session
    d.mkdir(parents=True, exist_ok=True)
    objects, _ = list_objects(prefix)
    audio: dict[str, list[tuple[float, bytes]]] = {}
    frames: list[tuple[float, bytes]] = []
    t0 = meta["startedAt"]
    t_end = meta.get("endedAt") or t0
    for o in objects:
        parts = o["key"][len(prefix):].split("/")
        if len(parts) != 2:
            continue
        stream, piece = parts
        member, track = stream.rsplit("-", 1)[0], stream.rsplit("-", 1)[-1]
        start = float(piece.split(".")[0])
        if piece.endswith(".pcm") and track == "microphone":
            raw = get(o["key"])
            audio.setdefault(member, []).append((start, raw))
            t_end = max(t_end, start + len(raw) / 2 / RATE * 1000)
        elif piece.endswith(".jpgs"):
            frames += list(frames_of(get(o["key"])))
    names = meta.get("names") or {}
    files = []
    for member, pieces in audio.items():
        f = d / f"{safe(names.get(member, member))}-{member[-4:]}.flac"
        flac(place(pieces, t0, t_end), f)
        files.append(f)
    if files:
        ins = sum((["-i", str(f)] for f in files), [])
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *ins, "-filter_complex", f"amix=inputs={len(files)}:normalize=0", "-c:a", "aac", "-b:a", "48k",
                        "-movflags", "+faststart", str(d / "mix.m4a")], check=True)
    if frames:
        sd = d / "screen"
        sd.mkdir(exist_ok=True)
        for ms, jpg in frames:
            (sd / f"{(ms - t0) / 1000:08.1f}.jpg").write_bytes(jpg)
    (d / "call.json").write_text(json.dumps({**meta, "seconds": round((t_end - t0) / 1000), "tracks": [f.name for f in files], "frames": len(frames)}, indent=2, ensure_ascii=False))
    if delete:
        for o in objects:
            _api("/" + urllib.parse.quote(o["key"], safe="/"), method="DELETE")
    return d


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    b = sub.add_parser("build")
    b.add_argument("room"); b.add_argument("session")
    b.add_argument("--out", default="out"); b.add_argument("--delete", action="store_true", help="delete the R2 objects after building")
    a = ap.parse_args()
    if a.cmd == "list":
        _, rooms = list_objects("rec/", "/")
        for r in rooms:
            _, sessions = list_objects(r, "/")
            for s in sessions:
                print(s.strip("/").split("/", 1)[1].replace("/", "  "))
    else:
        print(build(a.room, a.session, Path(a.out), a.delete))


if __name__ == "__main__":
    main()
