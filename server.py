#!/usr/bin/env python3
"""
CREW (Collaborative Resource Exchange Web) - link up to 12 computers through a web page.

Zero dependencies (Python 3.8+ standard library only).

    python3 server.py            # serves on port 8000
    python3 server.py 9000       # or pick a port
    python3 server.py --claude   # also give everyone a Claude Code tab: each
                                 # person signs in with their own Claude account
                                 # and gets their own folder under ~/crew-workspace
                                 # (or --claude FOLDER); see claude_bridge.py

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
import ssl
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

import browse                    # the Browse tab's page fetcher (browse.py)
import claude_bridge             # the Claude Code tab (claude_bridge.py)
import codeshare                 # the Code tab's shared editor (codeshare.py)
import terminal_support          # the Terminal tab: Python files + input (terminal_support.py)
import mail                      # the Mail tab (mail.py)

MAX_PEERS = 12           # computers per group
GRACE_SECONDS = 30       # a dropped computer keeps its seat this long
TASK_TIMEOUT = 180       # seconds before a stuck task is handed to someone else
BACKUP_AFTER = 3         # a piece is never backed up before running this long (s)
BACKUP_SLOW = 1.5        # ...and only once it's this many times slower than usual
BACKUP_NO_DATA = 10      # ...or, before any piece has finished, after this long
MAX_TASKS = 5000         # pieces per job
MAX_CODE = 100_000       # characters of job code
MAX_BODY = 4_000_000     # bytes per request
PING_EVERY = 15          # keep-alive interval for the live stream
MAX_FILE = 25_000_000    # bytes per shared file
MAX_GROUP_FILES = 250_000_000   # bytes of shared files per group (kept in memory)
MAX_FILE_COUNT = 200     # shared files per group
E2E_PREFIX = "e2e1:"     # marks text the browsers encrypted (see e2e.js)
E2E_CHAT_MAX = 24_000    # encrypted chat message (4,000 characters before)
E2E_NOTES_MAX = 1_200_000   # encrypted shared notes (200,000 characters before)
LIST_DELAY = 0.2         # computer/job lists go out at most this often
ALERT_COOLDOWN = 60      # the same alert about the same person repeats at most this often
STATIC = {"/prefs.css": "text/css; charset=utf-8",
          "/prefs.js": "text/javascript; charset=utf-8",
          "/browse.js": "text/javascript; charset=utf-8",
          "/claude.js": "text/javascript; charset=utf-8",
          "/e2e.js": "text/javascript; charset=utf-8",
          "/code.js": "text/javascript; charset=utf-8",
          "/codechat.js": "text/javascript; charset=utf-8",
          "/terminal.js": "text/javascript; charset=utf-8",
          "/mail.js": "text/javascript; charset=utf-8"}

HERE = os.path.dirname(os.path.abspath(__file__))


def parse_args(argv):
    """[port] [--claude [FOLDER]] [--cert FILE --key FILE] [--no-tls]"""
    opts = {"port": os.environ.get("PORT", 8000), "claude": None,
            "cert": None, "key": None, "tls": True}
    i = 0
    while i < len(argv):
        a = argv[i]
        name = a[2:].split("=", 1)[0] if a.startswith("--") else None
        if a == "--claude" and (i + 1 >= len(argv) or argv[i + 1].startswith("--")
                                or argv[i + 1].isdigit()):
            opts["claude"], i = "", i + 1     # no folder given: the default workspace
        elif name in ("claude", "cert", "key"):
            if "=" in a:
                opts[name], i = a.split("=", 1)[1], i + 1
            elif i + 1 < len(argv):
                opts[name], i = argv[i + 1], i + 2
            else:
                sys.exit(f"--{name} needs a value")
        elif a == "--no-tls":
            opts["tls"], i = False, i + 1
        elif name is not None:
            sys.exit(f"Unknown option {a}")
        else:
            opts["port"], i = a, i + 1
    if bool(opts["cert"]) != bool(opts["key"]):
        sys.exit("--cert and --key go together")
    opts["port"] = int(opts["port"])
    return opts


OPTS = parse_args(sys.argv[1:])
PORT, CLAUDE_DIR = OPTS["port"], OPTS["claude"]

# Sent with every response (except Browse pages, which have their own rules).
# They keep CREW's page from loading or sending anything to other sites, from
# being framed by another site, and from leaking its address in Referer.
SECURITY_HEADERS = {
    "Content-Security-Policy":
        # 'wasm-unsafe-eval' lets the Terminal run Python (WebAssembly). It does
        # not allow eval() or new Function().
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
        "worker-src blob:; connect-src 'self'; frame-src 'self'; "
        "object-src 'none'; base-uri 'none'; form-action 'self'; "
        "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), "
                          "payment=(), usb=()",
}

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
        self.meta = ""                       # encrypted real name (e2e.js)

    def visible_to(self, pid):
        return self.to is None or pid in (self.to, self.owner)

    def info(self, room):
        return {"id": self.id, "name": self.name, "size": self.size,
                "ts": self.ts, "owner": self.owner,
                "ownerName": self.owner_name,
                "ownerHere": self.owner in room.peers,
                "to": self.to, "toName": self.to_name, "meta": self.meta}


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
    def __init__(self, jid, owner, title, code, combine, inputs, verify=False):
        self.id = jid
        self.owner = owner
        self.title = title
        self.code = code
        self.combine = combine
        self.inputs = inputs
        self.verify = verify             # every piece needs 2 matching answers
        # runs: helper id -> start time for each copy out now
        # answers: [(helper id, ok, value)] received so far
        # tried: every helper ever given this piece
        self.tasks = [{"state": "pending", "worker": None, "runs": {},
                       "answers": [], "tried": set(), "queued": True}
                      for _ in inputs]
        self.pending = deque(range(len(inputs)))
        self.results = [None] * len(inputs)
        self.running = 0                 # copies currently out with helpers
        self.done = 0
        self.errors = 0
        self.backups = 0                 # slow pieces also sent to a 2nd computer
        self.disagreed = 0               # pieces where computers' answers differed
        self.durations = deque(maxlen=50)   # seconds per successful piece
        self.code_sent = set()
        self.state = "running"
        self.created = now()

    def wanted(self, i):
        """How many more copies of piece i should be sent out right now."""
        t = self.tasks[i]
        if t["state"] == "done" or self.state != "running":
            return 0
        need = 2 if self.verify and not t["answers"] else 1
        return need - len(t["runs"])

    def typical(self):
        """Median seconds a piece of this job takes, or None if unknown."""
        if not self.durations:
            return None
        return sorted(self.durations)[len(self.durations) // 2]

    def summary(self, room):
        owner = room.peers.get(self.owner)
        return {"id": self.id, "title": self.title, "owner": self.owner,
                "ownerName": owner.name if owner else "(left)",
                "total": len(self.tasks), "done": self.done,
                "errors": self.errors, "state": self.state,
                "running": self.running, "verify": self.verify,
                "backups": self.backups, "disagreed": self.disagreed}


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
        self.e2e_wrapped = None               # group key, locked with the password
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
        old = self.owner
        self.owner = peer.id if peer else None
        if peer:
            peer.send({"type": "alerts", "alerts": list(self.alerts)})
        claude_bridge.owner_changed(self, old)
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

    def add_file(self, peer, name, data, target, meta=""):
        f = SharedFile(peer, name, data, target)
        f.meta = meta                         # encrypted real name, if any
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
        return [{**p.info(), "owner": p.id == self.owner,
                 "browsing": browse.peer_info(p)}
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

    def queue(self, job, i, front=False):
        """Put piece i back in line if it still needs a computer."""
        t = job.tasks[i]
        if not t["queued"] and job.wanted(i) > 0:
            t["queued"] = True
            (job.pending.appendleft if front else job.pending.append)(i)

    def start_run(self, job, i, p):
        t = job.tasks[i]
        t["runs"][p.id] = now()
        t["tried"].add(p.id)
        t["state"] = "running"
        job.running += 1
        self.assigned.setdefault(p.id, set()).add((job.id, i))
        msg = {"type": "task", "job": job.id, "task": i,
               "input": job.inputs[i]}
        if p.id not in job.code_sent:
            msg["code"] = job.code
            job.code_sent.add(p.id)
        p.send(msg)

    def stop_run(self, job, i, pid, abort=False):
        """Free the helper slot one copy of piece i holds on computer pid.
        With abort, also tell that computer to stop working on it."""
        t = job.tasks[i]
        self.assigned.get(pid, set()).discard((job.id, i))
        if t["runs"].pop(pid, None) is None:
            return
        job.running -= 1
        if t["state"] == "running" and not t["runs"]:
            t["state"] = "pending"
        p = self.peers.get(pid)
        if abort and p:
            p.send({"type": "abort", "job": job.id, "task": i})

    def stop_all_runs(self, job, i):
        for pid in list(job.tasks[i]["runs"]):
            self.stop_run(job, i, pid, abort=True)

    def requeue_run(self, job, i, pid, abort=False):
        self.stop_run(job, i, pid, abort)
        self.queue(job, i, front=True)

    def requeue_worker(self, pid):
        for jid, i in list(self.assigned.get(pid, ())):
            job = self.jobs.get(jid)
            if job:
                self.requeue_run(job, i, pid)
        self.assigned.pop(pid, None)

    def cancel_job(self, job):
        job.state = "cancelled"
        job.pending.clear()
        for i in range(len(job.tasks)):
            self.stop_all_runs(job, i)       # free every helper slot right away

    def add_answer(self, job, i, peer, ok, value):
        """Record one computer's answer for piece i and decide it if we can."""
        t = job.tasks[i]
        started = t["runs"].get(peer.id)
        self.stop_run(job, i, peer.id)
        if ok and started:
            job.durations.append(now() - started)
        t["answers"].append((peer.id, ok, value))
        answers = t["answers"]

        if not job.verify:
            if not ok and t["runs"]:
                return                       # failed here; another copy is running
            oks = [a for a in answers if a[1]]
            return self.complete(job, i, oks[0] if oks else answers[-1])

        groups = {}                          # identical answers grouped together
        for a in answers:
            key = json.dumps(a[2], sort_keys=True) if a[1] else "error"
            groups.setdefault(key, []).append(a)
        best = max(groups.values(), key=len)
        if len(answers) == 2 and len(best) == 1:
            job.disagreed += 1               # ask a third computer to break the tie
            self.queue(job, i, front=True)
            return
        if len(best) >= 2:
            winner = best[0]
        elif len(answers) >= 3:
            winner = (None, False, {"error": "Computers gave different "
                                             "answers for this piece."})
        else:
            self.queue(job, i, front=True)   # first answer in; wait for a second
            return
        for pid, _, value in answers:        # report the odd one out
            if winner[0] and (pid, _, value) not in best:
                odd = self.peers.get(pid)
                self.alert("Work together", "medium",   # once per job, not per piece
                           f'gave different answers than other computers in '
                           f'job "{job.title}"', odd,
                           f"piece {i + 1}: " + json.dumps(value)[:200],
                           job=job.id)
        self.complete(job, i, winner)

    def complete(self, job, i, winner):
        pid, ok, value = winner
        t = job.tasks[i]
        t.update(state="done", worker=pid)
        job.results[i] = value
        job.done += 1
        if not ok:
            job.errors += 1
        self.stop_all_runs(job, i)           # backup copies aren't needed now
        if job.done == len(job.tasks):
            self.finish(job)

    def schedule(self):
        """Hand pieces to free helpers: fastest computers first, then send
        backup copies of pieces that are running unusually slowly."""
        workers = [p for p in self.peers.values() if p.online and p.worker]
        if not workers:
            return
        load = {p.id: self.load(p.id) for p in workers}
        known = sorted(p.specs["score"] for p in workers
                       if p.specs and p.specs.get("score"))
        usual = known[len(known) // 2] if known else 1
        speed = {p.id: (p.specs or {}).get("score") or usual for p in workers}

        def pick(t):
            """The free helper that would finish soonest, not already on t."""
            taken = t["runs"].keys() | {a[0] for a in t["answers"]}
            free = [p for p in workers
                    if load[p.id] < p.slots and p.id not in taken]
            if not free:
                return None
            return min(free, key=lambda p: (load[p.id] + 1)
                                           / (p.slots * speed[p.id]))

        def any_free():
            return any(load[p.id] < p.slots for p in workers)

        changed = False
        running_jobs = sorted((j for j in self.jobs.values()
                               if j.state == "running"), key=lambda j: j.created)
        for job in running_jobs:
            waiting = []                     # pieces no free helper can take
            while job.pending and any_free():
                i = job.pending.popleft()
                t = job.tasks[i]
                t["queued"] = False
                while job.wanted(i) > 0:
                    p = pick(t)
                    if not p:
                        break
                    self.start_run(job, i, p)
                    load[p.id] += 1
                    changed = True
                if job.wanted(i) > 0:
                    t["queued"] = True
                    waiting.append(i)
            job.pending.extendleft(reversed(waiting))

        # Backups: a free helper also starts a piece that's running far longer
        # than this job's pieces usually take. First answer back wins.
        if any_free():
            slow = []
            for job in running_jobs:
                usual_s = job.typical()
                limit = (max(BACKUP_AFTER, BACKUP_SLOW * usual_s)
                         if usual_s is not None else BACKUP_NO_DATA)
                for pid, jobs_here in self.assigned.items():
                    for jid, i in jobs_here:
                        t = job.tasks[i] if jid == job.id else None
                        if (not t or len(t["runs"]) != 1 or t.get("backed")
                                or job.wanted(i) < 0):
                            continue
                        took = now() - t["runs"].get(pid, now())
                        if took > limit:
                            slow.append((took / limit, job, i))
            for _, job, i in sorted(slow, key=lambda s: -s[0]):
                p = pick(job.tasks[i])
                if p:
                    job.tasks[i]["backed"] = True
                    job.backups += 1
                    self.start_run(job, i, p)
                    load[p.id] += 1
                    changed = True
                if not any_free():
                    break
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
        claude_bridge.peer_left(self, peer)   # stop their Claude, forget their sign-in
        for key in [k for k in self.counters if k[0] == peer.id]:
            del self.counters[key]
        peer.q.put(None)                     # close its live stream
        self.requeue_worker(peer.id)
        for j in self.jobs.values():
            if j.owner == peer.id and j.state == "running":
                self.cancel_job(j)
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

    if kind in browse.TYPES:                 # sharing / following web pages
        return browse.dispatch(room, peer, m, scan_text)

    if kind in claude_bridge.TYPES:          # the owner's Claude Code tab
        return claude_bridge.dispatch(room, peer, m)

    if kind in mail.TYPES:                   # mail between group members
        return mail.dispatch(room, peer, m)

    if kind in codeshare.TYPES:              # shared editor and snippets
        return codeshare.dispatch(room, peer, m, scan_code)

    if kind == "chat":
        text = str(m.get("text", "")).strip()
        sealed = text.startswith(E2E_PREFIX)  # end-to-end encrypted: unreadable here
        if len(text) > (E2E_CHAT_MAX if sealed else 4000):
            return "Message is too long."
        if not text:
            return "Empty message."
        out = {"type": "chat", "from": peer.id, "fromName": peer.name,
               "text": text, "ts": now() * 1000}
        to = m.get("to")
        if room.rate((peer.id, "chat"), 10, 8):
            room.alert("Chat", "medium", "is flooding the chat (more than 8 "
                       "messages in 10 seconds)", peer, text)
        for level, why, ex in ([] if sealed else scan_text(text)):
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
        old, new = room.notes, str(m.get("text", ""))
        sealed = new.startswith(E2E_PREFIX)
        if len(new) > (E2E_NOTES_MAX if sealed else 200_000):
            return "The notes are too long."
        if len(old) >= 200 and len(new) < len(old) * 0.3:
            room.notes_backup = old           # the owner can put it back
            room.alert("Shared notes", "medium",
                       f"deleted most of the shared notes ({len(old):,} → "
                       f"{len(new):,} characters)", peer, old[:200],
                       restore=True)
        seen = {why for _, why, _ in scan_text(old)}
        for level, why, ex in ([] if sealed else scan_text(new)):
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
        verify = bool(m.get("verify"))
        job = Job(str(room.job_seq), peer.id, title, code, combine, inputs,
                  verify)
        room.jobs[job.id] = job
        if room.rate((peer.id, "job"), 60, 5):
            room.alert("Work together", "medium", "started more than 5 jobs "
                       "in a minute", peer, title)
        for level, why, ex in scan_code(code + "\n" + combine):
            room.alert("Work together", level, f'started job "{title}", which '
                       f'{why}', peer, ex, job=job.id)
        room.system(f'{peer.name} started job "{title}" '
                    f'with {len(inputs)} pieces'
                    + (", double-checked." if verify else "."))
        room.announce_jobs()
        room.schedule()
        helpers = sum(1 for p in room.peers.values() if p.worker and p.online)
        note = None
        if not helpers:
            note = ("Nobody is helping yet. The job will start "
                    "when someone turns on \"Help with jobs\".")
        elif verify and helpers < 2:
            note = ("Double-checking needs at least 2 helper computers. "
                    "Each piece waits for a second computer to check it.")
        if note:
            peer.send({"type": "chat", "system": True, "ts": now() * 1000,
                       "text": note})
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
        if peer.id not in t["tried"]:
            room.alert("Work together", "high", f'sent an answer for a piece '
                       f'of job "{job.title}" it was never given (ignored)',
                       peer, json.dumps(m.get("value"))[:200])
            return None
        if m.get("needCode"):
            job.code_sent.discard(peer.id)
            room.requeue_run(job, i, peer.id)
            room.schedule()
            return None
        if (job.state != "running" or t["state"] == "done"
                or any(a[0] == peer.id for a in t["answers"])):
            room.stop_run(job, i, peer.id)   # late copy: just free its slot
            room.announce_jobs()
            room.schedule()
            return None
        peer.completed += 1
        ok = bool(m.get("ok"))
        value = (m.get("value") if ok
                 else {"error": str(m.get("error", "failed"))[:1000]})
        room.add_answer(job, i, peer, ok, value)
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
            room.cancel_job(job)
            room.system(f'{peer.name} cancelled job "{job.title}".')
        elif kind == "dismiss" and job.state != "running":
            for i in range(len(job.tasks)):  # free slots of pieces still out
                room.stop_all_runs(job, i)
            del room.jobs[job.id]
        room.announce_jobs()
        room.schedule()                      # freed helpers can take other work
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
        # A new password value plus the group key locked with it; the group
        # key itself doesn't change, so nobody already here loses access.
        password = str(m.get("password") or "")
        wrapped = str(m.get("wrapped") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", password) or not wrapped:
            return ("The group needs a password: it's what encrypts your "
                    "messages, notes and files.")
        if len(wrapped) > 200:
            return "Bad key."
        room.pw_salt = secrets.token_bytes(16)
        room.pw_hash = hash_pw(password, room.pw_salt)
        room.e2e_wrapped = wrapped
        room.system("The group owner changed the group password.")
        room.broadcast({"type": "locked", "locked": True})
        return None

    if kind == "e2e_key":
        # The group's creator sends its random key, locked with the password.
        wrapped = str(m.get("wrapped") or "")
        if room.e2e_wrapped or not wrapped or len(wrapped) > 200:
            return None                       # already set: first one wins
        room.e2e_wrapped = wrapped
        room.broadcast({"type": "e2e", "wrapped": wrapped})
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
                for pid, running in list(room.assigned.items()):
                    for jid, i in list(running):
                        j = room.jobs.get(jid)
                        started = j and j.tasks[i]["runs"].get(pid)
                        if not started:
                            running.discard((jid, i))
                        elif now() - started > TASK_TIMEOUT:
                            room.requeue_run(j, i, pid, abort=True)
                # also hands out backup copies of pieces that are running slowly
                room.schedule()
                if not room.peers:
                    claude_bridge.close(room)
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
    sys_version = ""                          # don't advertise the Python version
    plain = False                             # a plain-HTTP visitor being redirected

    def log_message(self, fmt, *args):
        pass                                  # keep the console quiet

    def setup(self):
        """With TLS on, encrypt the connection here (in this connection's own
        thread, so a slow visitor can't hold up everyone else). Someone who
        typed http:// is sent to the https:// address instead."""
        ctx = getattr(self.server, "tls", None)
        if ctx:
            raw = self.request
            raw.settimeout(15)
            try:
                first = raw.recv(1, socket.MSG_PEEK)
                if first and first != b"\x16":        # not a TLS handshake
                    self.plain = True
                    redirect_to_https(raw)
                else:
                    self.request = ctx.wrap_socket(raw, server_side=True)
            except (OSError, ValueError):
                self.plain = True
            self.request.settimeout(None)
        super().setup()

    def handle(self):
        if not self.plain:
            super().handle()

    def end_headers(self):
        if not urlparse(self.path).path.startswith("/api/browse"):
            for k, v in SECURITY_HEADERS.items():
                self.send_header(k, v)
        super().end_headers()

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
        elif u.path == "/api/browse":
            self.browse_page(parse_qs(u.query))
        elif u.path.startswith("/vendor/pyodide/"):
            terminal_support.serve_vendor(self, u.path)
        elif u.path == "/api/stdin":
            terminal_support.get(self, parse_qs(u.query))
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
        if path == "/api/claude/permission":  # from Claude Code's approval helper
            return self.reply(*claude_bridge.permission(
                body, self.client_address[0]))

        with lock:
            room, peer = self.auth(body.get("room"), body.get("id"),
                                   body.get("token"))
            if not peer:
                err, code = "Not in this group (seat expired).", 401
            elif path == "/api/leave":
                room.remove_peer(peer)
                err, code = None, 200
            elif path == "/api/stdin":        # a line typed into a running program
                err, code = terminal_support.post(peer, body)
            elif path == "/api/send":
                msg = body.get("msg")
                err = dispatch(room, peer, msg if isinstance(msg, dict) else {})
                code = 400 if err else 200
            else:
                err, code = "Not found", 404
        self.reply(code, {"error": err} if err else {"ok": True})

    # ---- built-in browser --------------------------------------------
    def browse_page(self, qs):
        """GET /api/browse?room&id&key&url: a web page for the Browse tab."""
        g = lambda k: (qs.get(k) or [""])[0]
        with lock:
            room = rooms.get(clean_room(g("room")))
            peer = room.peers.get(g("id")) if room else None
            ok = browse.allowed(peer, g("key"))
            limited = ok and room.rate((peer.id, "browse"), *browse.RATE)
        # The fetch can take seconds, so it happens without holding the lock.
        status, ctype, body = browse.page(
            g("url"), self.headers.get("Accept-Language", ""), ok, limited)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in browse.SAFE_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

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
            meta = g("meta")
            meta = meta if meta.startswith(E2E_PREFIX) and len(meta) <= 2000 else ""
            f = room.add_file(peer, "🔒 encrypted file" if meta
                              else clean_filename(g("name")),
                              b"".join(chunks), target, meta)
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
        # The browser never sends the password itself, only a value derived
        # from it (see e2e.js), so this server can't learn the key that
        # encrypts the group's chat, notes and files.
        password = str(body.get("password") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", password):
            return self.reply(400, {"error": "Please reload the page: CREW "
                                             "was updated."})
        wrong = created = False
        with lock:
            room = rooms.get(rname)
            if room is None:                  # first person sets the password
                room = rooms[rname] = Room(rname)
                room.pw_salt = secrets.token_bytes(16)
                room.pw_hash = hash_pw(password, room.pw_salt)
                created = True
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
                   "name": name, "locked": bool(room.pw_hash),
                   "created": created, "wrapped": room.e2e_wrapped}
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
                          "e2e": room.e2e_wrapped,
                          "max": MAX_PEERS, "peers": room.peer_list(),
                          "notes": room.notes, "notesBy": room.notes_by,
                          "jobs": room.job_list(), "owner": room.owner,
                          "alerts": list(room.alerts)
                          if peer.id == room.owner else [],
                          "browseKey": browse.key_for(peer)}))
            q.put(encode(room.files_msg(peer.id)))
            q.put(encode(claude_bridge.state_msg(room, peer)))
            q.put(encode(claude_bridge.state_msg(room, peer, "codechat")))
            q.put(encode(codeshare.state_msg(room, peer)))
            while True:                       # carry over undelivered messages
                try:
                    m = old.get_nowait()
                except queue.Empty:
                    break
                # Lists, the shared editor and the Claude conversations were
                # just re-sent in full above; an older copy of them must not
                # overwrite the fresh one (or show the same step twice).
                if m is not None and m[0] not in ("peers", "jobs", "files",
                                                  "code", "snippets",
                                                  "claude", "codechat"):
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


