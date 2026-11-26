#!/usr/bin/env python3
"""CREW <-> Claude Code: the server half of the Claude Code tab.

The host turns it on by starting CREW with --claude (optionally naming the
folder that holds everyone's workspaces, ~/crew-workspace by default):

    python3 server.py --claude

Then everyone in a group gets a "Claude Code" tab, a chat panel like the one
in VS Code. Each person signs in with their OWN Claude account (a login token
from `claude setup-token`, or an Anthropic API key), so their usage is billed
to them. Each message runs Claude Code headless (`claude -p --output-format
stream-json`) on the host computer, in that person's own folder
(<workspaces>/<group>/<name>-<browser id>), and every step streams to their
browser only. Follow-up messages continue the same conversation with --resume.

Approvals: Claude Code asks before editing files or running commands. Those
questions go to this file run as a tiny MCP server (`--permission-prompt-tool`),
which forwards them to CREW over localhost; CREW shows them in the owner's
browser with Allow / Deny buttons and sends back the answer.

Safety rules:
  * Off unless the host passes --claude.
  * Each person's sign-in is kept only in memory, used only for their own
    runs, and forgotten when they sign out or leave. Every run gets its own
    empty Claude Code settings folder, so it can never fall back to the
    host's own Claude login.
  * Each person sees only their own conversations and approvals.
  * NOT a security boundary: everyone's Claude runs as the host's user
    account. With approval it can run commands and touch files outside its
    folder, and in principle read other people's sign-ins from the host.
    Only turn this on for people you trust.
  * The approval channel only accepts calls from this computer that carry
    a secret made at startup and the id of the run that is going on now.
  * There is no "skip all approvals" mode. The most permissive choice
    auto-accepts file edits inside the folder; commands are still asked.

The Code tab's "Ask Claude" panel (codechat_* messages) uses the same
program and the same rules about who may use it, but it's only a chat:
Claude gets no tools at all (no files, commands, web or MCP servers) and
runs in an empty folder. Each question carries the shared editor's code,
and answers with code can be put back into the editor from the browser.
"""
import glob
import hashlib
import http.client
import json
import os
import re
import secrets
import shutil
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

TYPES = {"claude_prompt", "claude_stop", "claude_answer", "claude_new",
         "claude_login", "claude_logout",
         "codechat_prompt", "codechat_stop", "codechat_new"}
DEFAULT_WORKSPACES = "~/crew-workspace"
# Best-effort guard rails passed to every run (approvals are the real control).
GUARD_SETTINGS = {"permissions": {"deny": [
    f"{tool}({path})" for tool in ("Read", "Edit", "Write")
    for path in ("~/.ssh/**", "~/.claude/**", "~/.config/**", "~/.gnupg/**",
                 "~/.aws/**", "//proc/**", "//etc/shadow")]}}
CRED_KINDS = {"sk-ant-oat": ("token", "Claude login token"),
              "sk-ant-api": ("key", "Anthropic API key")}
MODELS = {"claude-opus-5-5": "Opus 5.5",
          "claude-sonnet-5-5": "Sonnet 5.5",
          "claude-haiku-5-5": "Haiku 5.5"}
MODES = {"default": "Ask before edits and commands",
         "acceptEdits": "Auto-accept file edits",
         "plan": "Plan only (no changes)"}
MAX_EVENTS = 600            # conversation events kept for a reloaded page
MAX_TEXT = 20_000           # characters per string shown in the browser
MAX_PROMPT = 50_000         # characters per message to Claude
APPROVAL_WAIT = 600         # seconds an approval question waits for an answer
MAX_EDITOR = 60_000         # characters of editor code sent with a Code-tab question
CODECHAT_SYSTEM = (
    "You are helping a small group of people who are coding together in "
    "CREW's Code tab: one shared editor that everyone in the group sees "
    "live, with a Run button that runs JavaScript or HTML pages in each "
    "person's own browser. Many of them are beginners, so explain things "
    "plainly and keep answers short. You can't read files, run commands "
    "or browse the web; you only see the code people include in their "
    "messages. When you suggest a change to the editor's code, give the "
    "complete updated code in ONE fenced code block tagged with its "
    "language, so it can be put straight into the editor with one click. "
    "Use small separate snippets only to illustrate a point.")

