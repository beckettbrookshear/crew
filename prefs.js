/* CREW personal preferences.
 *
 * Load in <head> (not deferred) so the theme applies before the page paints:
 *   <link rel="stylesheet" href="prefs.css">
 *   <script src="prefs.js"></script>
 *
 * Preferences are personal: they're saved in this browser only and never
 * sent to the server. Open the window with the gear button or Ctrl+,
 */
(() => {
  "use strict";
  const KEY = "crew.prefs";
  const root = document.documentElement;
  const darkMQ = matchMedia("(prefers-color-scheme: dark)");

  const DEFAULTS = {
    theme: "linux-light",
    accent: "",
    font: "theme",
    fontSize: 15,
    density: "normal",
    corners: "rounded",
    windowStyle: "linux",
    statusBar: true,
    sidebar: "left",
    wide: false,
    startTab: "chat",
    chatStyle: "bubbles",
    timestamps: true,
    clock24: false,
    seconds: false,
    joinLeave: true,
    sound: false,
    notify: false,
    confirmLeave: true,
    animations: true,
  };

  const THEMES = {
    "system": "Follow system (light or dark)",
    "linux-light": "Linux Light",
    "linux-dark": "Linux Dark",
    "terminal-green": "Terminal Green",
    "terminal-amber": "Terminal Amber",
    "solarized-light": "Solarized Light",
    "solarized-dark": "Solarized Dark",
    "contrast": "High Contrast",
  };
  const FONTS = {
    theme: ["Theme default", null],
    linux: ["Linux desktop (Cantarell, Ubuntu, Noto)", 'Cantarell, Ubuntu, "Noto Sans", "DejaVu Sans", "Liberation Sans", system-ui, sans-serif'],
    system: ["This computer's system font", 'system-ui, -apple-system, "Segoe UI", sans-serif'],
    mono: ["Monospace everywhere", 'var(--mono)'],
    serif: ["Serif", '"DejaVu Serif", "Noto Serif", "Liberation Serif", Georgia, serif'],
  };
  const ACCENTS = { blue: "#3584e4", teal: "#2190a4", green: "#3a944a", yellow: "#c88800",
    orange: "#ed5b00", red: "#e62d42", pink: "#d56199", purple: "#9141ac", slate: "#6f8396" };

  // ---------- storage (fails safely in private windows) ----------
  function load() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
    catch { return { ...DEFAULTS }; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(P)); } catch {}
  }
  let P = load();
  let bar = null;            // the status bar element, once the page body exists

  // ---------- applying ----------
  function textOn(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#ffffff";
    const n = parseInt(m[1], 16), lin = c => (c /= 255) <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    const L = .2126 * lin(n >> 16) + .7152 * lin(n >> 8 & 255) + .0722 * lin(n & 255);
    return L > .4 ? "#111111" : "#ffffff";
  }
  function apply() {
    root.dataset.theme = P.theme === "system" ? (darkMQ.matches ? "linux-dark" : "linux-light") : P.theme;
    if (P.accent) {
      root.style.setProperty("--accent", P.accent);
      root.style.setProperty("--accent-text", textOn(P.accent));
    } else {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-text");
    }
    const font = (FONTS[P.font] || FONTS.theme)[1];
    font ? root.style.setProperty("--font", font) : root.style.removeProperty("--font");
    root.style.setProperty("--fs", (+P.fontSize || 15) + "px");

    const cls = {
      "style-linux": P.windowStyle === "linux",
      "statusbar": P.statusBar,
      "density-compact": P.density === "compact",
      "density-roomy": P.density === "roomy",
      "square": P.corners === "square",
      "sidebar-right": P.sidebar === "right",
      "sidebar-hidden": P.sidebar === "hidden",
      "wide": P.wide,
      "chat-lines": P.chatStyle === "lines",
      "no-ts": !P.timestamps,
      "no-joinleave": !P.joinLeave,
      "no-anim": !P.animations,
    };
    for (const [c, on] of Object.entries(cls)) root.classList.toggle(c, !!on);
    document.querySelectorAll("#messages time[datetime]").forEach(t => {
      t.textContent = formatTime(Date.parse(t.dateTime));
    });
    updateStatus();
  }
  darkMQ.addEventListener?.("change", () => P.theme === "system" && apply());

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit",
      ...(P.seconds ? { second: "2-digit" } : {}),
      hour12: !P.clock24,
    });
  }

  function set(k, v) { P[k] = v; save(); apply(); }

  // Public hooks the main page uses.
  window.crewPrefs = { get: k => P[k], formatTime, open: () => openPrefs(), notify: (t, b) => notify(t, b, true) };

  apply();   // runs in <head>, before first paint

  // ---------- everything that needs the page body ----------
  document.addEventListener("DOMContentLoaded", () => {
    buildStatusbar();
    addPrefsButtons();
    watchApp();
    watchChat();
    guardLeave();
    shortcuts();
    apply();
  });

  // ---------- status bar ----------
  function buildStatusbar() {
    bar = document.createElement("div");
    bar.id = "crewStatusbar";
    bar.setAttribute("role", "status");
    document.body.append(bar);
    const mo = new MutationObserver(updateStatus);
    for (const id of ["statusPill", "roomPill", "countPill", "lockPill"]) {
      const e = document.getElementById(id);
      if (e) mo.observe(e, { childList: true, characterData: true, subtree: true, attributes: true });
    }
    setInterval(updateStatus, 30000);
  }
  function txt(id) { return (document.getElementById(id)?.textContent || "").trim(); }
  function updateStatus() {
    if (!bar) return;
    const sess = typeof S !== "undefined" && S ? S : null;   // S = session from the main page
    const parts = [];
    const st = txt("statusPill");
    parts.push(`<span>${st === "Connected" ? "●" : "○"} ${esc(st || "Offline")}</span>`);
    if (sess) parts.push(`<span><b>${esc(sess.name)}</b>@${esc(sess.room)}</span>`);
    parts.push(`<span class="grow">${esc(txt("countPill"))}${txt("lockPill") ? " · " + esc(txt("lockPill").replace(/^\S+\s/, "")) : ""}</span>`);
    parts.push(`<span>${esc(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: !P.clock24 }))}</span>`);
    parts.push(`<span>Ctrl+, preferences</span>`);
    bar.innerHTML = parts.join("");
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------- open/close watchers ----------
  function watchApp() {
    const app = document.getElementById("app");
    if (!app) return;
    let wasHidden = true;
    const check = () => {
      const hidden = app.classList.contains("hidden");
      root.classList.toggle("in-app", !hidden);
      if (wasHidden && !hidden && P.startTab !== "chat") {
        document.querySelector(`.tabs button[data-tab="${P.startTab}"]`)?.click();
      }
      wasHidden = hidden;
      updateStatus();
    };
    new MutationObserver(check).observe(app, { attributes: true, attributeFilter: ["class"] });
    check();
  }

  function watchChat() {
    const box = document.getElementById("messages");
    if (!box) return;
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement) || !n.classList.contains("msg")) continue;
        const t = n.querySelector("time[datetime]");
        if (t) t.textContent = formatTime(Date.parse(t.dateTime));
        if (n.classList.contains("sys")) {
          if (/ (joined|left)\.$/.test(n.textContent)) n.classList.add("crew-jl");
          continue;
        }
        if (n.classList.contains("me")) continue;
        const who = n.querySelector(".nm")?.textContent || n.querySelector(".who")?.textContent || "New message";
        const body = n.lastChild?.nodeType === 3 ? n.lastChild.textContent : "";
        if (P.sound) beep();
        if (P.notify) notify(who, body);
      }
    }).observe(box, { childList: true });
  }

  let audio;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, audio.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
      o.connect(g).connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.26);
    } catch {}
  }

  function notify(title, body, always) {
    if (!(P.notify || always) || !("Notification" in window)) return;
    if (!always && !document.hidden) return;          // only when you're looking elsewhere
    if (Notification.permission === "granted") {
      try { new Notification("CREW: " + title, { body: String(body || "").slice(0, 200), tag: "crew" }); } catch {}
    }
  }

  function guardLeave() {
    document.getElementById("leaveBtn")?.addEventListener("click", e => {
      if (P.confirmLeave && !confirm("Leave this group?")) {
        e.stopImmediatePropagation(); e.preventDefault();
      }
    }, true);
  }

  function shortcuts() {
    document.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); openPrefs(); return; }
      if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const tabs = document.querySelectorAll("#app:not(.hidden) .tabs button");
        const b = tabs[+e.key - 1];
        if (b) { e.preventDefault(); b.click(); }
      }
      if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "m" && !document.getElementById("app")?.classList.contains("hidden")) {
        e.preventDefault();
        document.querySelector('.tabs button[data-tab="chat"]')?.click();
        document.getElementById("chatText")?.focus();
      }
    });
  }

  function addPrefsButtons() {
    const mk = () => Object.assign(document.createElement("button"), {
      type: "button", textContent: "⚙", title: "Preferences (Ctrl+,)", onclick: openPrefs,
    });
    const header = document.querySelector("#app header");
    if (header) {
      const b = mk(); b.id = "crewPrefsBtn"; b.className = "small";
      b.setAttribute("aria-label", "Preferences");
      header.insertBefore(b, document.getElementById("inviteBtn") || null);
    }
    const form = document.getElementById("joinForm");
    if (form) {
      const b = mk(); b.textContent = "⚙ Preferences"; b.className = "small";
      b.style.cssText = "width:auto;margin-top:6px;padding:4px 10px";
      form.append(b);
    }
  }

  // ---------- the preferences window ----------
  let dlg, page = "look";
  function h(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  function row(label, desc, control) {
    return h("div", { className: "prow" },
      h("div", { className: "lab" }, label, desc ? h("small", { textContent: desc }) : null), control);
  }
  function select(key, opts) {
    const s = h("select", { onchange: () => set(key, s.value) });
    for (const [v, l] of Object.entries(opts)) s.append(h("option", { value: v, textContent: l }));
    s.value = P[key];
    return s;
  }
  function toggle(key, onEnable) {
    const i = h("input", { type: "checkbox", checked: !!P[key] });
    i.onchange = async () => {
      if (i.checked && onEnable && !(await onEnable())) { i.checked = false; return; }
      set(key, i.checked);
    };
    return h("label", { className: "crew-switch" }, i, h("span"));
  }
  function range(key, min, max, unit) {
    const out = h("span", { textContent: P[key] + unit, style: "min-width:44px;text-align:right" });
    const r = h("input", { type: "range", min, max, value: P[key] });
    r.oninput = () => { out.textContent = r.value + unit; set(key, +r.value); };
    return h("div", { className: "row", style: "gap:8px;flex-wrap:nowrap" }, r, out);
  }
  function accentPicker() {
    const wrap = h("div", { className: "crew-swatches" });
    const draw = () => {
      wrap.replaceChildren(
        h("button", { type: "button", className: "crew-swatch auto" + (P.accent ? "" : " on"), title: "Theme default", onclick: () => { set("accent", ""); draw(); } }),
        ...Object.entries(ACCENTS).map(([n, c]) => h("button", {
          type: "button", className: "crew-swatch" + (P.accent === c ? " on" : ""), title: n,
          style: `background:${c}`, onclick: () => { set("accent", c); draw(); } })),
        (() => { const i = h("input", { type: "color", title: "Pick any color", value: P.accent || "#3584e4" });
                 i.oninput = () => set("accent", i.value); i.onchange = draw; return i; })(),
      );
    };
    draw();
    return wrap;
  }
  const list = (...rows) => h("div", { className: "list" }, ...rows);

  const PAGES = {
    look: ["Appearance", () => [
      h("h3", { textContent: "Style" }),
      list(
        row("Theme", null, select("theme", THEMES)),
        row("Accent color", "Buttons, links and highlights", accentPicker()),
        row("Window style", "Linux desktop look, or a plain web page", select("windowStyle", { linux: "Linux desktop (GTK-like)", web: "Plain web page" })),
        row("Corners", null, select("corners", { rounded: "Rounded", square: "Square" })),
        row("Animations", null, toggle("animations")),
      ),
      h("h3", { textContent: "Text" }),
      list(
        row("Font", null, select("font", Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v[0]])))),
        row("Text size", null, range("fontSize", 12, 22, "px")),
      ),
    ]],
    layout: ["Layout", () => [
      h("h3", { textContent: "Window" }),
      list(
        row("Spacing", null, select("density", { compact: "Compact", normal: "Normal", roomy: "Roomy" })),
        row("Computers list", null, select("sidebar", { left: "On the left", right: "On the right", hidden: "Hidden" })),
        row("Use full window width", "Stretch past 1200px on big screens", toggle("wide")),
        row("Status bar", "Connection, group and time along the bottom", toggle("statusBar")),
        row("Open on tab", "Which tab shows after you join", select("startTab", { chat: "Chat", files: "Files", notes: "Shared notes", compute: "Work together" })),
      ),
    ]],
    chat: ["Chat", () => [
      h("h3", { textContent: "Messages" }),
      list(
        row("Message style", "Bubbles, or one line per message like IRC", select("chatStyle", { bubbles: "Bubbles", lines: "Lines  [12:01] <name> text" })),
        row("Show times", null, toggle("timestamps")),
        row("24-hour clock", null, toggle("clock24")),
        row("Show seconds", null, toggle("seconds")),
        row("Show joined / left messages", null, toggle("joinLeave")),
      ),
      h("h3", { textContent: "Alerts" }),
      list(
        row("Sound on new message", null, toggle("sound", async () => { beep(); return true; })),
        row("Desktop notifications", "When a message arrives while CREW is in the background", toggle("notify", askNotify)),
      ),
    ]],
    general: ["General", () => [
      h("h3", { textContent: "Behavior" }),
      list(row("Ask before leaving a group", null, toggle("confirmLeave"))),
      h("h3", { textContent: "Keyboard shortcuts" }),
      list(
        row(h("span", {}, h("kbd", { textContent: "Ctrl" }), " + ", h("kbd", { textContent: "," })), null, h("span", { textContent: "Preferences" })),
        row(h("span", {}, h("kbd", { textContent: "Alt" }), " + ", h("kbd", { textContent: "1" }), " … ", h("kbd", { textContent: "9" })), null, h("span", { textContent: "Switch tab" })),
        row(h("span", {}, h("kbd", { textContent: "Alt" }), " + ", h("kbd", { textContent: "M" })), null, h("span", { textContent: "Write a chat message" })),
        row(h("kbd", { textContent: "Esc" }), null, h("span", { textContent: "Close this window" })),
      ),
      h("h3", { textContent: "Your preferences" }),
      h("div", { className: "muted", style: "font-size:13px", textContent: "Saved in this browser only. Export them to copy your setup to another computer." }),
      h("div", { className: "pfoot" },
        h("button", { type: "button", textContent: "Export…", onclick: exportPrefs }),
        h("button", { type: "button", textContent: "Import…", onclick: importPrefs }),
        h("button", { type: "button", textContent: "Reset to defaults", onclick: () => {
          if (confirm("Reset all preferences to their defaults?")) { P = { ...DEFAULTS }; save(); apply(); render(); }
        } }),
      ),
    ]],
  };

  async function askNotify() {
    if (!("Notification" in window)) { alert("This browser doesn't support desktop notifications."); return false; }
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") { alert("Notifications are blocked for this site. Allow them in your browser's site settings first."); return false; }
    return (await Notification.requestPermission()) === "granted";
  }

  function exportPrefs() {
    const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(P, null, 2)], { type: "application/json" })), download: "crew-preferences.json" });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importPrefs() {
    const i = h("input", { type: "file", accept: ".json,application/json" });
    i.onchange = async () => {
      try {
        const data = JSON.parse(await i.files[0].text());
        const clean = {};
        for (const k of Object.keys(DEFAULTS)) if (k in data && typeof data[k] === typeof DEFAULTS[k]) clean[k] = data[k];
        P = { ...DEFAULTS, ...clean }; save(); apply(); render();
      } catch { alert("That file isn't a CREW preferences file."); }
    };
    i.click();
  }

  function render() {
    if (!dlg) return;
    const nav = dlg.querySelector(".pnav"), body = dlg.querySelector(".pbody");
    nav.replaceChildren(...Object.entries(PAGES).map(([k, [label]]) =>
      h("button", { type: "button", className: k === page ? "on" : "", textContent: label, onclick: () => { page = k; render(); } })));
    body.replaceChildren(...PAGES[page][1]());
  }

  function openPrefs() {
    if (!dlg) {
      dlg = h("dialog", { id: "crewPrefs" },
        h("div", { className: "ph" },
          h("span", { style: "width:60px" }),
          h("h2", { textContent: "Preferences" }),
          h("button", { type: "button", className: "small", textContent: "Close", style: "width:60px", onclick: () => dlg.close() })),
        h("nav", { className: "pnav" }),
        h("div", { className: "pbody" }));
      dlg.setAttribute("aria-label", "Preferences");
      dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });   // click outside closes
      document.body.append(dlg);
    }
    render();
    if (!dlg.open) dlg.showModal();
  }
})();
