"""CREW mail: Gmail-style mail between the members of a group.

Mail can be sent to anyone who has been in the group while it existed,
including people who are offline right now; they get it when they come
back from the same browser.

Only the recipient can read a mail. Each browser makes its own key pair
for each group code (see mail.js) and keeps the private half to itself.
A mail is encrypted once with a random key, and that key is locked
separately for each recipient's public key. This server only stores and
passes along scrambled data; it can see who mailed whom, when, how big
the mail is, and the read / starred / archived / trash marks, but not
the subject, text, names of attachments or their contents.

A mailbox is identified by a secret the browser keeps: its id is a hash
of that secret, and only a browser that knows the secret can use it.
Each mailbox has a "card" (its owner's name and public key), encrypted
with the group key so that only group members can make or read one, and
so this server can't slip in a key of its own.

Like everything in CREW, mail lives only in this server's memory and is
gone when the group ends (everyone has left) or the server stops.

Messages from a computer:
    mail_hello   {secret, card}         use (or make) my mailbox
    mail_send    {id, to, eph, blob, att, keys}
                                        send a mail; keys has one locked
                                        key per recipient and one for me
    mail_flag    {ids, read?, star?, archived?, trash?}
                                        change marks on my copies
    mail_delete  {ids}                  delete my copies for good
    mail_att     {id}                   send me a mail's attachments
"""
import hashlib
import re
import time

TYPES = {"mail_hello", "mail_send", "mail_flag", "mail_delete", "mail_att"}

E2E_PREFIX = "e2e1:"
MAX_BOXES = 60               # mailboxes per group (people x browsers)
MAX_RECIPIENTS = 40
MAX_CARD = 2_000             # characters in an encrypted mailbox card
MAX_BLOB = 300_000           # characters in an encrypted subject + text
MAX_ATT = 2_800_000          # characters in encrypted attachments (~2 MB)
MAX_GROUP_BYTES = 60_000_000 # mail kept in memory per group
MAX_PER_BOX = 1_000          # mails kept in one mailbox
FLAGS = ("read", "star", "archived", "trash")

HEX = re.compile(r"[0-9a-f]{64}")
MID = re.compile(r"[0-9a-f]{20}")
B64 = re.compile(r"[A-Za-z0-9+/]+={0,2}")


class Box:
    def __init__(self, bid, device):
        self.id = bid
        self.card = ""
        self.device = device         # removed computers' mailboxes are hidden
        self.peers = set()           # peer ids using this mailbox now
        self.entries = {}            # mail id -> {inbox, sent, read, star, ...}


class Mail:
    def __init__(self, mid, sender, eph, blob, att, keys):
        self.id = mid
        self.sender = sender         # mailbox id
        self.ts = time.time() * 1000
        self.eph = eph
        self.blob = blob
        self.att = att
        self.keys = keys             # mailbox id -> locked content key
        self.size = len(blob) + len(att) + sum(map(len, keys.values()))


def _state(room):
    s = getattr(room, "mail", None)
    if s is None:
        s = room.mail = {"boxes": {}, "mails": {}, "bytes": 0}
    return s


def box_id(secret):
    return hashlib.sha256(secret.encode()).hexdigest()[:24]


def _my_box(room, peer):
    for b in _state(room)["boxes"].values():
        if peer.id in b.peers:
            return b
    return None


def _directory(room):
    return [{"id": b.id, "card": b.card,
             "peers": [p for p in b.peers if p in room.peers],
             "gone": bool(b.device) and b.device in room.banned}
            for b in _state(room)["boxes"].values() if b.card]


def _item(room, box, mid):
    """What one mailbox's owner sees of one mail."""
    m, e = _state(room)["mails"][mid], box.entries[mid]
    return {"id": m.id, "ts": m.ts, "from": m.sender, "eph": m.eph,
            "blob": m.blob, "key": m.keys.get(box.id, ""),
            "hasAtt": bool(m.att), "size": m.size, **e}


def _to_box(room, box, msg):
    for pid in box.peers:
        p = room.peers.get(pid)
        if p:
            p.send(msg)


def _drop_unused(s, mid):
    if not any(mid in b.entries for b in s["boxes"].values()):
        m = s["mails"].pop(mid, None)
        if m:
            s["bytes"] -= m.size


def _clean_b64(v, limit):
    v = str(v or "")
    return v if len(v) <= limit and (not v or B64.fullmatch(v)) else None


