/* CREW: the Claude Code tab (a chat panel like Claude Code in VS Code).
 *
 * Loaded after the main page script, so it can use its helpers
 * ($, el, send, S, store, tab, fmtTime). It fills <div id="tab-claude">
 * and wraps handle() to receive "claude" and "claude_state" messages.
 *
 * Claude Code itself runs on the CREW host (see claude_bridge.py); only
 * everyone in the group gets this tab if the host turned it on; each person
 * signs in with their own Claude account (kept only in the host's memory).
 */
(() => {
  "use strict";
  const pane = document.getElementById("tab-claude");
  const tabBtn = document.getElementById("claudeTab");
  if (!pane || !tabBtn) return;

  let st = { available: false };    // last claude_state from the server
  let dir = "";
  let cards = {};                   // tool_use id -> card element
  let asks = {};                    // approval id -> card element
  let waiting = 0;                  // approvals waiting for an answer

  // ---------- layout ----------
  const style = document.createElement("style");
  style.textContent = `
    #tab-claude .cbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 14px; }
    #tab-claude .cbar select { width: auto; max-width: 240px; padding: 5px 8px; }
    #tab-claude .cdir { font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    #tab-claude .cstatus { margin-left: auto; font-size: 13px; color: var(--muted); }
    #tab-claude .cstatus.busy { color: var(--accent); }
    #tab-claude .cstatus.ask { color: var(--warn); font-weight: 600; }
    #tab-claude .cwarn { font-size: 13px; color: var(--muted); background: var(--soft); border-radius: 8px; padding: 8px 10px; margin: 10px 0; }
    #tab-claude .clog { height: calc(100vh - 340px); min-height: 320px; overflow-y: auto; display: flex; flex-direction: column;
                        gap: 10px; padding: 10px 2px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); margin-top: 10px; }
    #tab-claude .cempty { color: var(--muted); margin: auto; text-align: center; max-width: 440px; font-size: 14px; }
    #tab-claude .cuser { align-self: flex-end; max-width: 85%; background: var(--mine); border-radius: 10px; padding: 7px 11px; white-space: pre-wrap; word-wrap: break-word; }
    #tab-claude .ctext { white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; }
    #tab-claude .ctext code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; background: var(--soft); padding: 1px 4px; border-radius: 4px; }
    #tab-claude pre { margin: 6px 0; padding: 8px 10px; background: var(--soft); border-radius: 8px; overflow: auto; max-height: 360px;
                      font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
    #tab-claude details.ctool, #tab-claude .cask { border: 1px solid var(--line); border-radius: 8px; font-size: 14px; }
    #tab-claude details.ctool > summary { cursor: pointer; padding: 6px 10px; list-style: none; display: flex; gap: 8px; align-items: baseline; }
    #tab-claude details.ctool > summary::-webkit-details-marker { display: none; }
    #tab-claude details.ctool > summary::before { content: "▸"; color: var(--muted); }
    #tab-claude details.ctool[open] > summary::before { content: "▾"; }
    #tab-claude .ctool .tname { font-weight: 600; }
    #tab-claude .ctool .targ { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; color: var(--muted);
                               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    #tab-claude .ctool .tmark { font-size: 12px; }
    #tab-claude .ctool .tbody { padding: 0 10px 8px; }
    #tab-claude .ctool.err > summary .tmark { color: var(--bad); }
    #tab-claude .ctool.ok > summary .tmark { color: var(--ok); }
    #tab-claude .diff .del { color: var(--bad); }
    #tab-claude .diff .add { color: var(--ok); }
    #tab-claude .cthink { font-size: 13px; color: var(--muted); }
    #tab-claude .cthink summary { cursor: pointer; }
    #tab-claude .cask { border-color: var(--warn); padding: 8px 10px; }
    #tab-claude .cask .row { margin-top: 8px; }
    #tab-claude .cdone { font-size: 12px; color: var(--muted); align-self: center; }
    #tab-claude .cerr { color: var(--bad); white-space: pre-wrap; font-size: 14px; }
    #tab-claude .ccomposer { display: flex; gap: 8px; margin-top: 10px; align-items: flex-end; }
    #tab-claude .ccomposer textarea { flex: 1; min-height: 44px; max-height: 220px; resize: vertical; }
    #tab-claude .ctodo { list-style: none; padding: 0; margin: 4px 0; }
    #tab-claude .ctodo li::before { content: "☐ "; }
    #tab-claude .ctodo li.done { color: var(--muted); text-decoration: line-through; }
    #tab-claude .ctodo li.done::before { content: "☑ "; }
    #tab-claude .ctodo li.now { font-weight: 600; }
  `;
  document.head.append(style);

  const modelSel = el("select", { title: "Model" });
  const modeSel = el("select", { title: "What Claude may do without asking" });
  const newBtn = el("button", { type: "button", className: "small", textContent: "New conversation" });
  const status = el("span", { className: "cstatus", textContent: "Ready" });
  const dirLine = el("div", { className: "cdir" });
  const log = el("div", { className: "clog" });
  const input = el("textarea", { placeholder: "Ask Claude to read, explain, or change code…  (Enter to send, Shift+Enter for a new line)", spellcheck: false });
  const sendBtn = el("button", { type: "submit", className: "primary", textContent: "Send" });
  const stopBtn = el("button", { type: "button", textContent: "Stop", className: "hidden" });
  const composer = el("form", { className: "ccomposer" }, input, sendBtn, stopBtn);
  const errLine = el("div", { className: "error", style: "margin-top:4px" });

  // ---------- sign in with your own Claude account ----------
  const acctLine = el("span", { className: "cdir" });
  const outBtn = el("button", { type: "button", className: "small", textContent: "Sign out" });
  const credIn = el("input", { type: "password", autocomplete: "off", spellcheck: false,
    placeholder: "sk-ant-oat… (login token) or sk-ant-api… (API key)", style: "font-family:ui-monospace,monospace" });
  const keep = el("input", { type: "checkbox", checked: true, style: "width:auto" });
  const inBtn = el("button", { type: "submit", className: "primary", textContent: "Sign in" });
  const inErr = el("div", { className: "error" });
  const signin = el("form", { className: "box hidden", style: "max-width:640px;margin:8px auto" },
    el("h3", { textContent: "Sign in to Claude Code with your own account" }),
    el("p", { className: "muted", style: "font-size:14px;margin:4px 0 10px", textContent:
      "Everyone uses their own Claude account here, so your usage is billed to you. Paste one of these:" }),
    el("ul", { style: "font-size:14px;margin:0 0 10px;padding-left:20px" },
      el("li", {}, el("b", { textContent: "A Claude login token" }), " (for Claude Pro or Max): on your own computer, run ",
        el("code", { textContent: "claude setup-token" }), " in a terminal, sign in, and copy the token it prints."),
      el("li", {}, el("b", { textContent: "An Anthropic API key" }), " (pay as you go): create one at console.anthropic.com under API Keys.")),
    credIn,
    el("label", { className: "switch", style: "margin:8px 0 0;font-size:13px" }, keep, " Remember it in this browser tab (forgotten when the tab closes)"),
    el("div", { className: "row", style: "margin-top:10px" }, inBtn),
    inErr,
    el("p", { className: "muted", style: "font-size:12.5px;margin:10px 0 0", textContent:
      "Your token or key is sent over the encrypted connection to the host computer and kept only in its memory, " +
      "only for your own runs, and forgotten when you sign out or leave. Claude works in your own folder on the host computer, " +
      "using the host's user account. The host could see your token if they changed CREW's code, so only sign in where you trust the host." }));
  const work = el("div", {},
    el("div", { className: "cbar" }, el("b", { textContent: "Claude Code" }), modelSel, modeSel, newBtn, status),
    el("div", { className: "cbar", style: "margin-top:4px" }, acctLine, outBtn),
    dirLine,
    el("div", { className: "cwarn", textContent:
      "Claude works in your own folder on the host computer. It asks before editing files or running commands " +
      "unless you pick a mode that allows edits. Only you see this conversation. Each message uses your own Claude account." }),
    log, composer, errLine);
  pane.append(signin, work);

  let autoTried = false;
  async function signIn(secret, remember) {
    inErr.textContent = ""; inBtn.disabled = true;
    try {
      await send({ type: "claude_login", secret });
      credIn.value = "";
      if (remember) store.set("claudeCred", secret, true); else store.del("claudeCred");
    } catch (x) { inErr.textContent = x.message; }
    finally { inBtn.disabled = false; }
  }
  signin.addEventListener("submit", e => { e.preventDefault(); if (credIn.value.trim()) signIn(credIn.value.trim(), keep.checked); });
  outBtn.addEventListener("click", () => {
    store.del("claudeCred");
    send({ type: "claude_logout" }).catch(x => errLine.textContent = x.message);
  });

  // ---------- helpers ----------
  const rel = p => (dir && typeof p === "string" && p.startsWith(dir + "/")) ? p.slice(dir.length + 1) : p;
  const short = (s, n = 120) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };
  const pre = (text, cls) => el("pre", { className: cls || "", textContent: text });
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  function add(node) {
    const stick = atBottom();
    log.querySelector(".cempty")?.remove();
    log.append(node);
    if (stick) log.scrollTop = log.scrollHeight;
    return node;
  }

  // Plain text with ```code blocks``` and `inline code`; never parsed as HTML.
  function richText(text) {
    const box = el("div", { className: "ctext" });
    const parts = String(text).split(/```[\w+-]*\n?([\s\S]*?)```/g);
    parts.forEach((part, i) => {
      if (i % 2) { box.append(pre(part.replace(/\n$/, ""))); return; }
      part.split(/(`[^`\n]+`)/g).forEach(bit => {
        if (bit.startsWith("`") && bit.endsWith("`") && bit.length > 2) box.append(el("code", { textContent: bit.slice(1, -1) }));
        else if (bit) box.append(bit);
      });
    });
    return box;
  }

  // One-line label for a tool call: [name, argument]
  function label(name, inp) {
    inp = inp || {};
    switch (name) {
      case "Read": return ["Read", rel(inp.file_path)];
      case "Write": return ["Write", rel(inp.file_path)];
      case "Edit": case "MultiEdit": return ["Edit", rel(inp.file_path)];
      case "NotebookEdit": return ["Edit notebook", rel(inp.notebook_path)];
      case "Bash": return ["Run", inp.command];
      case "Glob": return ["Find files", inp.pattern];
      case "Grep": return ["Search", inp.pattern + (inp.path ? "  in " + rel(inp.path) : "")];
      case "WebFetch": return ["Fetch", inp.url];
      case "WebSearch": return ["Web search", inp.query];
      case "TodoWrite": return ["Update plan", ""];
      case "Task": case "Agent": return ["Subtask", inp.description];
      default: return [name, ""];
    }
  }

  function diff(oldS, newS) {
    const box = el("pre", { className: "diff" });
    for (const l of String(oldS ?? "").split("\n")) box.append(el("div", { className: "del", textContent: "- " + l }));
    for (const l of String(newS ?? "").split("\n")) box.append(el("div", { className: "add", textContent: "+ " + l }));
    return box;
  }

  // What a tool call will do, shown inside its card.
  function details(name, inp) {
    inp = inp || {};
    const box = el("div");
    if (name === "Edit") box.append(diff(inp.old_string, inp.new_string));
    else if (name === "MultiEdit") (inp.edits || []).forEach(e => box.append(diff(e.old_string, e.new_string)));
    else if (name === "Write") box.append(pre(inp.content ?? ""));
    else if (name === "Bash") box.append(pre("$ " + (inp.command ?? "")), ...(inp.description ? [el("div", { className: "muted", style: "font-size:13px", textContent: inp.description })] : []));
    else if (name === "TodoWrite") box.append(el("ul", { className: "ctodo" }, ...(inp.todos || []).map(t =>
      el("li", { className: t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : "", textContent: t.content || t.activeForm || "" }))));
    else if (name === "Read") { if (inp.offset || inp.limit) box.append(el("div", { className: "muted", style: "font-size:13px", textContent: `lines ${inp.offset || 1}–${(inp.offset || 1) + (inp.limit || 0)}` })); }
    else box.append(pre(JSON.stringify(inp, null, 2)));
    return box;
  }

  // ---------- rendering events ----------
  function show(ev) {
    switch (ev.type) {
      case "prompt":
        add(el("div", { className: "cuser", textContent: ev.text }));
        break;
      case "text":
        add(richText(ev.text));
        break;
      case "thinking":
        add(el("details", { className: "cthink" }, el("summary", { textContent: "Thinking" }), el("div", { className: "ctext", textContent: ev.text })));
        break;
      case "tool": {
        const [n, arg] = label(ev.name, ev.input);
        const body = el("div", { className: "tbody" }, details(ev.name, ev.input));
        const card = el("details", { className: "ctool" },
          el("summary", {}, el("span", { className: "tname", textContent: n }), el("span", { className: "targ", textContent: short(arg, 200), title: arg || "" }),
            el("span", { className: "tmark", textContent: "…" })), body);
        if (ev.name === "TodoWrite") card.open = true;
        cards[ev.id] = card;
        add(card);
        break;
      }
      case "tool_result": {
        const card = cards[ev.id];
        if (!card) break;
        card.classList.add(ev.error ? "err" : "ok");
        card.querySelector(".tmark").textContent = ev.error ? "✗ failed" : "✓";
        if (ev.text && card.querySelector(".tname").textContent !== "Update plan")
          card.querySelector(".tbody").append(el("div", { className: "muted", style: "font-size:12px;margin-top:4px", textContent: ev.error ? "Error:" : "Result:" }), pre(ev.text));
        if (ev.error) card.open = true;
        break;
      }
      case "permission": {
        const [n, arg] = label(ev.tool, ev.input);
        const btns = el("div", { className: "row" },
          el("button", { type: "button", className: "small primary", textContent: "Allow", onclick: () => answer(ev.id, true, false) }),
          el("button", { type: "button", className: "small", textContent: `Always allow ${ev.tool} in this conversation`, onclick: () => answer(ev.id, true, true) }),
          el("button", { type: "button", className: "small", textContent: "Deny", onclick: () => answer(ev.id, false, false) }));
        const card = el("div", { className: "cask" },
          el("div", {}, el("b", { textContent: "Claude wants to: " }), `${n} `, el("code", { textContent: short(arg, 300) })),
          details(ev.tool, ev.input), btns);
        asks[ev.id] = card;
        waiting++;
        add(card);
        break;
      }
      case "permission_done": {
        const card = asks[ev.id];
        if (!card) break;
        waiting = Math.max(0, waiting - 1);
        card.querySelector(".row")?.replaceWith(el("div", { className: "muted", style: "font-size:13px;margin-top:6px",
          textContent: ev.allow ? "✓ Allowed" : "✗ Denied" + (ev.why ? " · " + ev.why : "") }));
        card.style.borderColor = "var(--line)";
        delete asks[ev.id];
        break;
      }
      case "result": {
        const bits = [ev.ok ? "Done" : "Finished with a problem"];
        if (ev.ms) bits.push((ev.ms / 1000).toFixed(1) + " s");
        if (typeof ev.cost === "number") bits.push("$" + ev.cost.toFixed(ev.cost < 0.1 ? 3 : 2));
        if (!ev.ok && ev.text) add(el("div", { className: "cerr", textContent: ev.text }));
        add(el("div", { className: "cdone", textContent: bits.join(" · ") }));
        break;
      }
      case "error":
        add(el("div", { className: "cerr", textContent: ev.text }));
        break;
    }
    updateStatus();
  }

  function updateStatus() {
    const running = !!st.running;
    status.className = "cstatus" + (waiting ? " ask" : running ? " busy" : "");
    status.textContent = waiting ? "Waiting for your approval" : running ? "Working…" : "Ready";
    sendBtn.classList.toggle("hidden", running);
    stopBtn.classList.toggle("hidden", !running);
    modelSel.disabled = modeSel.disabled = running;
    const c = document.getElementById("claudeCount");
    if (c) { c.textContent = waiting; c.classList.toggle("hidden", !waiting || tab === "claude"); }
  }

  function render() {
    tabBtn.classList.toggle("hidden", !st.available);
    if (!st.available) {
      if (tab === "claude") document.querySelector('.tabs button[data-tab="chat"]')?.click();
      log.replaceChildren(); return;
    }
    signin.classList.toggle("hidden", !!st.signedIn);
    work.classList.toggle("hidden", !st.signedIn);
    if (!st.signedIn) {
      const saved = store.get("claudeCred");     // reconnected: sign back in from this tab
      if (saved && !autoTried) { autoTried = true; signIn(saved, true); }
      return;
    }
    autoTried = false;
    acctLine.textContent = "Signed in with your " + (st.account || "Claude account");
    dir = st.dir || "";
    dirLine.textContent = "Your folder: " + dir;
    dirLine.title = dir;
    const fill = (sel, opts, val) => {
      sel.replaceChildren(...Object.entries(opts).map(([k, v]) => el("option", { value: k, textContent: v })));
      sel.value = val in opts ? val : Object.keys(opts)[0];
    };
    fill(modelSel, st.models || {}, store.get("claudeModel") || st.model);
    fill(modeSel, st.modes || {}, store.get("claudeMode") || st.mode);
    cards = {}; asks = {}; waiting = 0;
    log.replaceChildren(el("div", { className: "cempty", textContent:
      "Ask Claude to explain this project, fix a bug, or add a feature. You'll see every file it reads and every change it wants to make." }));
    (st.events || []).forEach(show);
    log.scrollTop = log.scrollHeight;
    updateStatus();
  }

  // ---------- actions ----------
  async function answer(id, allow, always) {
    try { await send({ type: "claude_answer", id, allow, always }); }
    catch (x) { errLine.textContent = x.message; }
  }

  composer.addEventListener("submit", async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || st.running) return;
    errLine.textContent = "";
    sendBtn.disabled = true;
    try {
      await send({ type: "claude_prompt", text, model: modelSel.value, mode: modeSel.value });
      input.value = "";
    } catch (x) { errLine.textContent = x.message; }
    finally { sendBtn.disabled = false; }
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); }
  });
  stopBtn.addEventListener("click", () => send({ type: "claude_stop" }).catch(x => errLine.textContent = x.message));
  newBtn.addEventListener("click", () => {
    if (st.running && !confirm("Stop Claude and start a new conversation?")) return;
    send({ type: "claude_new" }).catch(x => errLine.textContent = x.message);
  });
  modelSel.addEventListener("change", () => store.set("claudeModel", modelSel.value));
  modeSel.addEventListener("change", () => store.set("claudeMode", modeSel.value));
  tabBtn.addEventListener("click", () => { updateStatus(); setTimeout(() => input.focus(), 0); });

  // ---------- incoming messages ----------
  const origHandle = handle;
  handle = function (m) {
    if (m.type === "claude_state") { st = m; render(); return; }
    if (m.type === "claude") { show(m.event); return; }   // running/idle comes via claude_state
    if (m.type === "claude_ask") {
      window.crewPrefs?.notify?.("Claude Code needs your approval", m.tool);
      return;
    }
    return origHandle(m);
  };
})();