config = {"dir": None, "bin": None, "port": 8000, "scheme": "http",
          "chat_dir": None,        # empty folder the Code-tab chat runs in
          "tls_fp": "",            # CREW's certificate, so the helper can pin it
          "secret": secrets.token_urlsafe(24)}
_lock = None                # CREW's big lock, set by setup()
_rooms = None               # function: room name -> Room or None


# ---- setup -------------------------------------------------------------
def find_binary():
    """The `claude` program: $CREW_CLAUDE_BIN, PATH, or the copy that the
    VS Code extension ships with."""
    for c in (os.environ.get("CREW_CLAUDE_BIN"), shutil.which("claude"),
              os.path.expanduser("~/.local/bin/claude"),
              os.path.expanduser("~/.claude/local/claude")):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    found = glob.glob(os.path.expanduser(
        "~/.vscode*/extensions/anthropic.claude-code-*/resources/"
        "native-binary/claude"))
    found = [f for f in found if os.access(f, os.X_OK)]
    return max(found, key=os.path.getmtime) if found else None


def setup(folder, port, lock, get_room):
    """Turn the feature on. Returns a line to print at startup."""
    global _lock, _rooms
    folder = os.path.realpath(os.path.expanduser(folder or DEFAULT_WORKSPACES))
    try:
        os.makedirs(folder, mode=0o700, exist_ok=True)
    except OSError as e:
        return f"  Claude Code: OFF (can't use the folder {folder}: {e})"
    binary = find_binary()
    if not binary:
        return ("  Claude Code: OFF (couldn't find the `claude` program; "
                "install Claude Code or set CREW_CLAUDE_BIN)")
    config.update(dir=folder, bin=binary, port=port)
    _lock, _rooms = lock, get_room
    return (f"  Claude Code: ON for everyone. Each person signs in with their own\n"
            f"               Claude account and works in their own folder under\n"
            f"               {folder}\n"
            f"               (Claude runs as YOUR user account on this computer:\n"
            f"               only use this with people you trust)")


def enabled():
    return bool(config["dir"])


# ---- per-group conversation -----------------------------------------------
class Session:
    def __init__(self, kind="claude", pid=""):
        self.kind = kind            # "claude" (Claude Code tab) or "codechat" (Code tab)
        self.pid = pid              # whose session this is
        self.events = []
        self.seq = 0
        self.sid = None             # Claude Code session id, for --resume
        self.proc = None
        self.run = ""               # id of the current run (approvals must match)
        self.pending = {}           # approval id -> {"ev", "allow", "tool"}
        self.always = set()         # tools allowed for the rest of the chat
        self.model = "claude-opus-5-5"
        self.mode = "default"
        self.got_result = False
        self.stderr = []
        self.seen_code = None       # editor code Claude has already been shown
        self.sent_code = None       # ...and the code sent with the current run


def _sessions(room):
    d = getattr(room, "_claude_sessions", None)
    if d is None:
        d = room._claude_sessions = {}
    return d


def _accounts(room):
    """peer id -> {"kind", "label", "secret", "cfg"} (sign-ins, memory only)."""
    d = getattr(room, "_claude_accounts", None)
    if d is None:
        d = room._claude_accounts = {}
    return d


def session(room, peer_id, create=True, kind="claude"):
    key = (peer_id, kind)
    s = _sessions(room).get(key)
    if s is None and create:
        s = _sessions(room)[key] = Session(kind, peer_id)
    return s


def can_use(room, peer):
    return enabled() and peer is not None


def _person(room, s):
    return room.peers.get(s.pid)