def dispatch(room, peer, m):
    """Handle one message. Returns an error string or None."""
    kind, s = m.get("type"), _state(room)

    if kind == "mail_hello":
        secret, card = str(m.get("secret") or ""), str(m.get("card") or "")
        if not HEX.fullmatch(secret):
            return "Please reload the page: CREW was updated."
        if not card.startswith(E2E_PREFIX) or len(card) > MAX_CARD:
            return "Your mailbox card couldn't be read."
        bid = box_id(secret)
        box = s["boxes"].get(bid)
        if box is None:
            if len(s["boxes"]) >= MAX_BOXES:
                return "This group has too many mailboxes."
            if room.rate((peer.id, "mailbox"), 3600, 3):
                return "Too many new mailboxes from this computer."
            box = s["boxes"][bid] = Box(bid, peer.device)
        for b in s["boxes"].values():        # a computer uses one mailbox
            b.peers.discard(peer.id)
        box.peers.add(peer.id)
        changed = box.card != card
        box.card = card
        if peer.device:
            box.device = peer.device
        peer.send({"type": "mail_state", "box": bid,
                   "dir": _directory(room),
                   "items": [_item(room, box, mid) for mid in box.entries]})
        room.broadcast({"type": "mail_dir", "dir": _directory(room)},
                       exclude=None if changed else peer.id)
        return None

    box = _my_box(room, peer)
    if box is None:
        return "Your mailbox isn't ready yet. Try again in a moment."

    if kind == "mail_send":
        mid = str(m.get("id") or "")
        if not MID.fullmatch(mid) or mid in s["mails"]:
            return "Please reload the page: CREW was updated."
        to = m.get("to")
        if not isinstance(to, list) or not to:
            return "Add at least one recipient."
        to = list(dict.fromkeys(str(t) for t in to))
        if len(to) > MAX_RECIPIENTS:
            return f"A mail can go to at most {MAX_RECIPIENTS} people."
        for t in to:
            b = s["boxes"].get(t)
            if not b or not b.card:
                return "One of the recipients' mailboxes no longer exists."
            if b.device and b.device in room.banned:
                return "One of the recipients was removed from the group."
        keys = m.get("keys")
        if not isinstance(keys, dict) or set(keys) != set(to) | {box.id}:
            return "Please reload the page: CREW was updated."
        keys = {k: _clean_b64(v, 200) for k, v in keys.items()}
        eph = _clean_b64(m.get("eph"), 200)
        blob = str(m.get("blob") or "")
        att = _clean_b64(m.get("att"), MAX_ATT)
        if (None in keys.values() or not eph or att is None
                or not blob.startswith(E2E_PREFIX) or len(blob) > MAX_BLOB):
            if att is None:
                return "The attachments are too big (2 MB at most). " \
                       "Use the Files tab for bigger files."
            return "That mail is too long." if len(blob) > MAX_BLOB \
                else "Please reload the page: CREW was updated."
        mail = Mail(mid, box.id, eph, blob, att, keys)
        if s["bytes"] + mail.size > MAX_GROUP_BYTES:
            return ("The group's mail storage is full. Ask people to "
                    "delete old mail (from Trash) first.")
        for bid in set(to) | {box.id}:
            if len(s["boxes"][bid].entries) >= MAX_PER_BOX:
                return ("Your mailbox is full. Delete some mail first."
                        if bid == box.id else
                        "A recipient's mailbox is full.")
        if room.rate((peer.id, "mail"), 60, 10):
            room.alert("Mail", "medium", "is sending a lot of mail (more "
                       "than 10 in a minute)", peer)
        if len(to) >= 5 and room.rate((peer.id, "mail-wide"), 600, 2):
            room.alert("Mail", "medium", "keeps sending mail to many "
                       "people at once", peer)
        s["mails"][mid], s["bytes"] = mail, s["bytes"] + mail.size
        for bid in set(to) | {box.id}:
            b = s["boxes"][bid]
            mine = bid == box.id
            b.entries[mid] = {"inbox": bid in to, "sent": mine,
                              "read": mine, "star": False,
                              "archived": False, "trash": False}
            _to_box(room, b, {"type": "mail_new",
                              "item": _item(room, b, mid)})
        return None

    ids = m.get("ids") if kind != "mail_att" else [m.get("id")]
    if not isinstance(ids, list):
        return "Nothing selected."
    ids = [str(i) for i in ids if str(i) in box.entries][:MAX_PER_BOX]

    if kind == "mail_flag":
        change = {f: bool(m[f]) for f in FLAGS if f in m}
        for mid in ids:
            box.entries[mid].update(change)
        if ids and change:
            _to_box(room, box, {"type": "mail_upd", "ids": ids,
                                "set": change})
        return None

    if kind == "mail_delete":
        for mid in ids:
            del box.entries[mid]
            _drop_unused(s, mid)
        if ids:
            _to_box(room, box, {"type": "mail_del", "ids": ids})
        return None

    if kind == "mail_att":
        mail = s["mails"].get(ids[0]) if ids else None
        if not mail:
            return "That mail no longer exists."
        peer.send({"type": "mail_att", "id": mail.id, "att": mail.att})
        return None

    return f"Unknown message type: {kind!r}"
