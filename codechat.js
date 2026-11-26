/* CREW: the Code tab's "Ask Claude" chat panel.
 *
 * Loaded after code.js, so it can use the main page's helpers ($, el, send,
 * store, handle) and window.crewCode (the shared editor). It wraps handle()
 * to receive "codechat" and "codechat_state" messages (see claude_bridge.py).
 *
 * Claude runs on the CREW host with no tools at all: it only sees the code
 * and questions sent from here. Like the Claude Code tab, everyone gets it
 * if the host started CREW with --claude, using the Claude account they
 * signed in with on the Claude Code tab.
 *
 * Where it goes: into <div id="codeAside"> if the Code tab has one; if not,
 * beside the editor (below it on narrow screens). Its show/hide button goes
 * into <span id="codeAsideBtn"> if there is one, else the Code toolbar.
 */
(() => {
  "use strict";
  const pane = document.getElementById("tab-code");
  if (!pane) return;

  let st = { available: false };    // last codechat_state from the server
  let unseen = false;               // an answer came while the panel was closed

  const LANG_ALIAS = { js: "javascript", javascript: "javascript", jsx: "javascript", mjs: "javascript",
    html: "html", htm: "html", css: "css", py: "python", python: "python", java: "java", c: "c",
    cpp: "cpp", "c++": "cpp", cc: "cpp", cs: "csharp", csharp: "csharp", "c#": "csharp", go: "go", golang: "go",
    rs: "rust", rust: "rust", rb: "ruby", ruby: "ruby", php: "php", sql: "sql", sh: "bash", bash: "bash",
    shell: "bash", zsh: "bash", txt: "text", text: "text", plaintext: "text" };

  // ---------- layout ----------
  const style = document.createElement("style");
  style.textContent = `
    #tab-code .ccwrap.open { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
    .layout:has(#tab-code:not(.hidden) .ccwrap.open) { max-width: 1560px; }
    .ccpanel { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r, 8px); background: var(--panel);
               height: calc(100vh - 190px); min-height: 440px; max-height: 920px; position: sticky; top: 12px; }
    #codeAside .ccpanel { position: static; height: 100%; max-height: none; min-height: 300px; }
    @media (max-width: 1100px) {
      #tab-code .ccwrap.open { grid-template-columns: minmax(0, 1fr); }
      .ccpanel { position: static; height: 70vh; }
    }
    .ccpanel .cchead { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 6px 6px 6px 12px; border-bottom: 1px solid var(--line); }
    .ccpanel .cchead select { width: auto; padding: 3px 6px; font-size: 13px; }
    .ccpanel .ccstatus { margin-left: auto; font-size: 12px; color: var(--muted); }
    .ccpanel .ccstatus.busy { color: var(--accent); }
    .ccpanel .cclog { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; font-size: 14px; }
    .ccpanel .ccempty { margin: auto; text-align: center; color: var(--muted); font-size: 13px; max-width: 280px; line-height: 1.5; }
    .ccpanel .ccuser { align-self: flex-end; max-width: 90%; background: var(--mine); border-radius: 10px; padding: 6px 10px; white-space: pre-wrap; word-wrap: break-word; }
    .ccpanel .ccnote { align-self: flex-end; font-size: 11px; color: var(--muted); margin-top: -7px; }
    .ccpanel .cctext { white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; }
    .ccpanel .cctext code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--soft); padding: 1px 4px; border-radius: 4px; }
    .ccpanel .codeblock pre { max-height: 320px; font-size: 12.5px; }
    .ccpanel .cthink { font-size: 12px; color: var(--muted); }
    .ccpanel .cthink summary { cursor: pointer; }
    .ccpanel .ccdone { font-size: 11px; color: var(--muted); align-self: center; }
    .ccpanel .ccerr { color: var(--bad); white-space: pre-wrap; font-size: 13px; }
    .ccpanel .ccchips { display: flex; gap: 5px; flex-wrap: wrap; padding: 8px 10px 0; border-top: 1px solid var(--line); }
    .ccpanel .ccchips button { font-size: 12px; padding: 3px 9px; border-radius: 99px; }
    .ccpanel form { display: flex; gap: 6px; padding: 8px 10px 4px; align-items: flex-end; }
    .ccpanel form textarea { flex: 1; min-height: 40px; max-height: 160px; resize: vertical; font-size: 14px; }
    .ccpanel .ccfoot { display: flex; gap: 8px; align-items: center; padding: 0 10px 8px; font-size: 12px; color: var(--muted); }
    .ccpanel .ccfoot label { display: flex; gap: 5px; align-items: center; cursor: pointer; }
    .ccpanel .ccfoot input { width: auto; margin: 0; }
  `;
  document.head.append(style);

  const modelSel = el("select", { title: "Model" });
  const newBtn = el("button", { type: "button", className: "small", textContent: "New", title: "Start a new conversation" });
  const closeBtn = el("button", { type: "button", className: "small", textContent: "✕", title: "Hide this panel", ariaLabel: "Hide the Ask Claude panel" });
  const status = el("span", { className: "ccstatus", textContent: "Ready" });
  const log = el("div", { className: "cclog", ariaLive: "polite" });
  const input = el("textarea", { placeholder: "Ask about the code in the editor…", spellcheck: true,
    title: "Enter to send, Shift+Enter for a new line" });
  const sendBtn = el("button", { type: "submit", className: "primary", textContent: "Send" });
  const stopBtn = el("button", { type: "button", className: "hidden", textContent: "Stop" });
  const form = el("form", {}, input, sendBtn, stopBtn);
  const include = el("input", { type: "checkbox", checked: store.get("codeChatInclude") ?? true });
  const errLine = el("span", { className: "error" });
  const CHIPS = [
    ["Explain", "Explain what this code does, step by step, in plain words."],
    ["Why doesn't it work?", "This code doesn't do what I expect. Find the problem and show me the fixed code."],
    ["Add comments", "Add short, helpful comments to this code. Don't change what it does."],
    ["Improve it", "Suggest how to make this code clearer or better, and show the improved code."],
  ];
  const chips = el("div", { className: "ccchips" }, ...CHIPS.map(([label, q]) =>
    el("button", { type: "button", textContent: label, title: q, onclick: () => ask(q) })));

  const panel = el("div", { className: "ccpanel" },
    el("div", { className: "cchead" }, el("b", { textContent: "Ask Claude" }), modelSel, newBtn, status, closeBtn),
    log, chips, form,
    el("div", { className: "ccfoot" },
      el("label", { title: "Send the shared editor's code (and your selection) with each question" }, include, "Include the editor's code"),
      errLine));

  const toggle = el("button", { type: "button", textContent: "✦ Ask Claude", title: "Chat with Claude about this code (only you see it)" });

  // Mount: the IDE's slot if it has one, otherwise beside the editor.
  const slot = document.getElementById("codeAside");
  let wrap = null;
  if (slot) slot.append(panel);
  else {
    wrap = el("div", { className: "ccwrap" });
    const main = el("div", { style: "min-width:0" });
    main.append(...Array.from(pane.childNodes));
    wrap.append(main, panel);
    pane.append(wrap);
  }
  const btnSlot = document.getElementById("codeAsideBtn");
  if (btnSlot) btnSlot.append(toggle);
  else {
    const bar = pane.querySelector(".cbar");
    if (bar) bar.prepend(toggle); else pane.prepend(toggle);
  }

  function setOpen(open) {
    const show = !!st.available && open;
    panel.classList.toggle("hidden", !show);
    if (slot) slot.classList.toggle("hidden", !show);
    wrap?.classList.toggle("open", show);
    toggle.classList.toggle("hidden", !st.available);
    toggle.classList.toggle("on", show);
    toggle.setAttribute("aria-pressed", String(show));
    if (show) unseen = false;
    toggle.textContent = "✦ Ask Claude" + (unseen ? " •" : "");
  }
  const isOpen = () => store.get("codeChatOpen") ?? true;

  // ---------- helpers ----------
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  function add(node) {
    const stick = atBottom();
    log.querySelector(".ccempty")?.remove();
    log.append(node);
    if (stick) log.scrollTop = log.scrollHeight;
    return node;
  }

  function editor() {
    const c = window.crewCode?.get?.();
    if (c) return c;
    const ta = pane.querySelector("textarea"), sel = pane.querySelector("select");
    return ta ? { text: ta.value, lang: sel?.value || "text", selection: ta.value.slice(ta.selectionStart, ta.selectionEnd) }
              : { text: "", lang: "text", selection: "" };
  }

  function flash(btn, text, back) { btn.textContent = text; setTimeout(() => btn.textContent = back, 1500); }

  function codeBlock(code, tag) {
    const l = LANG_ALIAS[(tag || "").toLowerCase()];
    const useBtn = el("button", { type: "button", className: "small primary", textContent: "Put in editor",
      title: "Replace the shared code with this (everyone in the group will see it)",
      onclick: () => {
        if (!window.crewCode?.open) return flash(useBtn, "Not available", "Put in editor");
        window.crewCode.open(code, l || (tag ? "text" : undefined));
      } });
    const copyBtn = el("button", { type: "button", className: "small", textContent: "Copy", onclick: async () => {
      try { await navigator.clipboard.writeText(code); flash(copyBtn, "Copied!", "Copy"); }
      catch { flash(copyBtn, "Couldn't copy", "Copy"); }
    } });
    return el("div", { className: "codeblock" },
      el("div", { className: "cbhead" }, el("span", { textContent: tag || "code" }), useBtn, copyBtn),
      el("pre", { textContent: code }));
  }

  // Plain text with ```code blocks``` and `inline code`; never parsed as HTML.
  function richText(text) {
    const box = el("div", { className: "cctext" });
    const parts = String(text).split(/(`{3,})([\w+#.-]*)[^\n]*\n([\s\S]*?)\n?\1(?!`)/g);
    for (let i = 0; i < parts.length; i += 4) {
      let prose = parts[i];
      if (i > 0) prose = prose.replace(/^\n+/, "");                    // no blank gap around code blocks
      if (i + 3 < parts.length) prose = prose.replace(/\n+$/, "");
      prose.split(/(`[^`\n]+`)/g).forEach(bit => {
        if (bit.length > 2 && bit.startsWith("`") && bit.endsWith("`")) box.append(el("code", { textContent: bit.slice(1, -1) }));
        else if (bit) box.append(bit);
      });
      if (i + 3 < parts.length) box.append(codeBlock(parts[i + 3], parts[i + 2]));
    }
    return box;
  }

  // ---------- rendering events ----------
  function show(ev, live) {
    switch (ev.type) {
      case "prompt":
        add(el("div", { className: "ccuser", textContent: ev.text }));
        if (ev.note) add(el("div", { className: "ccnote", textContent: ev.note }));
        break;
      case "text": add(richText(ev.text)); break;
      case "thinking":
        add(el("details", { className: "cthink" }, el("summary", { textContent: "Thinking" }), el("div", { className: "cctext", textContent: ev.text })));
        break;
      case "result": {
        const bits = [ev.ok ? "Done" : "Finished with a problem"];
        if (ev.ms) bits.push((ev.ms / 1000).toFixed(1) + " s");
        if (typeof ev.cost === "number") bits.push("$" + ev.cost.toFixed(ev.cost < 0.1 ? 3 : 2));
        if (!ev.ok && ev.text) add(el("div", { className: "ccerr", textContent: ev.text }));
        add(el("div", { className: "ccdone", textContent: bits.join(" · ") }));
        if (live && panel.classList.contains("hidden")) { unseen = true; setOpen(false); }
        break;
      }
      case "error": add(el("div", { className: "ccerr", textContent: ev.text })); break;
    }
  }

  function updateStatus() {
    const running = !!st.running;
    status.className = "ccstatus" + (running ? " busy" : "");
    status.textContent = running ? "Thinking…" : "Ready";
    sendBtn.classList.toggle("hidden", running);
    stopBtn.classList.toggle("hidden", !running);
    chips.querySelectorAll("button").forEach(b => b.disabled = running);
    modelSel.disabled = running;
  }

  function render() {
    setOpen(isOpen());
    if (!st.available) { log.replaceChildren(); return; }
    const models = st.models || {};
    modelSel.replaceChildren(...Object.entries(models).map(([k, v]) => el("option", { value: k, textContent: v })));
    const want = store.get("codeChatModel") || st.model;
    modelSel.value = want in models ? want : Object.keys(models)[0] || "";
    log.replaceChildren(el("div", { className: "ccempty", textContent:
      "Ask Claude about the code in the editor: what it does, why it breaks, or how to change it. " +
      "Answers with code have a “Put in editor” button. Claude sees only what you send here, not your files. " +
      "Only you see this chat; it uses your own Claude account." }));
    if (!st.signedIn) log.append(el("div", { className: "ccempty", textContent:
      "First sign in with your own Claude account on the Claude Code tab (one time per visit)." },
      el("div", {}, el("button", { type: "button", className: "small", textContent: "Go to sign in",
        onclick: () => document.getElementById("claudeTab")?.click() }))));
    (st.events || []).forEach(ev => show(ev, false));
    log.scrollTop = log.scrollHeight;
    updateStatus();
  }

  // ---------- actions ----------
  async function ask(text) {
    text = String(text || "").trim();
    if (!text || st.running) return;
    errLine.textContent = "";
    const c = editor();
    if (include.checked && !c.text.trim() && !/[{};()<>=]/.test(text))
      errLine.textContent = "The editor is empty, so Claude only gets your question.";
    sendBtn.disabled = true;
    try {
      await send({ type: "codechat_prompt", text, model: modelSel.value, include: include.checked,
        code: include.checked ? c.text : "", lang: c.lang, selection: include.checked ? c.selection : "" });
      if (input.value.trim() === text) input.value = "";
    } catch (x) { errLine.textContent = x.message; }
    finally { sendBtn.disabled = false; }
  }

  form.addEventListener("submit", e => { e.preventDefault(); ask(input.value); });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  stopBtn.addEventListener("click", () => send({ type: "codechat_stop" }).catch(x => errLine.textContent = x.message));
  newBtn.addEventListener("click", () => {
    if (st.running && !confirm("Stop Claude and start a new conversation?")) return;
    send({ type: "codechat_new" }).catch(x => errLine.textContent = x.message);
  });
  modelSel.addEventListener("change", () => store.set("codeChatModel", modelSel.value));
  include.addEventListener("change", () => store.set("codeChatInclude", include.checked));
  toggle.addEventListener("click", () => {
    const open = panel.classList.contains("hidden");
    store.set("codeChatOpen", open);
    setOpen(open);
    if (open) {
      log.scrollTop = log.scrollHeight;
      panel.scrollIntoView({ block: "nearest", behavior: "smooth" });   // it's below the editor on narrow screens
      input.focus({ preventScroll: true });
    }
  });
  closeBtn.addEventListener("click", () => { store.set("codeChatOpen", false); setOpen(false); });

  // ---------- incoming messages ----------
  const origHandle = handle;
  handle = function (m) {
    if (m.type === "codechat_state") { st = m; render(); return; }
    if (m.type === "codechat") { show(m.event, true); return; }   // running/idle comes via codechat_state
    return origHandle(m);
  };

  setOpen(false);
})();