def _safe(name):
    return re.sub(r"[^A-Za-z0-9_-]+", "-", str(name)).strip("-")[:40] or "person"


def workdir(room, peer):
    """This person's own folder: <workspaces>/<group>/<name>-<browser id>.
    The browser id keeps it stable across reconnects and private to them."""
    tag = _safe((getattr(peer, "device", "") or peer.id)[:8])
    d = os.path.join(config["dir"], _safe(room.name), f"{_safe(peer.name)}-{tag}")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def emit(room, s, ev):
    s.seq += 1
    ev["n"] = s.seq
    s.events.append(ev)
    del s.events[:-MAX_EVENTS]
    p = _person(room, s)
    if p:
        p.send({"type": s.kind, "event": ev})


def state_msg(room, peer, kind="claude"):
    """What this person may know about their Claude Code tab (kind "claude")
    or the Code tab's Ask Claude panel (kind "codechat")."""
    if not can_use(room, peer):
        return {"type": kind + "_state", "available": False}
    s = session(room, peer.id, kind=kind)
    acct = _accounts(room).get(peer.id)
    msg = {"type": kind + "_state", "available": True,
           "signedIn": bool(acct), "account": acct["label"] if acct else "",
           "running": s.proc is not None, "model": s.model,
           "models": MODELS, "events": s.events}
    if kind == "claude":
        msg.update(dir=workdir(room, peer), mode=s.mode, modes=MODES,
                   always=sorted(s.always))
    return msg


def send_state(room, peer_id, kind="claude"):
    p = room.peers.get(peer_id)
    if p:
        p.send(state_msg(room, p, kind))


def trim(v, n=MAX_TEXT):
    if isinstance(v, str):
        return v if len(v) <= n else v[:n] + f"\n… ({len(v) - n:,} more characters)"
    if isinstance(v, list):
        return [trim(x, n) for x in v[:200]]
    if isinstance(v, dict):
        return {str(k): trim(x, n) for k, x in list(v.items())[:100]}
    return v


