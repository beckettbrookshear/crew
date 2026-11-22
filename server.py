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
  * share files with everyone, or privately with one person
  * see each computer's processor details and speed score
  * split a computing job into pieces that run on every computer
    that has opted in as a "helper", then combine the results
"""
import hashlib
import hmac
import ipaddress
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
from urllib.parse import parse_qs, quote, urlparse

MAX_PEERS = 12           # computers per group
GRACE_SECONDS = 30       # a dropped computer keeps its seat this long
TASK_TIMEOUT = 180       # seconds before a stuck task is handed to someone else
MAX_TASKS = 5000         # pieces per job
MAX_CODE = 100_000       # characters of job code
MAX_BODY = 4_000_000     # bytes per request
PING_EVERY = 15          # keep-alive interval for the live stream
MAX_FILE = 25_000_000    # bytes per shared file
MAX_GROUP_FILES = 250_000_000   # bytes of shared files per group (kept in memory)
MAX_FILE_COUNT = 200     # shared files per group
LIST_DELAY = 0.2         # computer/job lists go out at most this often
ALERT_COOLDOWN = 60      # the same alert about the same person repeats at most this often
STATIC = {"/prefs.css": "text/css; charset=utf-8",
          "/prefs.js": "text/javascript; charset=utf-8"}

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PORT", 8000))

lock = threading.RLock()
rooms = {}
lists_changed = threading.Event()        # wakes the announcer thread


def now():
    return time.time()


def encode(msg):
    """Turn a message into a ready-to-send live-stream event, once.
    Returns (type, bytes) so a broadcast is encoded once for everyone."""
    data = json.dumps(msg, separators=(",", ":")).encode()
    return msg.get("type"), b"data: " + data + b"\n\n"


def clean_room(s):
    return re.sub(r"[^a-z0-9_-]", "", str(s or "").strip().lower())[:32]


def hash_pw(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000)


def clean_name(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()[:24]


def clean_filename(s):
    s = re.sub(r"[\x00-\x1f\x7f/\\]", "_", str(s or "")).strip()[:120]
    return "file" if s in ("", ".", "..") else s


def clean_text(s, n):
    return re.sub(r"[\x00-\x1f\x7f]", "", str(s or "")).strip()[:n]


def clean_specs(s):
    """Keep only the processor details we know how to show."""
    if not isinstance(s, dict):
        return None
    out = {}
    for k, cap in (("cores", 1024), ("memory", 4096), ("score", 10 ** 9)):
        try:
            v = float(s.get(k))
        except (TypeError, ValueError):
            continue
        if 0 < v <= cap:
            out[k] = round(v) if k != "memory" else round(v, 2)
    for k, n in (("arch", 24), ("platform", 40), ("gpu", 120), ("browser", 40)):
        v = clean_text(s.get(k), n)
        if v:
            out[k] = v
    return out or None


# ---- suspicious-activity checks ---------------------------------------
# Simple pattern rules. They catch common tricks, not everything, and can
# raise false alarms; alerts go only to the group owner to judge.
EXE_LINK = re.compile(
    r"https?://\S+?\.(exe|msi|bat|cmd|scr|pif|ps1|vbs|vbe|wsf|hta|jar|apk|"
    r"dmg|pkg|deb|rpm|appimage|run|lnk|iso)(?=$|[\s?#\"')\]])", re.I)
IP_LINK = re.compile(r"https?://(\d{1,3}(?:\.\d{1,3}){3})", re.I)
SHORT_LINK = re.compile(r"\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|"
                        r"cutt\.ly|rb\.gy|ow\.ly|shorturl\.at|tiny\.cc)/\S+",
                        re.I)
PIPE_SHELL = re.compile(r"\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?"
                        r"(?:ba|z|da)?sh\b", re.I)
ASK_SECRET = re.compile(
    r"\b(?:send|give|tell|share|type|enter|need|dm|what'?s|whats|post)\b"
    r"[^.?!\n]{0,40}\b(?:password|passcode|pin|login|log-?in|"
    r"verification code|security code|2fa|one[- ]time code|otp|"
    r"credit card|card number|cvv|social security|ssn|bank account|"
    r"seed phrase|recovery phrase)\b", re.I)
CODE_CHECKS = [
    (re.compile(r"\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|"
                r"importScripts|sendBeacon|RTCPeerConnection)\b"),
     "medium", "contacts other computers or the internet"),
    (re.compile(r"\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(\s*['\"`]|"
                r"\bset(?:Timeout|Interval)\s*\(\s*['\"`]"),
     "high", "builds and runs hidden code (eval or new Function)"),
    (re.compile(r"\batob\s*\(|String\.fromCharCode|(?:\\x[0-9a-fA-F]{2}){8,}|"
                r"[A-Za-z0-9+/=]{300,}"),
     "medium", "contains scrambled or encoded text that hides what it does"),
    (re.compile(r"coinhive|cryptonight|stratum\+tcp|monero|\bxmr\b|randomx|"
                r"webminer|cryptoloot|hashrate", re.I),
     "high", "looks like cryptocurrency mining"),
]


def is_public_ip(s):
    try:
        return ipaddress.ip_address(s).is_global
    except ValueError:
        return False


def scan_text(text):
    """Returns [(level, what they did, excerpt)] for chat and notes."""
    found = []
    m = EXE_LINK.search(text)
    if m:
        found.append(("high", f"posted a link to a program file "
                              f"(.{m.group(1).lower()})", m.group(0)))
    for m in IP_LINK.finditer(text):
        if is_public_ip(m.group(1)):
            found.append(("medium", "posted a link to a bare internet "
                                    "address instead of a website name",
                          m.group(0)))
            break
    m = SHORT_LINK.search(text)
    if m:
        found.append(("low", "posted a shortened link that hides where it "
                             "goes", m.group(0)))
    m = PIPE_SHELL.search(text)
    if m:
        found.append(("high", "posted a command that downloads and runs a "
                              "script", m.group(0)))
    m = ASK_SECRET.search(text)
    if m:
        found.append(("medium", "may be asking for a password, code or "
                                "card details", m.group(0)))
    return found


def scan_code(code):
    """Returns [(level, what the code does, excerpt)] for job code."""
    out = []
    for rx, level, why in CODE_CHECKS:
        m = rx.search(code)
        if m:
            out.append((level, why, m.group(0)[:80]))
    return out


def human_size(n):
    for unit in ("bytes", "KB", "MB"):
        if n < 1000 or unit == "MB":
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1000


class SharedFile:
    def __init__(self, owner, name, data, to=None):
        self.id = secrets.token_hex(6)
        self.owner, self.owner_name = owner.id, owner.name
        self.to = to.id if to else None
        self.to_name = to.name if to else None
        self.name = name
        self.data = data
        self.size = len(data)
        self.ts = now() * 1000

    def visible_to(self, pid):
        return self.to is None or pid in (self.to, self.owner)

    def info(self, room):
        return {"id": self.id, "name": self.name, "size": self.size,
                "ts": self.ts, "owner": self.owner,
                "ownerName": self.owner_name,
                "ownerHere": self.owner in room.peers,
                "to": self.to, "toName": self.to_name}


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
        self.specs = None            # processor details, if shared
        self.device = ""             # random id the browser keeps (for removals)
        self.joined = now()

    def send(self, msg):
        self.q.put(msg if isinstance(msg, tuple) else encode(msg))

    def info(self):
        return {"id": self.id, "name": self.name, "online": self.online,
                "worker": self.worker, "slots": self.slots,
                "completed": self.completed, "specs": self.specs}


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
        self.running = 0                 # tasks currently out with helpers
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
                "running": self.running}


class Room:
    def __init__(self, name):
        self.name = name
        self.peers = {}
        self.notes = ""
        self.notes_by = ""
        self.jobs = {}
        self.job_seq = 0
        self.pw_salt = b""
        self.pw_hash = b""                    # empty = no password
        self.files = {}
        self.file_bytes = 0
        self.assigned = {}                    # peer id -> {(job id, task)} running there
        self.dirty = set()                    # lists to re-send: "peers", "jobs"
        # owner + suspicious-activity alerts
        self.owner = None                     # peer id of the group owner
        self.alerts = deque(maxlen=100)
        self.alert_seq = 0
        self.cooldown = {}                    # alert key -> last time sent
        self.counters = {}                    # rate-check key -> deque of times
        self.banned = set()                   # device ids the owner removed
        self.notes_backup = None              # notes before a mass deletion

    # ---- owner alerts ----------------------------------------------
    def rate(self, key, window, limit):
        """Count an event; True when more than `limit` happened in `window` s."""
        q = self.counters.setdefault(key, deque())
        t = now()
        q.append(t)
        while q and t - q[0] > window:
            q.popleft()
        return len(q) > limit

    def alert(self, area, level, text, who=None, excerpt="", **extra):
        """Tell the group owner about something suspicious."""
        if who is not None and who.id == self.owner:
            return                            # don't alert owners about themselves
        key = (area, who.id if who else None, text)
        if now() - self.cooldown.get(key, 0) < ALERT_COOLDOWN:
            return
        self.cooldown[key] = now()
        self.alert_seq += 1
        a = {"id": self.alert_seq, "ts": now() * 1000, "area": area,
             "level": level, "text": text,
             "who": who.id if who else None,
             "whoName": who.name if who else None,
             "excerpt": str(excerpt)[:300], **extra}
        self.alerts.append(a)
        owner = self.peers.get(self.owner)
        if owner:
            owner.send({"type": "alert", "alert": a})

    def set_owner(self, peer):
        self.owner = peer.id if peer else None
        if peer:
            peer.send({"type": "alerts", "alerts": list(self.alerts)})
        self.announce_peers()

    # ---- messaging -------------------------------------------------
    def broadcast(self, msg, exclude=None):
        data = encode(msg)                    # encode once for everyone
        for p in self.peers.values():
            if p.id != exclude:
                p.send(data)

    def system(self, text, only=None):
        msg = {"type": "chat", "system": True, "text": text,
               "ts": now() * 1000}
        if only is None:
            self.broadcast(msg)
        else:
            only.send(msg)

    # ---- shared files ----------------------------------------------
    def file_list(self, pid):
        return [f.info(self) for f in self.files.values() if f.visible_to(pid)]

    def files_msg(self, pid):
        return {"type": "files", "files": self.file_list(pid),
                "used": self.file_bytes, "quota": MAX_GROUP_FILES,
                "max": MAX_FILE}

    def announce_files(self):
        for p in self.peers.values():
            p.send(self.files_msg(p.id))

    def check_upload(self, size, to):
        """Returns (error, recipient)."""
        target = None
        if to:
            target = self.peers.get(to)
            if not target:
                return "That person is no longer here.", None
        if len(self.files) >= MAX_FILE_COUNT:
            return (f"The group already has {MAX_FILE_COUNT} files. "
                    "Delete some first."), None
        if self.file_bytes + size > MAX_GROUP_FILES:
            return ("Not enough group storage left. "
                    "Delete some files first."), None
        return None, target

    def add_file(self, peer, name, data, target):
        f = SharedFile(peer, name, data, target)
        self.files[f.id] = f
        self.file_bytes += f.size
        label = f"{name} ({human_size(f.size)})"
        if target:
            self.system(f"{peer.name} sent you a file: {label}", only=target)
            if target is not peer:
                self.system(f"You sent {target.name} a file: {label}",
                            only=peer)
        else:
            self.system(f"{peer.name} shared a file: {label}")
        self.announce_files()
        return f

    def drop_file(self, f):
        if self.files.pop(f.id, None):
            self.file_bytes -= f.size

    def peer_list(self):
        return [{**p.info(), "owner": p.id == self.owner}
                for p in self.peers.values()]

    def job_list(self):
        return [j.summary(self) for j in self.jobs.values()]

    # The computer and job lists are full snapshots, so when they change many
    # times in a moment (e.g. helpers finishing pieces) only the latest one
    # matters. Mark them changed; the announcer thread sends them out.
    def announce_peers(self):
        self.dirty.add("peers")
        lists_changed.set()

    def announce_jobs(self):
        self.dirty.add("jobs")
        lists_changed.set()

    def flush(self):
        """Send any changed lists now (call with the lock held)."""
        if "peers" in self.dirty:
            self.broadcast({"type": "peers", "peers": self.peer_list()})
        if "jobs" in self.dirty:
            self.broadcast({"type": "jobs", "jobs": self.job_list()})
        self.dirty.clear()

    # ---- distributed jobs ------------------------------------------
    def load(self, pid):
        return len(self.assigned.get(pid, ()))

    def start_task(self, job, i, pid):
        job.tasks[i].update(state="running", worker=pid, started=now())
        job.tasks[i].setdefault("tried", set()).add(pid)   # everyone ever given it
        job.running += 1
        self.assigned.setdefault(pid, set()).add((job.id, i))

    def stop_task(self, job, i):
        """Free the helper slot a running task holds (state is set by caller)."""
        t = job.tasks[i]
        if t["state"] == "running":
            job.running -= 1
            self.assigned.get(t["worker"], set()).discard((job.id, i))

    def requeue_task(self, job, i):
        t = job.tasks[i]
        if t["state"] == "running":
            self.stop_task(job, i)
            t.update(state="pending", worker=None, started=0)
            if job.state == "running":
                job.pending.appendleft(i)

    def requeue_worker(self, pid):
        for jid, i in list(self.assigned.get(pid, ())):
            job = self.jobs.get(jid)
            if job:
                self.requeue_task(job, i)
        self.assigned.pop(pid, None)

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
                self.start_task(job, i, p.id)
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

    def remove_peer(self, peer, reason=None):
        self.peers.pop(peer.id, None)
        for key in [k for k in self.counters if k[0] == peer.id]:
            del self.counters[key]
        peer.q.put(None)                     # close its live stream
        self.requeue_worker(peer.id)
        for j in self.jobs.values():
            if j.owner == peer.id and j.state == "running":
                j.state = "cancelled"
                j.pending.clear()
        for f in list(self.files.values()):   # nobody left to receive these
            if f.to == peer.id:
                self.drop_file(f)
        self.system(reason or f"{peer.name} left.")
        if self.owner == peer.id:             # hand ownership to the longest member
            heir = min(self.peers.values(), key=lambda p: p.joined, default=None)
            self.set_owner(heir)
            if heir:
                self.system(f"{heir.name} is now the group owner.")
        self.announce_peers()
        self.announce_jobs()
        self.announce_files()
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
        if room.rate((peer.id, "chat"), 10, 8):
            room.alert("Chat", "medium", "is flooding the chat (more than 8 "
                       "messages in 10 seconds)", peer, text)
        for level, why, ex in scan_text(text):
            room.alert("Chat", level, why + (" in a private message" if to
                                             else ""), peer, ex)
        if to:
            target = room.peers.get(to)
            if not target:
                return "That person is no longer here."
            out.update(to=target.id, toName=target.name)
            q = room.counters.setdefault((peer.id, "dm"), deque())
            q.append((now(), target.id))
            while q and now() - q[0][0] > 60:
                q.popleft()
            if len({pid for _, pid in q}) >= 5:
                room.alert("Chat", "medium", "sent private messages to 5 or "
                           "more people within a minute", peer, text)
            target.send(out)
            if target is not peer:
                peer.send(out)
        else:
            room.broadcast(out)
        return None

    if kind == "notes":
        old, new = room.notes, str(m.get("text", ""))[:200_000]
        if len(old) >= 200 and len(new) < len(old) * 0.3:
            room.notes_backup = old           # the owner can put it back
            room.alert("Shared notes", "medium",
                       f"deleted most of the shared notes ({len(old):,} → "
                       f"{len(new):,} characters)", peer, old[:200],
                       restore=True)
        seen = {why for _, why, _ in scan_text(old)}
        for level, why, ex in scan_text(new):
            if why not in seen:               # only newly added problems
                room.alert("Shared notes", level,
                           why.replace("posted", "added"), peer, ex)
        room.notes = new
        room.notes_by = peer.name
        room.broadcast({"type": "notes", "text": room.notes,
                        "byName": peer.name}, exclude=peer.id)
        return None

    if kind == "specs":
        peer.specs = clean_specs(m.get("specs"))
        room.announce_peers()
        return None

    if kind == "delete_file":
        f = room.files.get(str(m.get("file")))
        if not f or not f.visible_to(peer.id):
            return None
        if f.owner != peer.id and f.owner in room.peers:
            return "Only the person who shared a file can delete it."
        room.drop_file(f)
        room.announce_files()
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
        if room.rate((peer.id, "job"), 60, 5):
            room.alert("Work together", "medium", "started more than 5 jobs "
                       "in a minute", peer, title)
        for level, why, ex in scan_code(code + "\n" + combine):
            room.alert("Work together", level, f'started job "{title}", which '
                       f'{why}', peer, ex, job=job.id)
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
        if t["worker"] != peer.id and peer.id not in t.get("tried", ()):
            room.alert("Work together", "high", f'sent an answer for a piece '
                       f'of job "{job.title}" it was never given (ignored)',
                       peer, json.dumps(m.get("value"))[:200])
            return None
        if m.get("needCode"):
            job.code_sent.discard(peer.id)
            room.requeue_task(job, i)
            room.schedule()
            return None
        if job.state != "running" or t["state"] == "done":
            if t["state"] == "running":      # job was cancelled: free the slot now
                room.stop_task(job, i)
                t["state"] = "pending"
                room.announce_jobs()
                room.schedule()
            return None                      # late duplicate
        room.stop_task(job, i)
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
        if job.owner != peer.id and not (kind == "cancel"
                                         and peer.id == room.owner):
            return "Only the person who started a job can do that."
        if kind == "cancel" and job.state == "running":
            job.state = "cancelled"
            job.pending.clear()
            room.system(f'{peer.name} cancelled job "{job.title}".')
        elif kind == "dismiss" and job.state != "running":
            for i in range(len(job.tasks)):  # free slots of pieces still out
                room.stop_task(job, i)
            del room.jobs[job.id]
        room.announce_jobs()
        return None

    # ---- group owner actions ------------------------------------------
    if kind in ("kick", "set_password", "restore_notes", "clear_alerts"):
        if peer.id != room.owner:
            return "Only the group owner can do that."

    if kind == "kick":
        target = room.peers.get(str(m.get("peer")))
        if not target:
            return "That person already left."
        if target is peer:
            return "You can't remove yourself. Use Leave instead."
        if target.device:
            room.banned.add(target.device)
        target.send({"type": "kicked"})
        room.remove_peer(target, f"{target.name} was removed by the group "
                                 f"owner.")
        return None

    if kind == "set_password":
        password = str(m.get("password") or "")[:128]
        if password:
            room.pw_salt = secrets.token_bytes(16)
            room.pw_hash = hash_pw(password, room.pw_salt)
            room.system("The group owner changed the group password.")
        else:
            room.pw_salt = room.pw_hash = b""
            room.system("The group owner removed the group password. "
                        "Anyone with the group code can join.")
        room.broadcast({"type": "locked", "locked": bool(room.pw_hash)})
        return None

    if kind == "restore_notes":
        if room.notes_backup is None:
            return "There are no deleted notes to restore."
        room.notes, room.notes_backup = room.notes_backup, None
        room.notes_by = f"{peer.name} (restored)"
        room.broadcast({"type": "notes", "text": room.notes,
                        "byName": room.notes_by})
        room.system("The group owner restored the shared notes.")
        return None

    if kind == "clear_alerts":
        room.alerts.clear()
        peer.send({"type": "alerts", "alerts": []})
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
                for running in list(room.assigned.values()):
                    for jid, i in list(running):
                        j = room.jobs.get(jid)
                        if j is None:
                            running.discard((jid, i))
                        elif now() - j.tasks[i]["started"] > TASK_TIMEOUT:
                            room.requeue_task(j, i)
                            stuck = True
                if stuck:
                    room.schedule()
                if not room.peers:
                    del rooms[rname]


def announcer():
    """Send changed computer/job lists, batching bursts of changes."""
    while True:
        lists_changed.wait()
        time.sleep(LIST_DELAY)                # let a burst of changes collect
        with lock:
            lists_changed.clear()
            for room in rooms.values():
                room.flush()


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
        elif u.path in STATIC:
            with open(os.path.join(HERE, u.path.lstrip("/")), "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", STATIC[u.path])
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        elif u.path == "/api/events":
            self.events(parse_qs(u.query))
        elif u.path == "/api/file":
            self.download(parse_qs(u.query))
        else:
            self.reply(404, {"error": "Not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/upload":
            return self.upload(parse_qs(u.query))
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

    # ---- shared files ------------------------------------------------
    def upload(self, qs):
        """POST /api/upload?room&id&token&name&to  (body = the raw file)."""
        g = lambda k: (qs.get(k) or [""])[0]
        try:
            n = int(self.headers.get("Content-Length", ""))
        except ValueError:
            n = -1
        with lock:
            room, peer = self.auth(g("room"), g("id"), g("token"))
            code, err = 200, None
            if not peer:
                code, err = 401, "Not in this group (seat expired)."
            elif n < 0:
                code, err = 411, "Missing file size."
            elif n > MAX_FILE:
                code, err = 413, (f"Files can be up to "
                                  f"{human_size(MAX_FILE)}.")
            else:
                err, _ = room.check_upload(n, g("to"))
                code = 409 if err else 200
        if err:
            self.close_connection = True      # don't bother reading the body
            return self.reply(code, {"error": err})

        try:                                  # read without holding the lock
            chunks, left = [], n
            while left > 0:
                c = self.rfile.read(min(left, 1 << 20))
                if not c:
                    return                    # uploader gave up
                chunks.append(c)
                left -= len(c)
        except OSError:
            return

        with lock:                            # re-check: things may have changed
            room, peer = self.auth(g("room"), g("id"), g("token"))
            if not peer:
                return self.reply(401, {"error": "Not in this group "
                                                 "(seat expired)."})
            err, target = room.check_upload(n, g("to"))
            if err:
                return self.reply(409, {"error": err})
            f = room.add_file(peer, clean_filename(g("name")),
                              b"".join(chunks), target)
        self.reply(200, {"ok": True, "id": f.id})

    def download(self, qs):
        """GET /api/file?room&id&token&file"""
        g = lambda k: (qs.get(k) or [""])[0]
        with lock:
            room, peer = self.auth(g("room"), g("id"), g("token"))
            if not peer:
                return self.reply(401, {"error": "Seat expired."})
            f = room.files.get(g("file"))
            if not f or not f.visible_to(peer.id):
                return self.reply(404, {"error": "That file is gone."})
            name, data = f.name, f.data
        ascii_name = re.sub(r'[^A-Za-z0-9._ -]', "_", name)
        self.send_response(200)
        # Always a download, never rendered: shared files can't run as pages.
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition",
                         f'attachment; filename="{ascii_name}"; '
                         f"filename*=UTF-8''{quote(name, safe='')}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except OSError:
            pass

    def join(self, body):
        name, rname = clean_name(body.get("name")), clean_room(body.get("room"))
        if not name:
            return self.reply(400, {"error": "Please enter your name."})
        if not rname:
            return self.reply(400, {"error": "Group code can use letters, "
                                             "numbers, - and _."})
        password = str(body.get("password") or "")[:128]
        wrong = False
        with lock:
            room = rooms.get(rname)
            if room is None:                  # first person sets the password
                room = rooms[rname] = Room(rname)
                if password:
                    room.pw_salt = secrets.token_bytes(16)
                    room.pw_hash = hash_pw(password, room.pw_salt)
            elif room.pw_hash:
                wrong = not hmac.compare_digest(
                    room.pw_hash, hash_pw(password, room.pw_salt))
        if wrong:
            with lock:
                key = ("join-fail",)
                if room.rate(key, 120, 2):
                    room.alert("Joining", "medium",
                               "Someone keeps entering a wrong group "
                               "password", None,
                               f"{len(room.counters[key])} wrong tries in "
                               f'2 minutes. Last name they typed: "{name}"')
            time.sleep(1)                     # slow down password guessing
            return self.reply(403, {"error": "Wrong password for this group."
                                    if password else
                                    "This group needs a password."})
        with lock:
            if rooms.get(rname) is not room:  # group emptied meanwhile
                return self.reply(409, {"error": "Please try again."})
            device = clean_text(body.get("device"), 64)
            if device and device in room.banned:
                room.alert("Joining", "high", f'A computer the owner removed '
                           f'tried to rejoin as "{name}"')
                return self.reply(403, {"error": "You were removed from this "
                                                 "group."})
            if len(room.peers) >= MAX_PEERS:
                return self.reply(409, {"error": f"That group is full "
                                                 f"({MAX_PEERS} computers)."})
            taken = {p.name.lower() for p in room.peers.values()}
            base, n = name, 2
            while name.lower() in taken:
                name, n = f"{base} {n}", n + 1
            peer = Peer(name)
            peer.device = device
            room.peers[peer.id] = peer
            room.system(f"{name} joined.")
            if room.owner not in room.peers:  # first in = group owner
                room.set_owner(peer)
            out = {"room": rname, "id": peer.id, "token": peer.token,
                   "name": name, "locked": bool(room.pw_hash)}
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
            q.put(encode({"type": "welcome", "you": peer.info(),
                          "room": room.name, "locked": bool(room.pw_hash),
                          "max": MAX_PEERS, "peers": room.peer_list(),
                          "notes": room.notes, "notesBy": room.notes_by,
                          "jobs": room.job_list(), "owner": room.owner,
                          "alerts": list(room.alerts)
                          if peer.id == room.owner else []}))
            q.put(encode(room.files_msg(peer.id)))
            while True:                       # carry over undelivered messages
                try:
                    m = old.get_nowait()
                except queue.Empty:
                    break
                if m is not None and m[0] not in ("peers", "jobs", "files"):
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
                self.wfile.write(m[1])        # already encoded
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
    threading.Thread(target=announcer, daemon=True).start()
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
