"""CREW code sharing: the Code tab's shared editor and snippet board.

The server only stores and relays text. Nothing here runs code; running
happens in each person's own browser (see code.js).

Messages from a computer:
    code            {text, lang}        replace the shared editor contents
    snippet_add     {title, lang, text} pin a piece of code on the board
    snippet_delete  {id}                remove one (its author or the owner)
"""
import re
import secrets
import time

TYPES = {"code", "snippet_add", "snippet_delete"}

LANGS = {"javascript", "html", "css", "python", "java", "c", "cpp", "csharp",
         "go", "rust", "ruby", "php", "sql", "bash", "text"}
MAX_CODE_TEXT = 200_000      # characters in the shared editor
MAX_SNIPPET = 50_000         # characters in one snippet
MAX_SNIPPETS = 100           # snippets per group


def _state(room):
    s = getattr(room, "codeshare", None)
    if s is None:
        s = room.codeshare = {"text": "", "lang": "javascript", "by": "",
                              "snippets": []}
    return s


def state_msg(room, peer=None):
    """Everything a computer needs to show the Code tab when it connects."""
    s = _state(room)
    return {"type": "codeshare", "code": s["text"], "lang": s["lang"],
            "by": s["by"], "snippets": s["snippets"]}


def _snippets_msg(room):
    return {"type": "snippets", "snippets": _state(room)["snippets"]}


def _new_problems(old, new, scan):
    seen = {why for _, why, _ in scan(old)}
    return [(lvl, why, ex) for lvl, why, ex in scan(new) if why not in seen]


def dispatch(room, peer, m, scan_code):
    """Handle one message. Returns an error string or None."""
    kind, s = m.get("type"), _state(room)

    if kind == "code":
        new = str(m.get("text", ""))[:MAX_CODE_TEXT]
        lang = m.get("lang")
        if lang in LANGS:
            s["lang"] = lang
        for level, why, ex in _new_problems(s["text"], new, scan_code):
            room.alert("Shared code", level, why.replace("posted", "added"),
                       peer, ex)
        s["text"], s["by"] = new, peer.name
        room.broadcast({"type": "code", "text": new, "lang": s["lang"],
                        "byName": peer.name}, exclude=peer.id)
        return None

    if kind == "snippet_add":
        text = str(m.get("text", ""))[:MAX_SNIPPET]
        if not text.strip():
            return "There's no code to share yet."
        if len(s["snippets"]) >= MAX_SNIPPETS:
            return (f"The board is full ({MAX_SNIPPETS} snippets). "
                    "Delete some first.")
        title = re.sub(r"[\x00-\x1f\x7f]", "", str(m.get("title") or "")).strip()
        lang = m.get("lang") if m.get("lang") in LANGS else "text"
        for level, why, ex in _new_problems("", text, scan_code):
            room.alert("Shared code", level, why.replace("posted", "added"),
                       peer, ex)
        s["snippets"].append({
            "id": secrets.token_hex(5), "title": title[:60] or "Untitled",
            "lang": lang, "text": text, "owner": peer.id,
            "ownerName": peer.name, "ts": time.time() * 1000})
        room.broadcast(_snippets_msg(room))
        room.system(f'{peer.name} shared a snippet: {title[:60] or "Untitled"}')
        return None

    if kind == "snippet_delete":
        for i, sn in enumerate(s["snippets"]):
            if sn["id"] == str(m.get("id")):
                if (sn["owner"] != peer.id and peer.id != room.owner
                        and sn["owner"] in room.peers):
                    return "Only the person who shared a snippet can delete it."
                del s["snippets"][i]
                room.broadcast(_snippets_msg(room))
                break
        return None

    return f"Unknown message type: {kind!r}"
