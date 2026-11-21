#!/usr/bin/env python3
"""
CREW (Collaborative Resource Exchange Web) - link up to 12 computers through a web page.

Zero dependencies (Python 3.8+ standard library only).

    python3 server.py            # serves on port 8000
    python3 server.py 9000       # or pick a port

Then on every computer, open  http://<this-computer's-IP>:8000
and join the same group code.

What the connected computers can do together:
  * see who is online
  * chat with everyone, or privately with one person
  * edit one shared notepad
  * split a computing job into pieces that run on every computer
    that has opted in as a "helper", then combine the results
"""
import json
import os
import queue
import re
import secrets
import socket
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MAX_PEERS = 12           # computers per group
GRACE_SECONDS = 30       # a dropped computer keeps its seat this long
TASK_TIMEOUT = 180       # seconds before a stuck task is handed to someone else
MAX_TASKS = 5000         # pieces per job
MAX_CODE = 100_000       # characters of job code
MAX_BODY = 4_000_000     # bytes per request
PING_EVERY = 15          # keep-alive interval for the live stream

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PORT", 8000))

lock = threading.RLock()
rooms = {}


def now():
    return time.time()


def clean_room(s):
    return re.sub(r"[^a-z0-9_-]", "", str(s or "").strip().lower())[:32]


