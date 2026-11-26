/* CREW built-in browser: the Browse tab.
 *
 * Loaded after the main page script, so it can use its helpers
 * ($, el, send, S, peers, addChat, handle, setPeers). It fills
 * <div id="tab-browse"> and adds to a few of the page's functions
 * by wrapping them, so the main script needs no browser code.
 *
 * Pages are fetched by the CREW server (see browse.py) and shown in a
 * sandboxed frame, so a page can't touch CREW or your session.
 */
(() => {
  "use strict";
  const pane = document.getElementById("tab-browse");
  if (!pane) return;

  const HOME = [
    ["MDN: JavaScript, HTML, CSS", "https://developer.mozilla.org/en-US/"],
    ["Python docs", "https://docs.python.org/3/"],
    ["DuckDuckGo search", "https://html.duckduckgo.com/html/"],
    ["Wikipedia", "https://en.wikipedia.org/"],
    ["Linux kernel archives", "https://www.kernel.org/"],
  ];

  let key = "";                 // browse-only key from the server
  let hist = [], at = -1;       // our own back/forward list
  let current = { url: "", title: "" };
  let leading = false;          // others can follow me
  let following = "";           // peer id I'm following
  let loadTimer = null;

  // ---------- layout ----------
  const style = document.createElement("style");
  style.textContent = `
    #tab-browse .bbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    #tab-browse .bbar input[type=text] { flex: 1; min-width: 180px; width: auto; }
    #tab-browse .bbar button { padding: 6px 10px; }
    #tab-browse .brow2 { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 8px 0; font-size: 14px; }
    #tab-browse .brow2 select { width: auto; max-width: 260px; }
    #tab-browse .bview { position: relative; border: 1px solid var(--line); border-radius: var(--r, 10px); overflow: hidden;
                         height: calc(100vh - 290px); min-height: 380px; background: #fff; }
    #tab-browse iframe { border: 0; width: 100%; height: 100%; display: block; background: #fff; }
    #tab-browse .bstart { position: absolute; inset: 0; overflow: auto; padding: 28px 24px; background: var(--panel); }
    #tab-browse .bstart h3 { margin: 0 0 6px; }
    #tab-browse .bquick { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 20px; }
    #tab-browse .bnote { font-size: 13px; color: var(--muted); max-width: 640px; }
    #tab-browse .bnote li { margin: 3px 0; }
    #tab-browse .bloading { position: absolute; left: 0; top: 0; height: 3px; width: 0; background: var(--accent); transition: width 8s cubic-bezier(.1,.7,.2,1); }
    #tab-browse .bloading.on { width: 85%; }
    #tab-browse .bmsg { font-size: 13px; color: var(--muted); min-height: 1.3em; }
    #tab-browse .bmsg.warn { color: var(--warn); }
    .msg .blink { display: inline-block; margin-top: 6px; }
  `;
  document.head.append(style);

  const back = el("button", { type: "button", textContent: "◀", title: "Back (Alt+←)", disabled: true });
  const fwd = el("button", { type: "button", textContent: "▶", title: "Forward (Alt+→)", disabled: true });
  const reload = el("button", { type: "button", textContent: "⟳", title: "Reload" });
  const homeBtn = el("button", { type: "button", textContent: "⌂", title: "Start page" });
  const addr = el("input", { type: "text", placeholder: "Search, or type a web address", spellcheck: false, autocomplete: "off" });
  addr.setAttribute("aria-label", "Address");
  const go = el("button", { type: "submit", className: "primary", textContent: "Go" });
  const shareBtn = el("button", { type: "button", textContent: "Send to group", title: "Post this page in the chat", disabled: true });
  const ext = el("a", { textContent: "Open in your browser ↗", target: "_blank", rel: "noopener noreferrer", className: "hidden" });

  const leadBox = el("input", { type: "checkbox" });
  const followSel = el("select", { title: "Follow someone who is sharing their browsing" });
  const msg = el("div", { className: "bmsg" });

  const frame = el("iframe", { title: "Web page", referrerPolicy: "no-referrer" });
  frame.setAttribute("sandbox", "allow-scripts allow-forms");   // no CREW access, no pop-ups
  const loading = el("div", { className: "bloading" });
  const start = el("div", { className: "bstart" },
    el("h3", { textContent: "Browse the web together" }),
    el("div", { className: "muted", textContent: "Type an address or a search above, or pick a place to start." }),
    el("div", { className: "bquick" }, ...HOME.map(([label, url]) =>
      el("button", { type: "button", textContent: label, onclick: () => navigate(url) }))),
    el("ul", { className: "bnote" },
      el("li", { textContent: "Send to group posts the page in the chat. Let others follow me makes everyone who follows you see the pages you open." }),
      el("li", { textContent: "Pages are fetched by the CREW host computer, so websites see the host's internet address, not yours." }),
      el("li", { textContent: "Signing in, buying things, videos and big web apps (Google Docs, YouTube…) won't work here. Use Open in your browser for those." }),
      el("li", { textContent: "Addresses on your own network (routers, printers, other computers) are blocked." })));

  const form = el("form", { className: "bbar" }, back, fwd, reload, homeBtn, addr, go, shareBtn);
  pane.append(
    form,
    el("div", { className: "brow2" },
      el("label", { className: "switch" }, leadBox, " Let others follow me"),
      followSel, ext),
    msg,
    el("div", { className: "bview" }, frame, loading, start));

  // ---------- navigation ----------
  function toURL(text) {
    text = text.trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(text)) return "https://" + text;
    return "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(text);
  }
  const isWeb = u => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

  function navigate(url, opts = {}) {
    if (!isWeb(url) || !S) return;
    if (following && !opts.remote) stopFollowing("You went somewhere else, so you stopped following.");
    if (!opts.history) { hist = hist.slice(0, at + 1); hist.push(url); at = hist.length - 1; }
    current = { url, title: "" };
    addr.value = url;
    start.classList.add("hidden");
    note("");
    setLoading(true);
    const q = new URLSearchParams({ room: S.room, id: S.id, key, url });
    try { frame.contentWindow.location.replace("/api/browse?" + q); }
    catch { frame.src = "/api/browse?" + q; }
    updateButtons();
  }
  function showStart() {
    current = { url: "", title: "" };
    addr.value = "";
    try { frame.contentWindow.location.replace("about:blank"); } catch {}
    start.classList.remove("hidden");
    setLoading(false);
    updateButtons();
  }
  function setLoading(on) {
    clearTimeout(loadTimer);
    loading.style.transition = on ? "" : "none";
    loading.classList.toggle("on", on);
    if (on) loadTimer = setTimeout(() => setLoading(false), 20000);
  }
  function updateButtons() {
    back.disabled = at <= 0;
    fwd.disabled = at >= hist.length - 1;
    shareBtn.disabled = !current.url;
    ext.classList.toggle("hidden", !current.url);
    if (current.url) ext.href = current.url;
  }
  function note(text, warn) { msg.textContent = text; msg.classList.toggle("warn", !!warn); }

  form.addEventListener("submit", e => {
    e.preventDefault();
    const url = toURL(addr.value);
    if (url) navigate(url);
  });
  back.onclick = () => { if (at > 0) navigate(hist[--at], { history: true }); };
  fwd.onclick = () => { if (at < hist.length - 1) navigate(hist[++at], { history: true }); };
  reload.onclick = () => current.url && navigate(current.url, { history: true });
  homeBtn.onclick = () => { if (following) stopFollowing(""); showStart(); };
  addr.addEventListener("focus", () => addr.select());
  pane.addEventListener("keydown", e => {
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); back.onclick(); }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); fwd.onclick(); }
  });

  // Messages from the page in the frame (link clicks, searches, "loaded").
  addEventListener("message", e => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.crew === "nav" && typeof d.url === "string") navigate(d.url);
    else if (d.crew === "post") note("This page wants to send a form (like a sign-in or checkout). That doesn't work in CREW's browser; use Open in your browser instead.", true);
    else if (d.crew === "loaded") {
      setLoading(false);
      if (typeof d.url === "string" && isWeb(d.url)) {       // after redirects
        current = { url: d.url, title: String(d.title || "").slice(0, 200) };
        hist[at] = d.url;
        addr.value = d.url;
      }
      updateButtons();
      if (leading && !d.error) send({ type: "browse_nav", ...current }).catch(() => {});
    }
  });

  // ---------- sharing & following ----------
  shareBtn.onclick = async () => {
    try { await send({ type: "share_page", ...current }); note("Sent to the group chat."); }
    catch (x) { note(x.message, true); }
  };

  leadBox.onchange = async () => {
    leading = leadBox.checked;
    if (leading && following) stopFollowing("");
    try { await send({ type: "browse_lead", on: leading, ...current }); }
    catch (x) { leading = leadBox.checked = false; note(x.message, true); }
    note(leading ? "People who follow you will see every page you open here." : "");
  };

  followSel.onchange = () => {
    following = followSel.value;
    if (!following) return note("");
    if (leading) { leading = leadBox.checked = false; send({ type: "browse_lead", on: false }).catch(() => {}); }
    const p = peers.find(p => p.id === following);
    note(`Following ${p ? p.name : "them"}. Pages they open will show up here.`);
    if (p && p.browsing && p.browsing.url) navigate(p.browsing.url, { remote: true });
  };
  function stopFollowing(text) {
    following = "";
    followSel.value = "";
    note(text);
  }
  function fillFollow(list) {
    const sharing = list.filter(p => p.browsing && p.id !== (S && S.id));
    followSel.replaceChildren(
      el("option", { value: "", textContent: sharing.length ? "Follow nobody" : "Nobody is sharing their browsing" }),
      ...sharing.map(p => {
        let host = "";
        try { host = p.browsing.url ? " (" + new URL(p.browsing.url).hostname + ")" : ""; } catch {}
        return el("option", { value: p.id, textContent: "Follow " + p.name + host });
      }));
    followSel.disabled = !sharing.length;
    if (following && !sharing.some(p => p.id === following)) {
      const p = list.find(p => p.id === following);
      stopFollowing(p ? `${p.name} stopped sharing their browsing.` : "The person you followed left.");
    }
    followSel.value = following;
  }

  // ---------- hooks into the main page ----------
  const origHandle = handle;
  handle = function (m) {
    if (m.type === "welcome") {
      key = m.browseKey || "";
      if (leading) send({ type: "browse_lead", on: true, ...current }).catch(() => {});
    }
    if (m.type === "browse_nav") {
      if (m.from === following) navigate(m.url, { remote: true });
      return;
    }
    return origHandle(m);
  };

  const origSetPeers = setPeers;
  setPeers = function (list, max) {
    const r = origSetPeers(list, max);
    fillFollow(list);
    return r;
  };

  const origAddChat = addChat;
  addChat = function (m) {
    const r = origAddChat(m);
    if (m.link && isWeb(m.link)) {
      const node = document.querySelector("#messages")?.lastElementChild;
      node?.append(el("br"), el("button", {
        type: "button", className: "small blink", textContent: "Open in Browse",
        title: m.link, onclick: () => open(m.link),
      }));
    }
    return r;
  };

  function open(url) {
    document.querySelector('.tabs button[data-tab="browse"]')?.click();
    navigate(url);
  }

  window.crewBrowse = { open };
  fillFollow([]);
  updateButtons();
})();
