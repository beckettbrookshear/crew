/* CREW: the Mail tab. Gmail-style mail between the members of a group.
 *
 * Loaded after the main page script, so it can use its helpers ($, el, send,
 * S, peers, handle, setPeers, showJoin, fmtTime, crewE2E). It fills
 * <div id="tab-mail"> and wraps handle() to receive the mail_* messages
 * (see mail.py).
 *
 * Only the recipient can read a mail:
 *  - Each browser makes an ECDH (P-256) key pair for each group code and
 *    keeps it in IndexedDB. The private key is made non-extractable, so
 *    even this page's own scripts can't read it out, only use it.
 *  - Its public key goes on a "card" ({box, name, pub}) encrypted with the
 *    group key, so only group members can make or read cards and the host
 *    can't slip in a key of its own.
 *  - A mail is encrypted once (AES-256-GCM) with a random content key. That
 *    key is locked for each recipient (and for the sender's own Sent copy)
 *    with a key from HKDF over two ECDH results: a one-time key x recipient
 *    and sender x recipient. The second part means only the real sender
 *    could have made it, so the "From" can't be forged.
 *  - Each card's safety code (part of a hash of its public key) can be
 *    compared in person, like the host's certificate fingerprint.
 */
(() => {
  "use strict";
  const pane = document.getElementById("tab-mail");
  if (!pane) return;
  const tabBtn = document.querySelector('.tabs button[data-tab="mail"]');
  const countEl = document.getElementById("mailCount");

  const PREFIX = "e2e1:";
  const MAX_ATT = 2_000_000;      // bytes of attachments per mail (mail.py allows ~2 MB)
  const MAX_TEXT = 50_000;        // characters of text per mail
  const ECDH = { name: "ECDH", namedCurve: "P-256" };
  const subtle = globalThis.crypto && crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ---------- crypto helpers ----------
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  const b64 = bytes => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) { out.set(p, i); i += p.length; }
    return out;
  };
  const aes = (raw, uses = ["encrypt", "decrypt"]) => subtle.importKey("raw", raw, "AES-GCM", false, uses);
  async function seal(key, bytes, label) {
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(label) }, key, bytes));
    return concat(iv, ct);
  }
  async function unseal(key, data, label) {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12), additionalData: enc.encode(label) },
                                               key, data.subarray(12)));
  }
  const importPub = s => subtle.importKey("raw", unb64(s), ECDH, true, []);
  const ecdh = async (priv, pub) => new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
  const sha256 = async bytes => new Uint8Array(await subtle.digest("SHA-256", bytes));
  async function lockKey(ikm, id, info) {
    const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(id), info: enc.encode(info) },
                            base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const lockInfo = (eph, from, to) => `crew-mail-v1|${eph}|${from}|${to}`;
  async function safetyCode(pub) {
    const h = hex((await sha256(unb64(pub))).subarray(0, 6)).toUpperCase();
    return h.match(/.{4}/g).join(" ");
  }

  // ---------- this browser's mail key, kept per group code ----------
  let persistent = true;      // false if this browser won't keep it (private window etc.)
  const db = () => new Promise((res, rej) => {
    const r = indexedDB.open("crew-mail", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("ids");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  async function idb(mode, fn) {
    const d = await db();
    try {
      return await new Promise((res, rej) => {
        const t = d.transaction("ids", mode), req = fn(t.objectStore("ids"));
        t.oncomplete = () => res(req.result);
        t.onerror = t.onabort = () => rej(t.error);
      });
    } finally { d.close(); }
  }
  let ident = null;   // {room, secret, priv, pub, pubKey, box, code}
  async function identity(room) {
    if (ident && ident.room === room) return ident;
    let rec = null;
    try { rec = await idb("readonly", s => s.get(room)); } catch { persistent = false; }
    if (!rec) {
      const kp = await subtle.generateKey(ECDH, false, ["deriveBits"]);
      rec = { secret: hex(rand(32)), priv: kp.privateKey,
              pub: b64(new Uint8Array(await subtle.exportKey("raw", kp.publicKey))) };
      if (persistent) try { await idb("readwrite", s => s.put(rec, room)); } catch { persistent = false; }
    }
    const box = hex(await sha256(enc.encode(rec.secret))).slice(0, 24);
    ident = { room, ...rec, pubKey: await importPub(rec.pub), box, code: await safetyCode(rec.pub) };
    return ident;
  }

  // ---------- state ----------
  let myBox = "";
  const dir = new Map();        // box id -> {id, name, pub, pubKey, code, peers, gone}
  const cardCache = new Map();  // encrypted card -> decrypted card (or null)
  const items = new Map();      // mail id -> server item + c (content) / err
  const contentCache = new Map();
  const attWait = new Map();    // mail id -> resolve()
  let folder = "inbox", query = "", openThread = null;
  const selected = new Set();
  let ready = false, failed = "";
  let chain = Promise.resolve();          // handle mail messages in order
  const later = fn => { chain = chain.then(fn).catch(e => console.error("mail:", e)); };

  function reset() {
    myBox = ""; dir.clear(); items.clear(); selected.clear();
    openThread = null; ready = false; failed = "";
    closeCompose(true);
    render();
  }

  async function hello() {
    if (!S) return;
    try {
      if (!subtle) throw new Error("Mail needs a secure connection (CREW's https:// address).");
      const id = await identity(S.room);
      const card = await crewE2E.encryptText(JSON.stringify({ v: 1, box: id.box, name: S.name, pub: id.pub }), "mail-card");
      await send({ type: "mail_hello", secret: id.secret, card });
      failed = "";
    } catch (e) { failed = e.message; render(); }
  }

  async function setDir(list) {
    for (const d of list) {
      let card = cardCache.get(d.card);
      if (card === undefined) {
        try {
          card = JSON.parse(await crewE2E.decryptText(d.card, "mail-card"));
          // A card copied into someone else's mailbox doesn't count.
          if (card.box !== d.id || typeof card.pub !== "string") card = null;
          else card = { ...card, pubKey: await importPub(card.pub), code: await safetyCode(card.pub) };
        } catch { card = null; }
        cardCache.set(d.card, card);
      }
      if (!card) { dir.delete(d.id); continue; }
      dir.set(d.id, { id: d.id, name: String(card.name || "?").slice(0, 40), pub: card.pub, pubKey: card.pubKey,
                      code: card.code, peers: d.peers, gone: d.gone });
    }
  }

  async function unlock(it) {
    if (it.c || it.err) return;
    const cached = contentCache.get(it.id);
    if (cached) { Object.assign(it, cached); return; }
    try {
      const from = dir.get(it.from);
      if (!from) throw new Error("unknown sender");
      if (!it.key) throw new Error("no key");
      const [a, b] = await Promise.all([ecdh(ident.priv, await importPub(it.eph)), ecdh(ident.priv, from.pubKey)]);
      const lk = await lockKey(concat(a, b), it.id, lockInfo(it.eph, from.pub, ident.pub));
      const K = await aes(await unseal(lk, unb64(it.key), `mail-key|${it.id}|${myBox}`));
      const c = JSON.parse(dec.decode(await unseal(K, unb64(it.blob.slice(PREFIX.length)), "mail-body|" + it.id)));
      const got = { c: { thread: String(c.thread || it.id), subject: String(c.subject || ""), body: String(c.body || ""),
                         to: Array.isArray(c.to) ? c.to.map(String) : [], re: c.re || null,
                         atts: Array.isArray(c.atts) ? c.atts.map(a => ({ name: String(a.name || "file"), type: String(a.type || ""), size: +a.size || 0 })) : [] },
                    K };
      contentCache.set(it.id, got);
      Object.assign(it, got);
    } catch { it.err = true; }
  }

  // ---------- sending ----------
  async function sendMail({ to, subject, body, atts, thread, re }) {
    if (!ident || !myBox) throw new Error("Your mailbox isn't ready yet.");
    const id = hex(rand(10));
    const raw = rand(32), K = await aes(raw, ["encrypt"]);
    const content = { v: 1, thread: thread || id, subject, body, to, re: re || null,
                      atts: atts.map(a => ({ name: a.name, type: a.type, size: a.data.length })) };
    const blob = PREFIX + b64(await seal(K, enc.encode(JSON.stringify(content)), "mail-body|" + id));
    const att = atts.length ? b64(await seal(K, concat(...atts.map(a => a.data)), "mail-att|" + id)) : "";
    const eph = await subtle.generateKey(ECDH, false, ["deriveBits"]);
    const ephPub = b64(new Uint8Array(await subtle.exportKey("raw", eph.publicKey)));
    const keys = {};
    for (const bid of new Set([...to, myBox])) {
      const r = bid === myBox ? { pub: ident.pub, pubKey: ident.pubKey } : dir.get(bid);
      if (!r) throw new Error("One of the recipients' mailboxes is gone.");
      const [a, b] = await Promise.all([ecdh(eph.privateKey, r.pubKey), ecdh(ident.priv, r.pubKey)]);
      const lk = await lockKey(concat(a, b), id, lockInfo(ephPub, ident.pub, r.pub));
      keys[bid] = b64(await seal(lk, raw, `mail-key|${id}|${bid}`));
    }
    await send({ type: "mail_send", id, to, eph: ephPub, blob, att, keys });
  }

  async function attachments(it) {
    if (it.attData) return it.attData;
    const p = new Promise((res, rej) => { attWait.set(it.id, res); setTimeout(() => rej(new Error("The attachments didn't arrive.")), 30000); });
    await send({ type: "mail_att", id: it.id });
    const att = await p;
    const all = await unseal(it.K, unb64(att), "mail-att|" + it.id);
    let i = 0;
    it.attData = it.c.atts.map(a => { const d = all.subarray(i, i + a.size); i += a.size; return { ...a, data: d }; });
    return it.attData;
  }

  const flag = (ids, set) => ids.length && send({ type: "mail_flag", ids, ...set }).catch(e => showErr(e.message));
  const forget = ids => ids.length && send({ type: "mail_delete", ids }).catch(e => showErr(e.message));

  // ---------- threads and folders ----------
  const FOLDERS = [
    ["inbox", "Inbox", "📥"], ["starred", "Starred", "⭐"], ["sent", "Sent", "📤"],
    ["all", "All mail", "🗂"], ["trash", "Trash", "🗑"],
  ];
  const inFolder = (it, f) => f === "inbox" ? it.inbox && !it.archived && !it.trash
    : f === "starred" ? it.star && !it.trash : f === "sent" ? it.sent && !it.trash
    : f === "trash" ? it.trash : !it.trash;
  const unread = it => it.inbox && !it.read;

  function threads() {
    const by = new Map();
    for (const it of items.values()) {
      const t = it.c ? it.c.thread : it.id;
      if (!by.has(t)) by.set(t, []);
      by.get(t).push(it);
    }
    for (const list of by.values()) list.sort((a, b) => a.ts - b.ts);
    return by;
  }
  const threadMsgs = (list, f) => list.filter(it => f === "trash" ? it.trash : !it.trash);

  function nameOf(bid, { short = false } = {}) {
    if (bid === myBox) return short ? "me" : "Me";
    const d = dir.get(bid);
    if (!d) return "Unknown";
    const twin = [...dir.values()].some(o => o.id !== bid && o.name.toLowerCase() === d.name.toLowerCase());
    return twin ? `${d.name} (${d.code.slice(0, 4)})` : d.name;
  }
  const isOnline = d => d && d.peers.some(pid => peers.some(p => p.id === pid && p.online));

  function matches(list, q) {
    q = q.toLowerCase();
    return list.some(it => it.c && [it.c.subject, it.c.body, nameOf(it.from), ...it.c.to.map(b => nameOf(b)),
      ...it.c.atts.map(a => a.name)].some(s => s.toLowerCase().includes(q)));
  }

  function inboxUnread() {
    let n = 0;
    for (const list of threads().values()) if (list.some(it => inFolder(it, "inbox") && unread(it))) n++;
    return n;
  }

  // ---------- look ----------
  const style = document.createElement("style");
  style.textContent = `
    #tab-mail { padding: 0; }
    .ml { display: grid; grid-template-columns: 190px minmax(0, 1fr); min-height: 60vh; }
    #tab-mail .ml-side { padding: 14px 10px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px; }
    #tab-mail .ml-compose-btn { display: flex; align-items: center; gap: 10px; border: 0; border-radius: 16px; padding: 14px 20px;
                      background: var(--mine); font-weight: 600; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.12); width: fit-content; }
    #tab-mail .ml-compose-btn:hover { box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    #tab-mail .ml-folder { display: flex; align-items: center; gap: 12px; border: 0; background: none; border-radius: 0 99px 99px 0;
                 padding: 6px 12px 6px 14px; text-align: left; margin-left: -10px; width: calc(100% + 10px); }
    #tab-mail .ml-folder:hover { background: var(--soft); }
    #tab-mail .ml-folder.on { background: var(--mine); font-weight: 700; }
    #tab-mail .ml-folder .n { margin-left: auto; font-size: 12px; font-weight: 700; }
    #tab-mail .ml-safe { margin-top: auto; padding: 14px 4px 0; font-size: 12px; color: var(--muted); line-height: 1.45; }
    #tab-mail .ml-safe b { color: var(--text); font-weight: 600; }
    #tab-mail .ml-safe code { font-size: 12px; letter-spacing: .04em; color: var(--text); }
    #tab-mail .ml-safe button { font-size: 12px; padding: 2px 8px; margin-top: 6px; }
    #tab-mail .ml-main { min-width: 0; display: flex; flex-direction: column; }
    #tab-mail .ml-top { display: flex; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); align-items: center; }
    #tab-mail .ml-search { flex: 1; max-width: 560px; border-radius: 99px; background: var(--soft); border-color: transparent; padding: 9px 16px; }
    #tab-mail .ml-search:focus { background: var(--panel); border-color: var(--line); outline: none; box-shadow: 0 1px 4px rgba(0,0,0,.15); }
    #tab-mail .ml-bar { display: flex; gap: 4px; align-items: center; padding: 6px 12px; min-height: 44px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    #tab-mail .ml-bar button { border: 0; background: none; padding: 5px 10px; border-radius: 99px; font-size: 13px; }
    #tab-mail .ml-bar button:hover:not(:disabled) { background: var(--soft); }
    #tab-mail .ml-bar input[type=checkbox] { width: auto; margin: 0 8px 0 4px; }
    #tab-mail .ml-bar .info { margin-left: auto; font-size: 12px; color: var(--muted); }
    #tab-mail .ml-list { flex: 1; }
    #tab-mail .ml-row { display: grid; grid-template-columns: 22px 24px minmax(90px, 180px) minmax(0, 1fr) auto; gap: 8px; align-items: center;
              padding: 8px 12px; border-bottom: 1px solid var(--line); cursor: pointer; background: var(--soft); font-size: 14px; }
    #tab-mail .ml-row.unread { background: var(--panel); font-weight: 700; }
    #tab-mail .ml-row:hover { box-shadow: inset 1px 0 0 var(--line), inset -1px 0 0 var(--line), 0 1px 3px rgba(0,0,0,.15); position: relative; z-index: 1; }
    #tab-mail .ml-row.sel { background: var(--mine); }
    #tab-mail .ml-row input { width: auto; margin: 0; }
    #tab-mail .ml-row .who, #tab-mail .ml-row .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tab-mail .ml-row .what .snip { color: var(--muted); font-weight: 400; }
    #tab-mail .ml-row .when { font-size: 12px; white-space: nowrap; }
    #tab-mail .ml-row .cnt { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 4px; }
    #tab-mail .ml-star { border: 0; background: none; padding: 0; font-size: 16px; line-height: 1; color: var(--muted); }
    #tab-mail .ml-star.on { color: #f2b600; }
    #tab-mail .ml-empty { padding: 48px 16px; text-align: center; color: var(--muted); }
    #tab-mail .ml-thread { padding: 4px 16px 24px; }
    #tab-mail .ml-thread h2 { font-size: 22px; font-weight: 400; margin: 14px 0 14px 52px; word-wrap: break-word; }
    #tab-mail .ml-msg { border-bottom: 1px solid var(--line); padding: 12px 0; }
    #tab-mail .ml-msg .head { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; }
    .ml-av { width: 40px; height: 40px; border-radius: 50%; flex: none; display: grid; place-items: center; color: #fff; font-weight: 600; font-size: 17px; }
    #tab-mail .ml-msg .meta { flex: 1; min-width: 0; }
    #tab-mail .ml-msg .meta .nm { font-weight: 700; }
    #tab-mail .ml-msg .meta .code { font-size: 11px; color: var(--muted); margin-left: 6px; letter-spacing: .03em; }
    #tab-mail .ml-msg .meta .tos, #tab-mail .ml-msg .meta .snip { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tab-mail .ml-msg .side { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--muted); white-space: nowrap; }
    #tab-mail .ml-msg .side button { border: 0; background: none; padding: 4px 6px; border-radius: 99px; }
    #tab-mail .ml-msg .side button:hover { background: var(--soft); }
    #tab-mail .ml-body { margin: 10px 0 0 52px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.55; }
    #tab-mail .ml-body .q { color: var(--muted); border-left: 2px solid var(--line); padding-left: 10px; margin: 4px 0; }
    #tab-mail .ml-body .more { border: 1px solid var(--line); padding: 0 8px; font-size: 12px; line-height: 1.2; border-radius: 6px; background: var(--soft); }
    #tab-mail .ml-atts { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0 0 52px; }
    #tab-mail .ml-att { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; width: 180px; font-size: 13px; background: var(--panel); text-align: left; }
    #tab-mail .ml-att:hover { background: var(--soft); }
    #tab-mail .ml-att b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    #tab-mail .ml-att img { display: block; max-width: 100%; max-height: 110px; margin: 0 auto 6px; border-radius: 4px; }
    #tab-mail .ml-replies { display: flex; gap: 10px; margin: 18px 0 0 52px; flex-wrap: wrap; }
    #tab-mail .ml-replies button { border-radius: 99px; padding: 7px 18px; }
    #tab-mail .ml-locked { color: var(--muted); font-style: italic; }
    #tab-mail .ml-note { margin: 10px 12px; padding: 10px 12px; border-radius: 8px; background: var(--dm); font-size: 13px; }

    #mlc.ml-compose { position: fixed; right: 24px; bottom: 0; width: min(520px, calc(100vw - 16px)); z-index: 50;
                  background: var(--panel); border: 1px solid var(--line); border-radius: 10px 10px 0 0;
                  box-shadow: 0 8px 30px rgba(0,0,0,.3); display: flex; flex-direction: column; max-height: calc(100vh - 40px); }
    #mlc.ml-compose.min .ml-cbody { display: none; }
    #mlc .ml-chead { display: flex; align-items: center; gap: 6px; padding: 9px 10px 9px 14px; background: var(--soft);
                border-radius: 10px 10px 0 0; cursor: pointer; font-size: 14px; font-weight: 600; }
    #mlc .ml-chead span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #mlc .ml-chead button { border: 0; background: none; padding: 2px 8px; }
    #mlc .ml-cbody { display: flex; flex-direction: column; min-height: 0; }
    #mlc .ml-field { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; border-bottom: 1px solid var(--line); padding: 4px 14px; position: relative; }
    #mlc .ml-field > .lbl { color: var(--muted); font-size: 14px; }
    #mlc .ml-field input { border: 0; padding: 6px 0; flex: 1; min-width: 120px; border-radius: 0; }
    #mlc .ml-field input:focus, #mlc .ml-cbody textarea:focus { outline: none; }
    #mlc .ml-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--soft); border: 1px solid var(--line);
               border-radius: 99px; padding: 1px 4px 1px 10px; font-size: 13px; }
    #mlc .ml-chip button { border: 0; background: none; padding: 0 4px; line-height: 1; }
    #mlc .ml-sugg { position: absolute; left: 10px; right: 10px; top: 100%; z-index: 2; background: var(--panel); border: 1px solid var(--line);
               border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,.2); max-height: 240px; overflow-y: auto; }
    #mlc .ml-sugg > div { display: flex; gap: 10px; align-items: center; padding: 7px 12px; cursor: pointer; font-size: 14px; }
    #mlc .ml-sugg > div.on, #mlc .ml-sugg > div:hover { background: var(--soft); }
    #mlc .ml-sugg .ml-av { width: 28px; height: 28px; font-size: 13px; }
    #mlc .ml-sugg small { color: var(--muted); margin-left: auto; font-size: 11px; }
    #mlc .ml-cbody textarea { border: 0; border-radius: 0; min-height: 240px; flex: 1; resize: none; padding: 10px 14px; line-height: 1.5; }
    #mlc .ml-catts { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 6px; }
    #mlc .ml-catts .ml-chip { background: var(--mine); }
    #mlc .ml-cfoot { display: flex; align-items: center; gap: 6px; padding: 8px 14px 12px; }
    #mlc .ml-cfoot .primary { border-radius: 99px; padding: 8px 22px; }
    #mlc .ml-cfoot .ico { border: 0; background: none; font-size: 17px; padding: 4px 8px; }
    #mlc .ml-cfoot .ico:hover { background: var(--soft); }
    #mlc .ml-cfoot .error { margin: 0 0 0 4px; min-height: 0; font-size: 13px; flex: 1; }
    #mlc.ml-compose.drag { outline: 2px dashed var(--accent); outline-offset: -4px; }

    @media (max-width: 760px) {
      .ml { grid-template-columns: 1fr; }
      #tab-mail .ml-side { flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--line); gap: 4px; padding: 10px; }
      #tab-mail .ml-compose-btn { margin: 0 8px 0 0; padding: 8px 14px; }
      #tab-mail .ml-folder { margin: 0; width: auto; border-radius: 99px; padding: 5px 10px; }
      #tab-mail .ml-safe { flex-basis: 100%; padding-top: 6px; }
      #tab-mail .ml-row { grid-template-columns: 22px 22px minmax(0, 1fr) auto; }
      #tab-mail .ml-row .what { grid-column: 3 / 5; grid-row: 2; }
      #tab-mail .ml-thread h2, #tab-mail .ml-body, #tab-mail .ml-atts, #tab-mail .ml-replies { margin-left: 0; }
      #mlc.ml-compose { right: 8px; }
    }
  `;
  document.head.append(style);

  const avatar = bid => {
    const d = dir.get(bid), name = bid === myBox ? (S?.name || "Me") : d ? d.name : "?";
    let h = 0;
    for (const ch of bid) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return el("div", { className: "ml-av", textContent: name.trim().charAt(0).toUpperCase() || "?",
                       style: `background: hsl(${h} 55% 45%)` });
  };
  const fmtSize = n => n < 1000 ? n + " B" : n < 1e6 ? (n / 1e3).toFixed(0) + " KB" : (n / 1e6).toFixed(1) + " MB";
  function shortDate(ts) {
    const d = new Date(ts), n = new Date();
    if (d.toDateString() === n.toDateString()) return fmtTime(ts);
    if (d.getFullYear() === n.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString();
  }
  const longDate = ts => new Date(ts).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // ---------- page skeleton ----------
  const search = el("input", { className: "ml-search", type: "search", placeholder: "🔍  Search mail" });
  const side = el("div", { className: "ml-side" });
  const bar = el("div", { className: "ml-bar" });
  const body = el("div", { className: "ml-list" });
  const note = el("div", { className: "ml-note hidden" });
  pane.append(el("div", { className: "ml" }, side,
    el("div", { className: "ml-main" }, el("div", { className: "ml-top" }, search), note, bar, body)));
  search.addEventListener("input", () => { query = search.value.trim(); openThread = null; selected.clear(); render(); });

  let errTimer;
  function showErr(text) {
    note.textContent = "⚠️ " + text;
    note.classList.remove("hidden");
    clearTimeout(errTimer);
    errTimer = setTimeout(() => render(), 6000);
  }

  function render() {
    const n = inboxUnread();
    countEl.textContent = n;
    countEl.classList.toggle("hidden", !n);
    renderSide(n);
    note.classList.toggle("hidden", !(failed || !persistent));
    if (failed) note.textContent = "⚠️ Mail isn't working: " + failed;
    else if (!persistent) note.textContent = "⚠️ This browser won't keep your mail key (a private window?), so mail " +
      "sent to you can only be opened until you close this tab.";
    if (!ready) {
      bar.replaceChildren();
      body.replaceChildren(el("div", { className: "ml-empty", textContent: failed ? "" : "Opening your mailbox…" }));
      return;
    }
    const all = threads();
    if (openThread && all.has(openThread) && threadMsgs(all.get(openThread), folder).length) renderThread(all.get(openThread));
    else { openThread = null; renderList(all); }
  }

  function renderSide(n) {
    const counts = { inbox: n, trash: 0 };
    side.replaceChildren(
      el("button", { className: "ml-compose-btn", type: "button", onclick: () => compose({}) }, el("span", { textContent: "✏️" }), "Compose"),
      ...FOLDERS.map(([f, label, icon]) => el("button", {
        type: "button", className: "ml-folder" + (f === folder && !query ? " on" : ""),
        onclick: () => { folder = f; openThread = null; query = search.value = ""; selected.clear(); render(); },
      }, el("span", { textContent: icon }), label, el("span", { className: "n", textContent: counts[f] || "" }))),
      el("div", { className: "ml-safe" },
        "🔒 Only you can read your mail. ",
        el("span", { title: "Other people see this code next to your name. Compare codes in person to be sure mail is really from (and to) who it says." },
          "Your safety code: ", el("code", { textContent: ident?.code || "…" })),
        el("br"),
        el("button", { type: "button", textContent: "Forget my mail key here", title: "Use this on a shared computer. Mail already sent to you can't be opened afterwards.", onclick: forgetKey })));
  }

  async function forgetKey() {
    if (!S || !confirm("Delete this browser's mail key for this group?\n\nMail you already have will no longer open. " +
                       "You'll get a new, empty mailbox, and people will need to pick the new one when they write to you.")) return;
    try { await idb("readwrite", s => s.delete(S.room)); } catch {}
    ident = null; contentCache.clear(); items.clear(); ready = false;
    render();
    later(hello);
  }

  // ----- list of conversations -----
  function renderList(all) {
    let rows = [...all.entries()].map(([tid, list]) => ({ tid, list }));
    if (query) rows = rows.filter(r => matches(threadMsgs(r.list, "all"), query) && r.list.some(it => !it.trash));
    else rows = rows.filter(r => r.list.some(it => inFolder(it, folder)));
    rows.sort((a, b) => b.list[b.list.length - 1].ts - a.list[a.list.length - 1].ts);
    for (const t of [...selected]) if (!rows.some(r => r.tid === t)) selected.delete(t);

    const f = query ? "all" : folder;
    const pick = () => rows.filter(r => selected.has(r.tid)).flatMap(r => threadMsgs(r.list, f));
    const ids = list => list.map(it => it.id);
    const all_ = el("input", { type: "checkbox", title: "Select all", checked: rows.length && selected.size === rows.length,
      onchange: e => { selected.clear(); if (e.target.checked) rows.forEach(r => selected.add(r.tid)); render(); } });
    const act = (label, title, fn) => el("button", { type: "button", textContent: label, title, onclick: () => { fn(pick()); selected.clear(); } });
    const tools = selected.size ? [
      ...(f === "inbox" ? [act("📦 Archive", "Archive (e)", l => flag(ids(l), { archived: true }))] : []),
      ...(f === "trash" || f === "all" ? [act("📥 Move to Inbox", "", l => flag(ids(l), { archived: false, trash: false }))] : []),
      f === "trash" ? act("Delete forever", "", l => forget(ids(l))) : act("🗑 Delete", "Delete (#)", l => flag(ids(l), { trash: true })),
      act("Mark as read", "", l => flag(ids(l), { read: true })),
      act("Mark as unread", "", l => flag(ids(l.filter(it => it.inbox)), { read: false })),
    ] : f === "trash" && rows.length ? [el("button", { type: "button", textContent: "Empty Trash now",
      onclick: () => confirm("Delete everything in Trash for good?") && forget(rows.flatMap(r => ids(threadMsgs(r.list, "trash")))) })] : [];
    bar.replaceChildren(all_, ...tools, el("span", { className: "info",
      textContent: query ? `Search results · ${rows.length}` : rows.length ? `${rows.length} conversation${rows.length > 1 ? "s" : ""}` : "" }));

    if (!rows.length) {
      const empty = query ? "No mail matched your search." : {
        inbox: "Your inbox is empty. Mail from people in your group shows up here, even mail sent while you were away.",
        starred: "No starred mail. Stars let you mark mail as important.",
        sent: "You haven't sent any mail yet. Click Compose to write to someone in your group.",
        all: "No mail yet.", trash: "Trash is empty." }[folder];
      body.replaceChildren(el("div", { className: "ml-empty", textContent: empty }));
      return;
    }
    body.replaceChildren(...rows.map(({ tid, list }) => {
      const shown = threadMsgs(list, f), last = shown[shown.length - 1] || list[list.length - 1];
      const first = shown.find(it => it.c) || shown[0];
      const isUnread = shown.some(unread), starred = shown.some(it => it.star);
      let who;
      if (f === "sent") who = "To: " + [...new Set(shown.filter(it => it.sent && it.c).flatMap(it => it.c.to))].map(b => nameOf(b, { short: true })).join(", ");
      else who = [...new Set(shown.map(it => it.from))].map(b => nameOf(b, { short: true })).join(", ");
      const subject = first?.c ? first.c.subject || "(no subject)" : first?.err ? "🔒 Can't be opened in this browser" : "Unlocking…";
      const snip = last?.c ? last.c.body.replace(/\s+/g, " ").slice(0, 160) : "";
      const hasAtt = shown.some(it => it.c?.atts.length);
      const row = el("div", { className: "ml-row" + (isUnread ? " unread" : "") + (selected.has(tid) ? " sel" : ""),
        onclick: () => { openThread = tid; selected.clear(); render(); markRead(shown); } },
        el("input", { type: "checkbox", checked: selected.has(tid), title: "Select",
          onclick: e => e.stopPropagation(),
          onchange: e => { e.target.checked ? selected.add(tid) : selected.delete(tid); render(); } }),
        el("button", { type: "button", className: "ml-star" + (starred ? " on" : ""), textContent: starred ? "★" : "☆",
          title: starred ? "Starred" : "Not starred",
          onclick: e => { e.stopPropagation(); flag(starred ? shown.filter(it => it.star).map(it => it.id) : [last.id], { star: !starred }); } }),
        el("span", { className: "who" }, who, ...(shown.length > 1 ? [el("span", { className: "cnt", textContent: shown.length })] : [])),
        el("span", { className: "what" }, subject, el("span", { className: "snip", textContent: snip ? " – " + snip : "" })),
        el("span", { className: "when", textContent: (hasAtt ? "📎 " : "") + shortDate(last.ts), title: longDate(last.ts) }));
      return row;
    }));
  }

  function markRead(list) { flag(list.filter(unread).map(it => it.id), { read: true }); }

  // ----- one conversation -----
  const expanded = new Set();
  function renderThread(list) {
    const f = query ? "all" : folder;
    const shown = threadMsgs(list, f), ids = shown.map(it => it.id);
    const btn = (label, title, fn) => el("button", { type: "button", textContent: label, title, onclick: fn });
    const back = () => { openThread = null; render(); };
    bar.replaceChildren(
      btn("← Back", "Back to the list (u)", back),
      ...(shown.some(it => inFolder(it, "inbox")) ? [btn("📦 Archive", "Archive (e)", () => { flag(ids, { archived: true }); back(); })]
          : [btn("📥 Move to Inbox", "", () => flag(ids, { archived: false, trash: false }))]),
      f === "trash" ? btn("Delete forever", "", () => { forget(ids); back(); })
                    : btn("🗑 Delete", "Delete (#)", () => { flag(ids, { trash: true }); back(); }),
      btn("✉️ Mark as unread", "", () => { flag(shown.filter(it => it.inbox).map(it => it.id), { read: false }); back(); }));

    const first = shown.find(it => it.c);
    const lastI = shown.length - 1;
    body.replaceChildren(el("div", { className: "ml-thread" },
      el("h2", { textContent: first ? first.c.subject || "(no subject)" : "Locked mail" }),
      ...shown.map((it, i) => {
        const open = i === lastI || unread(it) || expanded.has(it.id);
        return message(it, open, () => { expanded.has(it.id) ? expanded.delete(it.id) : expanded.add(it.id); render(); });
      }),
      ...(shown[lastI]?.c ? [el("div", { className: "ml-replies" },
        btn("↩️ Reply", "Reply (r)", () => reply(shown[lastI], false)),
        ...(replyAllTo(shown[lastI]).length > 1 ? [btn("↩️ Reply all", "Reply all (a)", () => reply(shown[lastI], true))] : []),
        btn("↪️ Forward", "Forward (f)", () => forward(shown[lastI])))] : [])));
  }

  function message(it, open, toggle) {
    const d = dir.get(it.from);
    const head = el("div", { className: "head", onclick: toggle }, avatar(it.from),
      el("div", { className: "meta" },
        el("span", { className: "nm", textContent: it.from === myBox ? (S?.name || "Me") + " (me)" : nameOf(it.from) }),
        el("span", { className: "code", textContent: d ? "🔑 " + d.code : "", title: "Safety code. Compare it in person to be sure who sent this." }),
        open && it.c ? el("div", { className: "tos", textContent: "to " + it.c.to.map(b => nameOf(b, { short: true })).join(", ") })
                     : el("div", { className: "snip", textContent: it.c ? it.c.body.replace(/\s+/g, " ").slice(0, 140) : "" })),
      el("div", { className: "side" },
        el("span", { textContent: (it.c?.atts.length ? "📎 " : "") + longDate(it.ts) }),
        el("button", { type: "button", className: "ml-star" + (it.star ? " on" : ""), textContent: it.star ? "★" : "☆",
          title: it.star ? "Starred" : "Not starred", onclick: e => { e.stopPropagation(); flag([it.id], { star: !it.star }); } }),
        ...(open && it.c ? [el("button", { type: "button", textContent: "↩️", title: "Reply",
          onclick: e => { e.stopPropagation(); reply(it, false); } })] : [])));
    const node = el("div", { className: "ml-msg" }, head);
    if (!open) return node;
    if (!it.c) {
      node.append(el("div", { className: "ml-body ml-locked", textContent: it.err
        ? "This mail can't be opened in this browser. Mail can only be read in the browser it was sent to, " +
          "with the mail key that browser keeps."
        : "Unlocking…" }));
      return node;
    }
    node.append(el("div", { className: "ml-body" }, ...renderBody(it.c.body)));
    if (it.c.atts.length) {
      const box = el("div", { className: "ml-atts" });
      it.c.atts.forEach((a, i) => {
        const b = el("button", { type: "button", className: "ml-att", title: "Download " + a.name },
          el("b", { textContent: "📎 " + a.name }), el("span", { className: "muted", textContent: fmtSize(a.size) }));
        b.onclick = () => saveAtt(it, i, b);
        if (/^image\/(png|jpe?g|gif|webp)$/.test(a.type)) preview(it, i, b);
        box.append(b);
      });
      node.append(box);
    }
    return node;
  }

  // Text, with quoted lines (starting with ">") tucked away like Gmail's "•••".
  function renderBody(text) {
    const out = [], lines = text.split("\n");
    let plain = [], quote = [];
    const flushPlain = () => { if (plain.length) out.push(...linkify(plain.join("\n"))); plain = []; };
    const flushQuote = () => {
      if (!quote.length) return;
      const q = el("div", { className: "q hidden", textContent: quote.join("\n") });
      out.push(el("button", { type: "button", className: "more", textContent: "•••", title: "Show quoted text",
        onclick: () => q.classList.toggle("hidden") }), q);
      quote = [];
    };
    lines.forEach((line, i) => {
      const quoted = /^\s*>/.test(line) || (/^On .+ wrote:$/.test(line) && /^\s*>/.test(lines[i + 1] || ""));
      if (quoted) { flushPlain(); quote.push(line); }
      else { flushQuote(); plain.push(line); }
    });
    flushPlain(); flushQuote();
    return out;
  }
  function linkify(text) {
    const parts = text.split(/(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/);
    return parts.map((p, i) => i % 2 ? el("a", { href: p, textContent: p, rel: "noopener noreferrer",
      onclick: e => { if (window.crewBrowse) { e.preventDefault(); document.querySelector('.tabs button[data-tab="browse"]')?.click(); crewBrowse.open(p); } },
      target: "_blank" }) : document.createTextNode(p));
  }

  async function saveAtt(it, i, btn) {
    try {
      btn.disabled = true;
      const a = (await attachments(it))[i];
      const url = URL.createObjectURL(new Blob([a.data], { type: a.type || "application/octet-stream" }));
      const link = el("a", { href: url, download: a.name });
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { showErr(e.message); }
    finally { btn.disabled = false; }
  }
  async function preview(it, i, btn) {
    try {
      const a = (await attachments(it))[i];
      const img = el("img", { alt: "", src: URL.createObjectURL(new Blob([a.data], { type: a.type })) });
      btn.prepend(img);
    } catch {}
  }

  // ---------- compose ----------
  let cmp = null;   // {node, to: [box ids], atts: [{name, type, data}], thread, re, ...}

  function closeCompose(force) {
    if (!cmp) return;
    if (!force && (cmp.text.value.trim() || cmp.atts.length) && !cmp.sent &&
        !confirm("Discard this draft?")) return;
    cmp.node.remove();
    cmp = null;
  }

  function compose({ to = [], subject = "", text = "", thread = null, re = null, atts = [], focus = "to" }) {
    if (cmp) {
      if ((cmp.text.value.trim() || cmp.atts.length) && !confirm("Replace the mail you're writing?")) { cmp.node.classList.remove("min"); return; }
      cmp.node.remove();
    }
    const title = el("span", { textContent: subject || "New message" });
    const minBtn = el("button", { type: "button", textContent: "▁", title: "Minimize" });
    const xBtn = el("button", { type: "button", textContent: "✕", title: "Close" });
    const chips = el("span", { style: "display:contents" });
    const toIn = el("input", { placeholder: "", autocomplete: "off", ariaLabel: "To" });
    const sugg = el("div", { className: "ml-sugg hidden" });
    const subj = el("input", { placeholder: "Subject", value: subject, ariaLabel: "Subject", maxLength: 200 });
    const textArea = el("textarea", { value: text, ariaLabel: "Message", maxLength: MAX_TEXT });
    const attList = el("div", { className: "ml-catts" });
    const fileIn = el("input", { type: "file", multiple: true, className: "hidden" });
    const sendBtn = el("button", { type: "button", className: "primary", textContent: "Send", title: "Send (Ctrl+Enter)" });
    const err = el("span", { className: "error" });
    const node = el("div", { id: "mlc", className: "ml-compose", role: "dialog", ariaLabel: "New message" },
      el("div", { className: "ml-chead", onclick: e => { if (e.target === e.currentTarget || e.target === title) node.classList.toggle("min"); } },
        title, minBtn, xBtn),
      el("div", { className: "ml-cbody" },
        el("div", { className: "ml-field" }, el("span", { className: "lbl", textContent: "To" }), chips, toIn, sugg),
        el("div", { className: "ml-field" }, subj),
        textArea, attList,
        el("div", { className: "ml-cfoot" }, sendBtn,
          el("button", { type: "button", className: "ico", textContent: "📎", title: "Attach files (2 MB in total)", onclick: () => fileIn.click() }),
          fileIn, err,
          el("button", { type: "button", className: "ico", textContent: "🗑", title: "Discard draft", onclick: () => closeCompose() }))));
    document.body.append(node);
    cmp = { node, to: [...new Set(to)].filter(b => b !== myBox || to.length === 1), atts: [...atts], thread, re, text: textArea, sent: false };

    minBtn.onclick = () => node.classList.toggle("min");
    xBtn.onclick = () => closeCompose();
    subj.oninput = () => title.textContent = subj.value || "New message";

    const drawChips = () => chips.replaceChildren(...cmp.to.map(b => el("span", { className: "ml-chip",
      title: dir.get(b) ? "Safety code " + dir.get(b).code : "" }, b === myBox ? "Me" : nameOf(b),
      el("button", { type: "button", textContent: "×", title: "Remove", onclick: () => { cmp.to = cmp.to.filter(x => x !== b); drawChips(); toIn.focus(); } }))));
    let sel = 0, opts = [];
    const showSugg = () => {
      const q = toIn.value.trim().toLowerCase();
      opts = [...dir.values()].filter(d => !d.gone && !cmp.to.includes(d.id) && (!q || d.name.toLowerCase().includes(q)))
        .sort((a, b) => (a.id === myBox) - (b.id === myBox) || isOnline(b) - isOnline(a) || a.name.localeCompare(b.name));
      sel = Math.min(sel, Math.max(0, opts.length - 1));
      sugg.replaceChildren(...opts.map((d, i) => el("div", { className: i === sel ? "on" : "",
        onmousedown: e => { e.preventDefault(); add(d.id); } },
        avatar(d.id), el("span", {}, d.id === myBox ? d.name + " (me)" : nameOf(d.id)),
        el("small", { textContent: (isOnline(d) ? "● online · " : "") + "🔑 " + d.code }))));
      if (!opts.length) sugg.append(el("div", { className: "muted", textContent: dir.size ? "Nobody else matches." : "Nobody else has a mailbox yet." }));
      sugg.classList.remove("hidden");
    };
    const add = bid => { cmp.to.push(bid); toIn.value = ""; sel = 0; drawChips(); showSugg(); };
    toIn.addEventListener("focus", showSugg);
    toIn.addEventListener("input", () => { sel = 0; showSugg(); });
    toIn.addEventListener("blur", () => sugg.classList.add("hidden"));
    toIn.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % Math.max(1, opts.length); showSugg(); }
      else if ((e.key === "Enter" || e.key === "," || (e.key === "Tab" && toIn.value)) && opts[sel]) { e.preventDefault(); add(opts[sel].id); }
      else if (e.key === "Backspace" && !toIn.value && cmp.to.length) { cmp.to.pop(); drawChips(); showSugg(); }
      else if (e.key === "Escape") sugg.classList.add("hidden");
    });

    const drawAtts = () => attList.replaceChildren(...cmp.atts.map((a, i) => el("span", { className: "ml-chip" },
      `📎 ${a.name} (${fmtSize(a.data.length)})`,
      el("button", { type: "button", textContent: "×", title: "Remove", onclick: () => { cmp.atts.splice(i, 1); drawAtts(); } }))));
    const addFiles = async files => {
      err.textContent = "";
      for (const f of files) {
        const total = cmp.atts.reduce((n, a) => n + a.data.length, 0) + f.size;
        if (total > MAX_ATT) { err.textContent = `Attachments can be ${fmtSize(MAX_ATT)} in total. Use the Files tab for bigger files.`; break; }
        cmp.atts.push({ name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) });
      }
      drawAtts();
    };
    fileIn.onchange = () => { addFiles([...fileIn.files]); fileIn.value = ""; };
    node.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); node.classList.add("drag"); } });
    node.addEventListener("dragleave", () => node.classList.remove("drag"));
    node.addEventListener("drop", e => { e.preventDefault(); node.classList.remove("drag"); addFiles([...e.dataTransfer.files]); });

    const doSend = async () => {
      err.textContent = "";
      if (toIn.value.trim() && opts[sel]) add(opts[sel].id);
      if (!cmp.to.length) { err.textContent = "Add at least one recipient."; toIn.focus(); return; }
      if (!subj.value.trim() && !textArea.value.trim() && !confirm("Send this mail without a subject or text?")) return;
      sendBtn.disabled = true; sendBtn.textContent = "Sending…";
      try {
        await sendMail({ to: cmp.to, subject: subj.value.trim(), body: textArea.value, atts: cmp.atts, thread: cmp.thread, re: cmp.re });
        cmp.sent = true;
        closeCompose(true);
        toast("Message sent.");
      } catch (e) { err.textContent = e.message; sendBtn.disabled = false; sendBtn.textContent = "Send"; }
    };
    sendBtn.onclick = doSend;
    node.addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); }
      if (e.key === "Escape" && e.target !== toIn) node.classList.add("min");
    });

    drawChips(); drawAtts();
    ({ to: cmp.to.length ? textArea : toIn, text: textArea }[focus] || toIn).focus();
    if (focus === "text") textArea.setSelectionRange(0, 0);
  }

  const replyAllTo = it => [...new Set([it.from, ...it.c.to])].filter(b => b !== myBox && dir.has(b) && !dir.get(b).gone);
  function quote(it) {
    return `\n\nOn ${longDate(it.ts)}, ${it.from === myBox ? S?.name || "I" : nameOf(it.from)} wrote:\n` +
      it.c.body.split("\n").map(l => "> " + l).join("\n");
  }
  function reply(it, all) {
    let to = all ? replyAllTo(it) : [it.from];
    if (it.from === myBox && !all) to = it.c.to;            // replying to my own mail: same people again
    if (!to.length) to = it.c.to;
    compose({ to, subject: /^re:/i.test(it.c.subject) ? it.c.subject : "Re: " + it.c.subject,
              text: quote(it), thread: it.c.thread, re: it.id, focus: "text" });
  }
  async function forward(it) {
    let atts = [];
    try { if (it.c.atts.length) atts = (await attachments(it)).map(a => ({ name: a.name, type: a.type, data: a.data })); }
    catch (e) { showErr("Couldn't include the attachments: " + e.message); }
    const head = `\n\n---------- Forwarded message ---------\nFrom: ${nameOf(it.from)}\nDate: ${longDate(it.ts)}\n` +
      `Subject: ${it.c.subject}\nTo: ${it.c.to.map(b => nameOf(b)).join(", ")}\n\n`;
    compose({ subject: /^fwd?:/i.test(it.c.subject) ? it.c.subject : "Fwd: " + it.c.subject, text: head + it.c.body, atts });
  }

  // ---------- notifications ----------
  function toast(text, open) {
    const box = document.getElementById("toasts");
    if (!box) return;
    const t = el("div", { className: "toast", style: "border-left-color: var(--accent)" },
      el("div", { textContent: text }),
      ...(open ? [el("div", { className: "row", style: "margin-top:8px" },
        el("button", { type: "button", className: "small primary", textContent: "Open", onclick: () => { t.remove(); open(); } }),
        el("button", { type: "button", className: "small", textContent: "Dismiss", onclick: () => t.remove() }))] : []));
    box.append(t);
    setTimeout(() => t.remove(), open ? 8000 : 3000);
  }

  // ---------- keyboard shortcuts (Gmail's) ----------
  document.addEventListener("keydown", e => {
    if (tab !== "mail" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    const list = openThread && threads().get(openThread);
    const last = list && threadMsgs(list, query ? "all" : folder).filter(it => it.c).pop();
    const click = text => [...bar.querySelectorAll("button")].find(b => b.textContent.trim().endsWith(text))?.click();
    const keys = {
      c: () => compose({}),
      "/": () => search.focus(),
      e: () => click("Archive"),
      "#": () => click("Delete"),
      u: () => { openThread = null; render(); },
      r: () => last && reply(last, false),
      a: () => last && reply(last, replyAllTo(last).length > 1),
      f: () => last && forward(last),
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });

  // ---------- hooks into the main page ----------
  function openTab() {
    document.querySelector('.tabs button[data-tab="mail"]')?.click();
  }
  tabBtn?.addEventListener("click", () => render());

  const origHandle = handle;
  handle = function (m) {
    switch (m.type) {
      case "mail_state":
        later(async () => {
          if (!S) return;
          const id = await identity(S.room);
          if (m.box !== id.box) { failed = "The server gave us the wrong mailbox."; render(); return; }
          myBox = m.box;
          await setDir(m.dir);
          const old = new Map(items);
          items.clear();
          for (const it of m.items) items.set(it.id, Object.assign(old.get(it.id) || {}, it));
          await Promise.all([...items.values()].map(unlock));
          ready = true;
          render();
        });
        return;
      case "mail_dir":
        later(async () => {
          await setDir(m.dir);
          for (const it of items.values()) if (it.err && dir.has(it.from)) { it.err = false; await unlock(it); }
          render();
        });
        return;
      case "mail_new":
        later(async () => {
          const it = Object.assign(items.get(m.item.id) || {}, m.item);
          items.set(it.id, it);
          await unlock(it);
          render();
          if (it.inbox && it.from !== myBox && !(tab === "mail" && document.hasFocus())) {
            const subject = it.c ? it.c.subject || "(no subject)" : "a new mail";
            if (window.crewPrefs?.get("notify") && document.hidden) crewPrefs.notify("New mail from " + nameOf(it.from), subject);
            toast(`✉️ ${nameOf(it.from)}: ${subject}`, () => { openTab(); folder = "inbox"; query = search.value = "";
              openThread = it.c?.thread || it.id; render(); markRead([it]); });
          } else if (it.inbox && openThread && openThread === it.c?.thread && tab === "mail") markRead([it]);
        });
        return;
      case "mail_upd":
        later(() => { for (const id of m.ids) if (items.has(id)) Object.assign(items.get(id), m.set); render(); });
        return;
      case "mail_del":
        later(() => { for (const id of m.ids) items.delete(id); render(); });
        return;
      case "mail_att":
        attWait.get(m.id)?.(m.att); attWait.delete(m.id);
        return;
    }
    const r = origHandle(m);
    if (m.type === "welcome") later(hello);
    return r;
  };

  const origSetPeers = setPeers;
  setPeers = function (list, max) {
    const r = origSetPeers(list, max);
    if (tab === "mail" && ready && !openThread) render();
    return r;
  };

  const origShowJoin = showJoin;
  showJoin = function (msg) {
    reset();
    ident = null; contentCache.clear(); cardCache.clear();
    return origShowJoin(msg);
  };

  window.crewMail = { compose, open: openTab };
  render();
})();