def clean_name(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()[:24]


class Peer:
    def __init__(self, name):
        self.id = secrets.token_hex(4)
        self.token = secrets.token_urlsafe(18)
        self.name = name
        self.q = queue.Queue()
        self.stream = 0              # increments on every (re)connect
        self.online = False
        self.offline_since = now()
        self.worker = False
        self.slots = 1
        self.completed = 0

    def send(self, msg):
        self.q.put(msg)

    def info(self):
        return {"id": self.id, "name": self.name, "online": self.online,
                "worker": self.worker, "slots": self.slots,
                "completed": self.completed}


class Job:
    def __init__(self, jid, owner, title, code, combine, inputs):
        self.id = jid
        self.owner = owner
        self.title = title
        self.code = code
        self.combine = combine
        self.inputs = inputs
        self.tasks = [{"state": "pending", "worker": None, "started": 0}
                      for _ in inputs]
        self.pending = deque(range(len(inputs)))
        self.results = [None] * len(inputs)
        self.done = 0
        self.errors = 0
        self.code_sent = set()
        self.state = "running"
        self.created = now()

    def summary(self, room):
        owner = room.peers.get(self.owner)
        return {"id": self.id, "title": self.title, "owner": self.owner,
                "ownerName": owner.name if owner else "(left)",
                "total": len(self.tasks), "done": self.done,
                "errors": self.errors, "state": self.state,
                "running": sum(1 for t in self.tasks if t["state"] == "running")}


class Room:
    def __init__(self, name):
        self.name = name
        self.peers = {}
        self.notes = ""
        self.notes_by = ""
        self.jobs = {}
        self.job_seq = 0

    # ---- messaging -------------------------------------------------
    def broadcast(self, msg, exclude=None):
        for p in self.peers.values():
            if p.id != exclude:
                p.send(msg)

    def system(self, text):
        self.broadcast({"type": "chat", "system": True, "text": text,
                        "ts": now() * 1000})

    def peer_list(self):
        return [p.info() for p in self.peers.values()]

    def job_list(self):
        return [j.summary(self) for j in self.jobs.values()]

    def announce_peers(self):
        self.broadcast({"type": "peers", "peers": self.peer_list()})

    def announce_jobs(self):
        self.broadcast({"type": "jobs", "jobs": self.job_list()})

    # ---- distributed jobs ------------------------------------------
    def load(self, pid):
        return sum(1 for j in self.jobs.values() for t in j.tasks
                   if t["state"] == "running" and t["worker"] == pid)

    def requeue_task(self, job, i):
        t = job.tasks[i]
        if t["state"] == "running":
            t.update(state="pending", worker=None, started=0)
            job.pending.appendleft(i)

    def requeue_worker(self, pid):
        for j in self.jobs.values():
            for i, t in enumerate(j.tasks):
                if t["state"] == "running" and t["worker"] == pid:
                    self.requeue_task(j, i)

    def schedule(self):
        workers = [p for p in self.peers.values() if p.online and p.worker]
        if not workers:
            return
        load = {p.id: self.load(p.id) for p in workers}
        changed = False
        for job in sorted(self.jobs.values(), key=lambda j: j.created):
            if job.state != "running":
                continue
            while job.pending:
                free = [p for p in workers if load[p.id] < p.slots]
                if not free:
                    break
                i = job.pending.popleft()
                t = job.tasks[i]
                if t["state"] != "pending":
                    continue
                p = min(free, key=lambda p: load[p.id] / p.slots)
                t.update(state="running", worker=p.id, started=now())
                load[p.id] += 1
                msg = {"type": "task", "job": job.id, "task": i,
                       "input": job.inputs[i]}
                if p.id not in job.code_sent:
                    msg["code"] = job.code
                    job.code_sent.add(p.id)
                p.send(msg)
                changed = True
        if changed:
            self.announce_jobs()

    def finish(self, job):
        job.state = "done"
        owner = self.peers.get(job.owner)
        if owner:
            owner.send({"type": "job_done", "job": job.id, "title": job.title,
                        "results": job.results, "inputs": job.inputs,
                        "combine": job.combine, "errors": job.errors})
        self.system(f'Job "{job.title}" finished '
                    f'({len(job.tasks)} pieces, {job.errors} errors).')

    def remove_peer(self, peer):
        self.peers.pop(peer.id, None)
        peer.q.put(None)                     # close its live stream
        self.requeue_worker(peer.id)
        for j in self.jobs.values():
            if j.owner == peer.id and j.state == "running":
                j.state = "cancelled"
                j.pending.clear()
        self.system(f"{peer.name} left.")
        self.announce_peers()
        self.announce_jobs()
        self.schedule()


# ---- message handling ----------------------------------------------
def dispatch(room, peer, m):
    """Handle one message from a computer. Returns an error string or None."""
    kind = m.get("type")

    if kind == "chat":
        text = str(m.get("text", ""))[:4000].strip()
        if not text:
            return "Empty message."
        out = {"type": "chat", "from": peer.id, "fromName": peer.name,
               "text": text, "ts": now() * 1000}
        to = m.get("to")
        if to:
            target = room.peers.get(to)
            if not target:
                return "That person is no longer here."
            out.update(to=target.id, toName=target.name)
            target.send(out)
            if target is not peer:
                peer.send(out)
        else:
            room.broadcast(out)
        return None

    if kind == "notes":
        room.notes = str(m.get("text", ""))[:200_000]
        room.notes_by = peer.name
        room.broadcast({"type": "notes", "text": room.notes,
                        "byName": peer.name}, exclude=peer.id)
        return None

    if kind == "worker":
        peer.worker = bool(m.get("on"))
        try:
            peer.slots = max(1, min(16, int(m.get("slots", 1))))
        except (TypeError, ValueError):
            peer.slots = 1
        room.announce_peers()
        room.schedule()
        return None

    if kind == "job":
        title = str(m.get("title") or "Untitled job").strip()[:80]
        code = str(m.get("code", ""))
        combine = str(m.get("combine") or "")
        inputs = m.get("inputs")
        if not code.strip():
            return "Job needs code with a work() function."
        if len(code) > MAX_CODE or len(combine) > MAX_CODE:
            return "Code is too long."
        if not isinstance(inputs, list) or not inputs:
            return "Inputs must be a non-empty JSON list."
        if len(inputs) > MAX_TASKS:
            return f"Too many pieces (max {MAX_TASKS})."
        room.job_seq += 1
        job = Job(str(room.job_seq), peer.id, title, code, combine, inputs)
        room.jobs[job.id] = job
        room.system(f'{peer.name} started job "{title}" '
                    f'with {len(inputs)} pieces.')
        room.announce_jobs()
        room.schedule()
        if not any(p.worker and p.online for p in room.peers.values()):
            peer.send({"type": "chat", "system": True, "ts": now() * 1000,
                       "text": "Nobody is helping yet. The job will start "
                               "when someone turns on \"Help with jobs\"."})
        return None

    if kind == "result":
        job = room.jobs.get(str(m.get("job")))
        try:
            i = int(m.get("task"))
        except (TypeError, ValueError):
            return "Bad task number."
        if not job or not 0 <= i < len(job.tasks):
            return None                      # job gone; ignore quietly
        t = job.tasks[i]
        if m.get("needCode"):
            job.code_sent.discard(peer.id)
            room.requeue_task(job, i)
            room.schedule()
            return None
        if job.state != "running" or t["state"] == "done":
            return None                      # late duplicate
        t.update(state="done", worker=peer.id)
        job.done += 1
        peer.completed += 1
        if m.get("ok"):
            job.results[i] = m.get("value")
        else:
            job.results[i] = {"error": str(m.get("error", "failed"))[:1000]}
            job.errors += 1
        if job.done == len(job.tasks):
            room.finish(job)
        room.announce_jobs()
        room.announce_peers()
        room.schedule()
        return None

    if kind in ("cancel", "dismiss"):
        job = room.jobs.get(str(m.get("job")))
        if not job:
            return None
        if job.owner != peer.id:
            return "Only the person who started a job can do that."
        if kind == "cancel" and job.state == "running":
            job.state = "cancelled"
            job.pending.clear()
            room.system(f'{peer.name} cancelled job "{job.title}".')
        elif kind == "dismiss" and job.state != "running":
            del room.jobs[job.id]
        room.announce_jobs()
        return None

    return f"Unknown message type: {kind!r}"


def reaper():
    """Remove computers that have been gone too long; retry stuck tasks."""
    while True:
        time.sleep(5)
        with lock:
            for rname, room in list(rooms.items()):
                for p in list(room.peers.values()):
                    if not p.online and now() - p.offline_since > GRACE_SECONDS:
                        room.remove_peer(p)
                stuck = False
                for j in room.jobs.values():
                    for i, t in enumerate(j.tasks):
                        if (t["state"] == "running"
                                and now() - t["started"] > TASK_TIMEOUT):
                            room.requeue_task(j, i)
                            stuck = True
                if stuck:
                    room.schedule()
                if not room.peers:
                    del rooms[rname]


# ---- HTTP ------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "CREW/1.0"

    def log_message(self, fmt, *args):
        pass                                  # keep the console quiet

    def reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def auth(self, rname, pid, token):
        room = rooms.get(clean_room(rname))
        peer = room.peers.get(str(pid)) if room else None
        if not peer or not secrets.compare_digest(peer.token, str(token or "")):
            return None, None
        return room, peer

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        elif u.path == "/api/events":
            self.events(parse_qs(u.query))
        else:
            self.reply(404, {"error": "Not found"})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > MAX_BODY:
                return self.reply(413, {"error": "Message too large."})
            body = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self.reply(400, {"error": "Bad JSON."})

        path = urlparse(self.path).path
        if path == "/api/join":
            return self.join(body)

        with lock:
            room, peer = self.auth(body.get("room"), body.get("id"),
                                   body.get("token"))
            if not peer:
                err, code = "Not in this group (seat expired).", 401
            elif path == "/api/leave":
                room.remove_peer(peer)
                err, code = None, 200
            elif path == "/api/send":
                msg = body.get("msg")
                err = dispatch(room, peer, msg if isinstance(msg, dict) else {})
                code = 400 if err else 200
            else:
                err, code = "Not found", 404
        self.reply(code, {"error": err} if err else {"ok": True})

    def join(self, body):
        name, rname = clean_name(body.get("name")), clean_room(body.get("room"))
        if not name:
            return self.reply(400, {"error": "Please enter your name."})
        if not rname:
            return self.reply(400, {"error": "Group code can use letters, "
                                             "numbers, - and _."})
        with lock:
            room = rooms.setdefault(rname, Room(rname))
            if len(room.peers) >= MAX_PEERS:
                return self.reply(409, {"error": f"That group is full "
                                                 f"({MAX_PEERS} computers)."})
            taken = {p.name.lower() for p in room.peers.values()}
            base, n = name, 2
            while name.lower() in taken:
                name, n = f"{base} {n}", n + 1
            peer = Peer(name)
            room.peers[peer.id] = peer
            room.system(f"{name} joined.")
            out = {"room": rname, "id": peer.id, "token": peer.token,
                   "name": name}
        self.reply(200, out)

    def events(self, qs):
        """Server-Sent Events stream: the live feed for one computer."""
        g = lambda k: (qs.get(k) or [""])[0]
        with lock:
            room, peer = self.auth(g("room"), g("id"), g("token"))
            if not peer:
                return self.reply(401, {"error": "Seat expired."})
            peer.stream += 1
            mine = peer.stream
            was_online = peer.online
            peer.online = True
            old, q = peer.q, queue.Queue()
            q.put({"type": "welcome", "you": peer.info(), "room": room.name,
                   "max": MAX_PEERS, "peers": room.peer_list(),
                   "notes": room.notes, "notesBy": room.notes_by,
                   "jobs": room.job_list()})
            while True:                       # carry over undelivered messages
                try:
                    m = old.get_nowait()
                except queue.Empty:
                    break
                if m is not None and m.get("type") not in ("peers", "jobs"):
                    q.put(m)
            peer.q = q
            old.put(None)                     # end any previous stream
            if not was_online:
                room.announce_peers()
                room.schedule()

        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            self.wfile.write(b"retry: 2000\n\n")
            while True:
                try:
                    m = q.get(timeout=PING_EVERY)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    continue
                if m is None:
                    break
                self.wfile.write(b"data: " + json.dumps(m).encode() + b"\n\n")
        except OSError:
            pass
        finally:
            with lock:
                if peer.stream == mine and room.peers.get(peer.id) is peer:
                    peer.online = False
                    peer.offline_since = now()
                    room.requeue_worker(peer.id)
                    room.announce_peers()
                    room.schedule()


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))     # no packet is actually sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    threading.Thread(target=reaper, daemon=True).start()
    print(f"CREW is running (up to {MAX_PEERS} computers per group).")
    print(f"  On this computer:    http://localhost:{PORT}")
    print(f"  On other computers:  http://{lan_ip()}:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
