"""Server side of the Terminal tab (terminal.js).

Two small jobs, and neither runs anybody's code:

1. Serve the Python engine (Pyodide) from the vendor/ folder, so the browser
   never has to go to the internet for it. Get it with `python3 setup_python.py`.

2. Carry keyboard input to a running Python program. Python's input() has to
   wait for an answer while the program is paused, and a browser worker can only
   do that with a blocking request. The worker asks GET /api/stdin?chan=...
   and this waits until the person's browser POSTs a line to the same channel.
   A channel name is a random 128-bit value that only that browser knows.
"""
import os
import queue
import re
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "vendor", "pyodide")
FILES = {                       # the only files /vendor/pyodide/ will ever serve
    "pyodide.js": "text/javascript; charset=utf-8",
    "pyodide.asm.mjs": "text/javascript; charset=utf-8",
    "pyodide.asm.wasm": "application/wasm",
    "python_stdlib.zip": "application/zip",
    "pyodide-lock.json": "application/json",
}

WAIT = 20.0                     # seconds one request waits before the browser asks again
MAX_PER_PERSON = 8              # open channels per person
MAX_LINE = 4000                 # characters in one line of input
MAX_QUEUED = 500                # lines waiting to be read
LIFETIME = 3600                 # a channel is forgotten after an hour

_lock = threading.Lock()
_chans = {}                     # channel -> {"q": Queue, "owner": id, "ts": time}
_CHAN = re.compile(r"[0-9a-f]{32}")


def python_available():
    return all(os.path.isfile(os.path.join(VENDOR, n)) for n in FILES)


# ---- the Python engine ---------------------------------------------------
def serve_vendor(handler, path):
    """GET /vendor/pyodide/<file>"""
    name = path.rsplit("/", 1)[-1]
    full = os.path.join(VENDOR, name)
    if name not in FILES or not os.path.isfile(full):
        return handler.reply(404, {"error": "Python isn't set up on the host "
                                            "yet. Run: python3 setup_python.py"})
    st = os.stat(full)
    etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
    handler.send_response(304 if handler.headers.get("If-None-Match") == etag
                          else 200)
    handler.send_header("ETag", etag)
    handler.send_header("Cache-Control", "no-cache")     # keep it, but ask each time
    if handler.headers.get("If-None-Match") == etag:
        return handler.end_headers()
    handler.send_header("Content-Type", FILES[name])
    handler.send_header("Content-Length", str(st.st_size))
    handler.end_headers()
    try:
        with open(full, "rb") as f:
            while chunk := f.read(1 << 20):
                handler.wfile.write(chunk)
    except OSError:
        pass                                  # the browser went away


# ---- keyboard input ------------------------------------------------------
def _prune(now):
    for c in [c for c, v in _chans.items() if now - v["ts"] > LIFETIME]:
        del _chans[c]


def post(peer, body):
    """POST /api/stdin from a signed-in computer. Returns (error, status)."""
    chan, op = str(body.get("chan") or ""), body.get("op")
    if not _CHAN.fullmatch(chan):
        return "Bad channel.", 400
    now = time.time()
    with _lock:
        _prune(now)
        ch = _chans.get(chan)
        if op == "open":
            if ch is not None:
                return None, 200
            if sum(1 for v in _chans.values() if v["owner"] == peer.id) >= MAX_PER_PERSON:
                return "Too many programs are waiting for input.", 429
            _chans[chan] = {"q": queue.Queue(), "owner": peer.id, "ts": now}
            return None, 200
        if ch is None or ch["owner"] != peer.id:
            return "Unknown channel.", 404
        ch["ts"] = now
        q = ch["q"]
        if op in ("line", "lines"):
            lines = body.get("lines") if op == "lines" else [body.get("text")]
            if not isinstance(lines, list):
                return "Bad input.", 400
            for text in lines:
                if q.qsize() >= MAX_QUEUED:
                    return "Too much input is waiting.", 429
                q.put(str(text if text is not None else "")[:MAX_LINE])
        elif op in ("eof", "close"):
            q.put(None)                       # wakes a waiting read: end of input
            if op == "close":
                del _chans[chan]
        else:
            return "Unknown operation.", 400
    return None, 200


def get(handler, qs):
    """GET /api/stdin?chan=...: wait for the next line (200), the end of input
    (204) or nothing yet (408: ask again)."""
    chan = (qs.get("chan") or [""])[0]
    with _lock:
        ch = _chans.get(chan) if _CHAN.fullmatch(chan) else None
    if ch is None:
        return handler.reply(404, {"error": "Unknown channel."})
    try:
        item = ch["q"].get(timeout=WAIT)
    except queue.Empty:
        handler.send_response(408)
        handler.send_header("Content-Length", "0")
        handler.send_header("Cache-Control", "no-store")
        return handler.end_headers()
    if item is None:
        ch["q"].put(None)                     # the end stays the end
        handler.send_response(204)
        handler.send_header("Cache-Control", "no-store")
        return handler.end_headers()
    data = (item + "\n").encode()
    handler.send_response(200)
    handler.send_header("Content-Type", "text/plain; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    try:
        handler.wfile.write(data)
    except OSError:
        pass