def redirect_to_https(sock):
    """Answer a plain-HTTP request with a redirect to the same page on https."""
    data = b""
    while b"\r\n\r\n" not in data and len(data) < 16384:
        chunk = sock.recv(4096)
        if not chunk:
            return
        data += chunk
    lines = data.split(b"\r\n")
    parts = lines[0].split(b" ")
    path = parts[1].decode("latin-1") if len(parts) > 1 else "/"
    host = next((l.split(b":", 1)[1].strip().decode("latin-1")
                 for l in lines[1:] if l.lower().startswith(b"host:")),
                f"localhost:{PORT}")
    if not re.fullmatch(r"[A-Za-z0-9.\-\[\]:]{1,255}", host) or not path.startswith("/"):
        host, path = f"localhost:{PORT}", "/"
    sock.sendall(f"HTTP/1.1 301 Moved Permanently\r\n"
                 f"Location: https://{host}{path}\r\n"
                 f"Content-Length: 0\r\nConnection: close\r\n\r\n".encode())


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    tls = None

    def handle_error(self, request, client_address):
        err = sys.exc_info()[1]
        if isinstance(err, (OSError, ssl.SSLError)):
            return                            # visitors hanging up, bad handshakes
        super().handle_error(request, client_address)


def tls_files():
    """Our own certificate, made once with openssl and kept in ~/.config/crew.
    It's remade if this computer's network address changes."""
    home = os.path.join(os.environ.get("XDG_CONFIG_HOME")
                        or os.path.expanduser("~/.config"), "crew")
    cert, key, ipfile = (os.path.join(home, n) for n in
                         ("crew-cert.pem", "crew-key.pem", "crew-cert-ip"))
    ip = lan_ip()
    try:
        with open(ipfile) as f:
            same = f.read().strip() == ip
    except OSError:
        same = False
    if same and os.path.exists(cert) and os.path.exists(key):
        return cert, key, False
    os.makedirs(home, mode=0o700, exist_ok=True)
    san = "DNS:localhost,IP:127.0.0.1" + (f",IP:{ip}" if ip != "127.0.0.1" else "")
    old = os.umask(0o077)                     # the private key is readable only by you
    try:
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec",
                        "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                        "-keyout", key, "-out", cert, "-days", "825",
                        "-subj", "/CN=CREW", "-addext", f"subjectAltName={san}"],
                       check=True, capture_output=True)
    finally:
        os.umask(old)
    with open(ipfile, "w") as f:
        f.write(ip)
    return cert, key, True