# ---- running Claude Code ------------------------------------------------------
def _env(acct):
    """The environment for one person's run: their sign-in and an empty
    settings folder of their own, never the host's Claude login."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("ANTHROPIC_", "CLAUDE_CODE_", "CLAUDE_CONFIG"))}
    env["CLAUDE_CONFIG_DIR"] = acct["cfg"]
    env["ANTHROPIC_API_KEY" if acct["kind"] == "key" else "CLAUDE_CODE_OAUTH_TOKEN"] = acct["secret"]
    return env


def start(room, s, text, by, full=None, note=""):
    """Run Claude on one message. `text` is what the person typed (shown in
    the browser); `full` is what Claude gets, if different (the Code tab
    adds the editor's code); `note` says briefly what was added."""
    acct = _accounts(room).get(s.pid)
    peer = room.peers.get(s.pid)
    if not acct or not peer:
        return "Sign in with your Claude account first (in the Claude Code tab)."
    s.run = secrets.token_hex(8)
    s.got_result = False
    s.stderr = []
    args = [config["bin"], "-p", "--output-format", "stream-json", "--verbose",
            "--model", s.model]
    if s.kind == "codechat":                 # a plain chat: no tools of any kind
        args += ["--tools", "", "--strict-mcp-config",
                 "--mcp-config", json.dumps({"mcpServers": {}}),
                 "--append-system-prompt", CODECHAT_SYSTEM]
        cwd = os.path.join(acct["cfg"], "chat")
        os.makedirs(cwd, mode=0o700, exist_ok=True)
    else:
        helper = {"command": sys.executable,
                  "args": ["-I", os.path.abspath(__file__)],
                  "env": {"CREW_URL": f"{config['scheme']}://127.0.0.1:{config['port']}",
                          "CREW_TLS_FP": config["tls_fp"],
                          "CREW_SECRET": config["secret"],
                          "CREW_ROOM": room.name, "CREW_PEER": s.pid,
                          "CREW_RUN": s.run}}
        args += ["--permission-mode", s.mode,
                 "--permission-prompt-tool", "mcp__crew__approve",
                 "--mcp-config", json.dumps({"mcpServers": {"crew": helper}}),
                 "--strict-mcp-config", "--settings", json.dumps(GUARD_SETTINGS)]
        cwd = workdir(room, peer)
    if s.sid:
        args += ["--resume", s.sid]
    ev = {"type": "prompt", "text": text, "by": by}
    if note:
        ev["note"] = note
    emit(room, s, ev)
    try:
        proc = subprocess.Popen(args, cwd=cwd, env=_env(acct), stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True)
    except OSError as e:
        emit(room, s, {"type": "error", "text": f"Couldn't start Claude Code: {e}"})
        return
    s.proc = proc
    send_state(room, s.pid, s.kind)
    try:
        proc.stdin.write((full or text).encode())
        proc.stdin.close()
    except OSError:
        pass
    threading.Thread(target=_read_err, args=(s, proc), daemon=True).start()
    threading.Thread(target=_read_out, args=(room, s, proc), daemon=True).start()
    return None


def _read_err(s, proc):
    for line in proc.stderr:
        s.stderr.append(line.decode(errors="replace").rstrip())
        del s.stderr[:-20]


def _read_out(room, s, proc):
    for line in proc.stdout:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        with _lock:
            if s.proc is proc:
                _event(room, s, e)
    proc.wait()
    with _lock:
        if s.proc is not proc:
            return
        s.proc = None
        _deny_all(room, s, "Claude Code stopped.")
        if not s.got_result:
            tail = "\n".join(s.stderr[-5:])
            emit(room, s, {"type": "error", "text": "Stopped." if proc.returncode in
                           (-signal.SIGINT, -signal.SIGKILL, 130, 137)
                           else f"Claude Code exited (code {proc.returncode}).\n{tail}".strip()})
        send_state(room, s.pid, s.kind)


def _event(room, s, e):
    """Turn one stream-json line into what the browser shows."""
    t = e.get("type")
    if t == "system" and e.get("subtype") == "init":
        s.sid = e.get("session_id") or s.sid
        emit(room, s, {"type": "init", "model": e.get("model", ""),
                       "cwd": e.get("cwd", "")})
    elif t == "assistant":
        for b in (e.get("message") or {}).get("content") or []:
            bt = b.get("type")
            if bt == "text" and b.get("text", "").strip():
                emit(room, s, {"type": "text", "text": trim(b["text"])})
            elif bt == "thinking" and b.get("thinking", "").strip():
                emit(room, s, {"type": "thinking", "text": trim(b["thinking"])})
            elif bt == "tool_use":
                emit(room, s, {"type": "tool", "id": b.get("id"),
                               "name": b.get("name"), "input": trim(b.get("input"))})
    elif t == "user":
        content = (e.get("message") or {}).get("content")
        for b in content if isinstance(content, list) else []:
            if b.get("type") != "tool_result":
                continue
            c = b.get("content")
            if isinstance(c, list):
                c = "\n".join(x.get("text", "[image]" if x.get("type") == "image"
                                    else "") for x in c if isinstance(x, dict))
            emit(room, s, {"type": "tool_result", "id": b.get("tool_use_id"),
                           "text": trim(str(c or ""), 8000),
                           "error": bool(b.get("is_error"))})
    elif t == "result":
        s.got_result = True
        if e.get("session_id"):
            s.sid = e["session_id"]
        if e.get("is_error") and re.search(r"(?i)invalid api key|not logged in|/login|authentication|401|oauth",
                                           str(e.get("result") or "")):
            emit(room, s, {"type": "error", "text": "Your Claude sign-in didn't work. "
                           "Sign out and sign in again with a fresh token or key."})
        if not e.get("is_error") and s.sent_code is not None:
            s.seen_code = s.sent_code          # Claude has this code in its history now
        emit(room, s, {"type": "result", "ok": not e.get("is_error"),
                       "text": trim(str(e.get("result") or "")) if e.get("is_error") else "",
                       "cost": e.get("total_cost_usd"), "ms": e.get("duration_ms"),
                       "turns": e.get("num_turns")})


def stop(room, s):
    proc = s.proc
    if not proc:
        return
    _deny_all(room, s, "Stopped.")
    try:
        os.killpg(proc.pid, signal.SIGINT)
    except OSError:
        return

    def hard_stop():
        time.sleep(5)
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
    threading.Thread(target=hard_stop, daemon=True).start()


def reset(room, peer_id, kind="claude"):
    """Stop and forget one person's conversation ("New conversation", sign-out)."""
    s = session(room, peer_id, create=False, kind=kind)
    if not s:
        return
    stop(room, s)
    s.proc = None                      # ignore anything the old run still prints
    s.events, s.sid, s.always, s.run = [], None, set(), ""
    s.seen_code = s.sent_code = None


# ---- approvals -------------------------------------------------------------------
def _resolve(room, s, aid, allow, why=""):
    p = s.pending.pop(aid, None)
    if not p:
        return
    p["allow"] = allow
    emit(room, s, {"type": "permission_done", "id": aid, "allow": allow,
                   "why": why})
    p["ev"].set()


def _deny_all(room, s, why):
    for aid in list(s.pending):
        _resolve(room, s, aid, False, why)


def permission(body, client_ip):
    """POST /api/claude/permission from the approval helper. Blocks until the
    owner answers. Returns (http status, reply)."""
    if (not enabled() or client_ip not in ("127.0.0.1", "::1", "::ffff:127.0.0.1")
            or not secrets.compare_digest(str(body.get("secret", "")),
                                          config["secret"])):
        return 403, {"error": "Forbidden"}
    inp = body.get("input") if isinstance(body.get("input"), dict) else {}
    deny = {"behavior": "deny",
            "message": "The person using CREW declined this action."}
    allow = {"behavior": "allow", "updatedInput": inp}
    tool = str(body.get("tool_name", ""))[:100]
    with _lock:
        room = _rooms(str(body.get("room", "")))
        s = room and session(room, str(body.get("peer", "")), create=False)
        if not s or not s.proc or not secrets.compare_digest(
                str(body.get("run", "")), s.run or "-"):
            return 200, dict(deny, message="That Claude Code run has ended.")
        if tool in s.always:
            return 200, allow
        aid = secrets.token_hex(6)
        p = s.pending[aid] = {"ev": threading.Event(), "allow": False,
                              "tool": tool}
        emit(room, s, {"type": "permission", "id": aid, "tool": tool,
                       "input": trim(inp), "toolUseId": body.get("tool_use_id")})
        o = _person(room, s)
        if o:
            o.send({"type": "claude_ask", "tool": tool})
    p["ev"].wait(APPROVAL_WAIT)
    with _lock:
        if aid in s.pending:
            _resolve(room, s, aid, False, "No answer in time.")
    return 200, allow if p["allow"] else deny


# ---- hooks called by server.py ---------------------------------------------------
def dispatch(room, peer, m):
    """Handle a claude_* message. Returns an error string or None."""
    if not enabled():
        return "Claude Code isn't turned on for this CREW server."
    if not can_use(room, peer):
        return "Claude Code isn't available."
    kind = m.get("type")
    if kind == "claude_login":
        return login(room, peer, m.get("secret"))
    if kind == "claude_logout":
        logout(room, peer.id)
        return None
    if kind.startswith("codechat_"):
        return _codechat(room, peer, m, kind)
    s = session(room, peer.id)
    if kind == "claude_prompt":
        text = str(m.get("text", "")).strip()[:MAX_PROMPT]
        if not text:
            return "Type a message for Claude first."
        if s.proc:
            return "Claude is still working. Wait, or press Stop."
        if m.get("model") in MODELS:
            s.model = m["model"]
        if m.get("mode") in MODES:
            s.mode = m["mode"]
        return start(room, s, text, peer.name)
    elif kind == "claude_stop":
        stop(room, s)
    elif kind == "claude_answer":
        aid = str(m.get("id", ""))
        p = s.pending.get(aid)
        if p:
            if m.get("allow") and m.get("always"):
                s.always.add(p["tool"])
            _resolve(room, s, aid, bool(m.get("allow")))
    elif kind == "claude_new":
        reset(room, peer.id)
        send_state(room, peer.id)
    return None


def login(room, peer, secret):
    """Sign this person in with their own Claude login token or API key."""
    secret = str(secret or "").strip()
    found = next((v for k, v in CRED_KINDS.items() if secret.startswith(k)), None)
    if not found or not re.fullmatch(r"[A-Za-z0-9_\-]{20,400}", secret):
        return ("That doesn't look like a Claude login token (sk-ant-oat…) or an "
                "Anthropic API key (sk-ant-api…).")
    logout(room, peer.id, quiet=True)
    _accounts(room)[peer.id] = {"kind": found[0], "label": found[1], "secret": secret,
                                "cfg": tempfile.mkdtemp(prefix="crew-claude-")}
    for kind in ("claude", "codechat"):
        send_state(room, peer.id, kind)
    return None


def logout(room, peer_id, quiet=False):
    """Forget this person's sign-in, stop their runs and clear their chats."""
    acct = _accounts(room).pop(peer_id, None)
    for kind in ("claude", "codechat"):
        reset(room, peer_id, kind)
    if acct:
        acct["secret"] = ""
        shutil.rmtree(acct["cfg"], ignore_errors=True)
    if not quiet:
        for kind in ("claude", "codechat"):
            send_state(room, peer_id, kind)


def _fence(code):
    """A ``` fence longer than any run of backticks inside the code."""
    longest = max((len(run) for run in re.findall(r"`+", code)), default=0)
    return "`" * max(3, longest + 1)


def _codechat(room, peer, m, kind):
    """The Code tab's Ask Claude panel."""
    s = session(room, peer.id, kind="codechat")
    if kind == "codechat_prompt":
        text = str(m.get("text", "")).strip()[:MAX_PROMPT]
        if not text:
            return "Type a question for Claude first."
        if s.proc:
            return "Claude is still answering. Wait, or press Stop."
        if m.get("model") in MODELS:
            s.model = m["model"]
        code = str(m.get("code") or "")
        lang = "".join(c for c in str(m.get("lang") or "text") if c.isalnum())[:20] or "text"
        sel = str(m.get("selection") or "")[:MAX_EDITOR // 2]
        parts, note, s.sent_code = [], "", None
        if m.get("include", True) and code.strip():
            lines = code.count("\n") + 1
            note = f"with the editor's code ({lines} line{'s' if lines != 1 else ''})"
            if s.sid and code == s.seen_code:
                parts.append("(The code in the shared editor hasn't changed "
                              "since I last showed it to you.)")
            else:
                cut = code[:MAX_EDITOR]
                f = _fence(cut)
                parts.append(f"Here is the code in the shared editor right now "
                             f"({lang}, {lines} lines"
                             + (f", only the first {MAX_EDITOR:,} characters"
                                if len(code) > MAX_EDITOR else "")
                             + f"):\n{f}{lang}\n{cut}\n{f}")
                s.sent_code = code
            if sel.strip() and sel.strip() != code.strip():
                f = _fence(sel)
                parts.append(f"I've selected this part of it:\n{f}{lang}\n{sel}\n{f}")
                note += " and your selection"
        parts.append(text)
        return start(room, s, text, peer.name, "\n\n".join(parts), note)
    elif kind == "codechat_stop":
        stop(room, s)
    elif kind == "codechat_new":
        reset(room, peer.id, "codechat")
        send_state(room, peer.id, "codechat")
    else:
        return f"Unknown message type: {kind!r}"
    return None


def owner_changed(room, old_id):
    """Everyone has their own Claude now, so ownership changes nothing."""


def peer_left(room, peer):
    """Someone left the group: stop their runs and forget their sign-in."""
    if enabled():
        logout(room, peer.id, quiet=True)
        for kind in ("claude", "codechat"):
            _sessions(room).pop((peer.id, kind), None)


def close(room):
    """The group is being deleted."""
    for pid in list(_accounts(room)):
        logout(room, pid, quiet=True)
    for s in _sessions(room).values():
        stop(room, s)


# ---- approval helper (Claude Code starts this file as an MCP server) ---------------
def helper():
    """A minimal MCP server on stdin/stdout with one tool, `approve`, that
    asks CREW (and so the person in the browser) whether Claude may go on."""
    out_lock = threading.Lock()

    def out(msg):
        with out_lock:
            sys.stdout.write(json.dumps(msg) + "\n")
            sys.stdout.flush()

    def post(body):
        """POST to CREW on this computer. Over HTTPS, CREW's certificate is
        checked against the fingerprint CREW passed us (it's self-made, so
        normal certificate checks can't vouch for it)."""
        u = urllib.parse.urlsplit(os.environ["CREW_URL"])
        if u.scheme == "https":
            ctx = ssl.create_default_context()
            ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
            conn = http.client.HTTPSConnection(u.hostname, u.port, context=ctx,
                                               timeout=APPROVAL_WAIT + 60)
            conn.connect()
            der = conn.sock.getpeercert(binary_form=True) or b""
            got = hashlib.sha256(der).hexdigest().upper()
            want = os.environ.get("CREW_TLS_FP", "").replace(":", "")
            if not want or not secrets.compare_digest(got, want):
                conn.close()
                raise OSError("CREW's certificate didn't match")
        else:
            conn = http.client.HTTPConnection(u.hostname, u.port,
                                              timeout=APPROVAL_WAIT + 60)
        try:
            conn.request("POST", "/api/claude/permission", json.dumps(body),
                         {"Content-Type": "application/json"})
            return json.loads(conn.getresponse().read())
        finally:
            conn.close()

    def ask(mid, args):
        deny = {"behavior": "deny", "message": "Couldn't reach CREW to ask."}
        try:
            decision = post({"secret": os.environ.get("CREW_SECRET", ""),
                             "room": os.environ.get("CREW_ROOM", ""),
                             "peer": os.environ.get("CREW_PEER", ""),
                             "run": os.environ.get("CREW_RUN", ""),
                             "tool_name": args.get("tool_name", ""),
                             "input": args.get("input", {}),
                             "tool_use_id": args.get("tool_use_id", "")})
            if decision.get("behavior") not in ("allow", "deny"):
                decision = deny
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            decision = deny
        out({"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": json.dumps(decision)}]}})

    for line in sys.stdin:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        mid, method = m.get("id"), m.get("method")
        if mid is None:
            continue                         # notifications need no answer
        params = m.get("params") or {}
        if method == "initialize":
            out({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": params.get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "crew", "version": "1"}}})
        elif method == "tools/list":
            out({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{
                "name": "approve",
                "description": "Ask the person using CREW to approve a tool call.",
                "inputSchema": {"type": "object", "properties": {
                    "tool_name": {"type": "string"},
                    "input": {"type": "object"},
                    "tool_use_id": {"type": "string"}},
                    "required": ["tool_name", "input"]}}]}})
        elif method == "tools/call":
            threading.Thread(target=ask, args=(mid, params.get("arguments") or {}),
                             daemon=True).start()
        elif method == "ping":
            out({"jsonrpc": "2.0", "id": mid, "result": {}})
        else:
            out({"jsonrpc": "2.0", "id": mid,
                 "error": {"code": -32601, "message": "Method not found"}})


if __name__ == "__main__":
    helper()