def fingerprint(cert):
    with open(cert) as f:
        der = ssl.PEM_cert_to_DER_cert(f.read())
    h = hashlib.sha256(der).hexdigest().upper()
    return ":".join(h[i:i + 2] for i in range(0, len(h), 2))


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
    srv = QuietServer(("0.0.0.0", PORT), Handler)
    scheme, print_fp = "http", None
    if OPTS["tls"]:
        if OPTS["cert"]:
            cert, key, made = OPTS["cert"], OPTS["key"], False
            SECURITY_HEADERS["Strict-Transport-Security"] = "max-age=31536000"
        else:
            try:
                cert, key, made = tls_files()
            except (OSError, subprocess.CalledProcessError) as e:
                sys.exit(f"Couldn't make an HTTPS certificate with openssl ({e}).\n"
                         "Install openssl, pass --cert/--key, or (not private) "
                         "use --no-tls.")
            print_fp = made
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        srv.tls, scheme = ctx, "https"
        claude_bridge.config["tls_fp"] = fingerprint(cert)
    threading.Thread(target=reaper, daemon=True).start()
    threading.Thread(target=announcer, daemon=True).start()
    print(f"CREW is running (up to {MAX_PEERS} computers per group).")
    print(f"  On this computer:    {scheme}://localhost:{PORT}")
    print(f"  On other computers:  {scheme}://{lan_ip()}:{PORT}")
    if OPTS["tls"]:
        print("  Connections are encrypted (HTTPS).")
        if print_fp is not None:
            print("  Browsers will warn that the certificate isn't trusted, because\n"
                  "  CREW made it itself. Check that the browser's certificate\n"
                  "  details show this SHA-256 fingerprint, then continue:\n"
                  f"    {fingerprint(cert)}"
                  + ("\n  (New certificate made just now.)" if print_fp else ""))
    else:
        print("  WARNING: --no-tls is on. Anyone on the network can read the\n"
              "  traffic, and end-to-end encryption only works on this computer.")
    if CLAUDE_DIR is not None:
        claude_bridge.config["scheme"] = scheme
        print(claude_bridge.setup(CLAUDE_DIR, PORT, lock,
                                  lambda name: rooms.get(name)))
    if terminal_support.python_available():
        print("  Terminal tab: Python is ready (runs offline in each browser).")
    else:
        print("  Terminal tab: Python isn't installed yet. For Python in the\n"
              "  terminal, run once:  python3 setup_python.py   (no restart needed)")
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
