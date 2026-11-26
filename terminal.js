/* CREW Terminal: a shell in your browser that runs code with no internet.
 *
 * Loaded after the main page script. Fills <div id="tab-terminal">.
 *
 *  - Your files live on a small virtual disk in this browser only (localStorage).
 *  - Python is the real CPython, run by Pyodide from the CREW host's own
 *    vendor/ folder (setup_python.py puts it there). JavaScript runs in a Web Worker.
 *  - Programs run in Web Workers inside the browser, never on the host computer.
 *    The page's Content-Security-Policy only allows connections back to this
 *    CREW server, so a program can't reach anything else on the network.
 *  - Python's input() waits through a small relay on the host (terminal_support.py),
 *    so what you type into a running Python program passes through the host.
 */
(() => {
  "use strict";
  const pane = document.getElementById("tab-terminal");
  if (!pane) return;

  const HOME = "/home/crew";
  const MAX_FS = 2_000_000;        // characters on the virtual disk
  const MAX_OUT = 1_000_000;       // characters one program may print
  const MAX_LINES = 3000;          // lines kept on screen
  const KEY = "crew.term.fs.v1";
  const PY_BASE = location.origin + "/vendor/pyodide/";

  class ShellError extends Error {}

  // =====================================================================
  //  The virtual disk
  // =====================================================================
  const HELLO_PY = `# Your first Python program. Run it with:  python hello.py
name = input("What's your name? ")
print("Hello, " + name + "!")

total = 0
for n in range(1, 6):
    total += n
    print("Adding", n, "-> total is", total)
`;
  const HELLO_JS = `// Your first JavaScript program. Run it with:  node hello.js
// (This runs in your browser, so there's no require() or fs. Use await input() to ask a question.)
const name = await input("What's your name? ");
console.log("Hello, " + name + "!");

let total = 0;
for (let n = 1; n <= 5; n++) {
  total += n;
  console.log("Adding", n, "-> total is", total);
}
`;
  const README = `Welcome to the CREW terminal.

This is a safe practice shell that lives in your browser:
  * Your files are saved in this browser only.
  * Programs can't use the internet or touch your computer's real files.

Try these:
  ls                  see your files
  cat hello.py        read a file
  python hello.py     run a Python program
  node hello.js       run a JavaScript program
  python              open an interactive Python prompt (exit() to leave)
  run                 run whatever is in the Code tab's editor
  editor save a.py    copy the Code tab's text into a file
  help                the full list of commands

Press Ctrl+C to stop a program, Tab to finish a name, Up for earlier commands.
`;

  const vfs = { files: new Map(), dirs: new Set() };
  function vfsReset() {
    vfs.files = new Map([[HOME + "/hello.py", HELLO_PY], [HOME + "/hello.js", HELLO_JS], [HOME + "/README.txt", README]]);
    vfs.dirs = new Set(["/", "/home", HOME, "/tmp"]);
  }
  function vfsLoad() {
    vfsReset();
    try {
      const j = JSON.parse(localStorage.getItem(KEY) || "null");
      if (j && j.files && j.dirs) { vfs.files = new Map(Object.entries(j.files)); vfs.dirs = new Set(["/", "/home", HOME, "/tmp", ...j.dirs]); }
    } catch {}
  }
  let saveTimer = null;
  function vfsSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify({ files: Object.fromEntries(vfs.files), dirs: [...vfs.dirs] })); } catch {}
    }, 300);
  }
  vfsLoad();

  let cwd = HOME;
  const env = { HOME, USER: "you", "?": "0" };
  const userName = () => ((typeof S !== "undefined" && S && S.name) || "you").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "you";

  function resolve(p, base = cwd) {
    if (p === "~" || p.startsWith("~/")) p = HOME + p.slice(1);
    const out = [];
    for (const s of (p.startsWith("/") ? p : base + "/" + p).split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") out.pop(); else out.push(s);
    }
    return "/" + out.join("/");
  }
  const parentOf = p => p.slice(0, p.lastIndexOf("/")) || "/";
  const baseOf = p => p.slice(p.lastIndexOf("/") + 1);
  const isDir = p => vfs.dirs.has(p);
  const isFile = p => vfs.files.has(p);
  const writable = p => p === HOME || p.startsWith(HOME + "/") || p === "/tmp" || p.startsWith("/tmp/");
  const under = (p, dir) => p.startsWith(dir === "/" ? "/" : dir + "/");
  const used = () => { let n = 0; for (const t of vfs.files.values()) n += t.length; return n; };
  function children(dir) {
    const pre = dir === "/" ? "/" : dir + "/", names = new Set();
    for (const p of vfs.files.keys()) if (p.startsWith(pre) && p.length > pre.length) names.add(p.slice(pre.length).split("/")[0]);
    for (const p of vfs.dirs) if (p.startsWith(pre) && p.length > pre.length) names.add(p.slice(pre.length).split("/")[0]);
    return [...names].sort();
  }
  function fsWrite(p, text, append) {
    if (!writable(p)) throw new ShellError(`${p}: Permission denied (you can change files in ~ and /tmp)`);
    if (isDir(p)) throw new ShellError(`${p}: Is a directory`);
    if (!isDir(parentOf(p))) throw new ShellError(`${parentOf(p)}: No such directory`);
    const old = vfs.files.get(p) ?? "", next = append ? old + text : text;
    if (used() - old.length + next.length > MAX_FS) throw new ShellError("Out of disk space (the limit is 2 MB)");
    vfs.files.set(p, next); vfsSave();
  }
  function fsRead(p, label = p) {
    if (isDir(p)) throw new ShellError(`${label}: Is a directory`);
    if (!isFile(p)) throw new ShellError(`${label}: No such file (ls shows your files)`);
    return vfs.files.get(p);
  }
  const rd = name => fsRead(resolve(name), name);
  function mkdirp(p) {
    if (isFile(p)) throw new ShellError(`${p}: A file with that name exists`);
    const parts = p.split("/").filter(Boolean);
    let at = "";
    for (const s of parts) {
      at += "/" + s;
      if (isDir(at)) continue;
      if (!writable(at)) throw new ShellError(`${at}: Permission denied`);
      if (isFile(at)) throw new ShellError(`${at}: A file with that name exists`);
      vfs.dirs.add(at);
    }
    vfsSave();
  }
  function remove(p) {
    if (["/", "/home", HOME, "/tmp"].includes(p)) throw new ShellError(`${p}: Can't remove this folder`);
    if (!writable(p)) throw new ShellError(`${p}: Permission denied`);
    for (const f of [...vfs.files.keys()]) if (f === p || under(f, p)) vfs.files.delete(f);
    for (const d of [...vfs.dirs]) if (d === p || under(d, p)) vfs.dirs.delete(d);
    vfsSave();
  }
  function copyTo(src, dst) {
    if (isFile(src)) return fsWrite(dst, vfs.files.get(src), false);
    mkdirp(dst);
    for (const name of children(src)) copyTo(src + "/" + name, dst + "/" + name);
  }
  function applySync(payload) {                   // what a Python run did to /home/crew and /tmp
    if (!payload || !payload.files) return;
    if (payload.skipped && payload.skipped.length)
      term.write("(Not kept, because a file can be at most 1 MB: " + payload.skipped.join(", ") + ")\n", "thint");
    let total = 0;
    for (const t of Object.values(payload.files)) total += t.length;
    for (const [p, t] of vfs.files) if (!writable(p)) total += t.length;
    if (total > MAX_FS) { term.write("(The files from that run were too big to keep: the disk limit is 2 MB.)\n", "thint"); return; }
    for (const f of [...vfs.files.keys()]) if (writable(f)) vfs.files.delete(f);
    for (const d of [...vfs.dirs]) if (writable(d) && d !== HOME && d !== "/tmp") vfs.dirs.delete(d);
    for (const d of payload.dirs || []) vfs.dirs.add(d);
    for (const [p, t] of Object.entries(payload.files)) vfs.files.set(p, t);
    vfsSave();
  }

  // =====================================================================
  //  The screen
  // =====================================================================
  const style = document.createElement("style");
  style.textContent = `
    .troot .tbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
    .troot .tbar .grow { flex: 1; }
    .troot .tstate { font-size: 13px; color: var(--muted); }
    .troot .tscreen { background: #0d1117; color: #d6dde6; border-radius: var(--r, 10px); padding: 10px 12px; height: calc(100vh - 300px); min-height: 320px; overflow-y: auto; overflow-x: hidden; cursor: text;
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border: 1px solid var(--line); }
    .troot .tscreen:focus-within { border-color: var(--accent); }
    .troot .tline { white-space: pre-wrap; word-break: break-word; min-height: 1.45em; }
    .troot .tcur { display: flex; align-items: baseline; }
    .troot .tpart { white-space: pre-wrap; word-break: break-word; flex: none; max-width: 100%; }
    .troot .tin { flex: 1; min-width: 4ch; border: 0; outline: 0; background: transparent; color: #fff; padding: 0; margin: 0; border-radius: 0; width: auto; font: inherit; caret-color: #7ee787; }
    .troot .tprompt { color: #7ee787; font-weight: 600; }
    .troot .tdir { color: #79c0ff; font-weight: 600; }
    .troot .terr { color: #ff7b72; }
    .troot .thint { color: #e3b341; }
    .troot .tdim { color: #8b949e; }
    .troot .techo { color: #fff; }
    .troot .tnote { font-size: 13px; color: var(--muted); margin-top: 8px; }
    /* the page's own input styles (rounded white boxes) must not reach the terminal's typing line */
    :root .troot input.tin, :root .troot input.tin:focus, :root .troot input.tin:focus-visible {
      background: transparent !important; border: 0 !important; border-radius: 0 !important; outline: none !important; box-shadow: none !important; padding: 0 !important; }
    /* inside the Code tab's bottom panel: take the editor's colours, drop the extra chrome */
    .troot.embedded { height: 100%; }
    .troot.embedded .tbar, .troot.embedded .tnote { display: none; }
    .troot.embedded .tscreen { height: 100%; min-height: 0; border: 0; border-radius: 0; background: var(--ide-bg); color: var(--ide-text); padding: 6px 12px; font-size: 13px; }
    .troot.embedded .tin { color: var(--ide-text); caret-color: var(--ide-caret, #aeafad); }
    .troot.embedded .techo { color: var(--ide-text); }
    .troot.embedded .tprompt { color: #23d18b; } .troot.embedded .tdir { color: #3b8eea; } .troot.embedded .terr { color: #f14c4c; }
    .troot.embedded .thint { color: #e5b850; } .troot.embedded .tdim { color: var(--ide-dim, #8b949e); }
    .ide.light .troot.embedded .tprompt { color: #16825d; } .ide.light .troot.embedded .tdir { color: #0451a5; } .ide.light .troot.embedded .terr { color: #cd3131; }
    .ide.light .troot.embedded .thint { color: #bf8803; } .ide.light .troot.embedded .tdim { color: #6e7681; }
  `;
  document.head.append(style);

  const stateEl = el("span", { className: "tstate", textContent: "" });
  const stopBtn = el("button", { type: "button", className: "small", textContent: "■ Stop", title: "Stop the running program (Ctrl+C)" });
  const clearBtn = el("button", { type: "button", className: "small", textContent: "Clear", title: "Clear the screen (Ctrl+L)" });
  const screen = el("div", { className: "tscreen" });
  const partial = el("span", { className: "tpart" });
  const input = el("input", { className: "tin", spellcheck: false, autocomplete: "off", autocapitalize: "off", ariaLabel: "Terminal input" });
  const cur = el("div", { className: "tcur" }, partial, input);
  screen.append(cur);
  screen.dataset.busy = "";
  const root = el("div", { className: "troot" },
    el("div", { className: "tbar" }, el("b", { textContent: "Terminal" }),
      el("span", { className: "tstate", textContent: "offline: programs can't use the internet" }),
      el("span", { className: "grow" }), stateEl, stopBtn, clearBtn),
    screen,
    el("div", { className: "tnote", textContent: "Your files here are saved in this browser only. Type help to see what you can do." }));
  pane.replaceChildren(root);

  const CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]/g;
  const nearBottom = () => screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
  const term = {
    lineCount: 0,
    write(text, cls = "") {
      text = String(text);
      if (/\x1b\[2J|\x1bc/.test(text)) { this.clear(); text = text.split(/\x1b\[2J|\x1bc/).pop(); }
      text = text.replace(/\r\n/g, "\n").replace(CSI, "");
      const stick = nearBottom();
      text.split("\n").forEach((seg, i) => {
        if (i > 0) this.endLine();
        seg.split("\r").forEach((s, j) => {
          if (j > 0) partial.replaceChildren();
          if (!s) return;
          const last = partial.lastChild;
          if (last && last.className === cls) last.textContent += s;
          else partial.append(el("span", { className: cls, textContent: s }));
        });
      });
      if (stick) screen.scrollTop = screen.scrollHeight;
    },
    endLine() {
      const line = el("div", { className: "tline" });
      line.append(...partial.childNodes);
      screen.insertBefore(line, cur);
      if (++this.lineCount > MAX_LINES) { screen.firstChild.remove(); this.lineCount--; }
    },
    clear() { while (screen.firstChild !== cur) screen.firstChild.remove(); partial.replaceChildren(); this.lineCount = 0; },
  };

  // =====================================================================
  //  Reading lines: the shell, programs and `cat` all take their turn
  // =====================================================================
  let sink = null;                  // while set, typed lines go here: (line | null for end-of-input) => void
  let busy = false;                 // a command is running
  let job = null;                   // the foreground program: { kill() }
  let lineAborted = false;
  const typeahead = [];
  const history = (() => { try { return JSON.parse(sessionStorage.getItem("crew.term.hist") || "[]"); } catch { return []; } })();
  let histPos = -1;

  const dirLabel = () => cwd === HOME ? "~" : cwd.startsWith(HOME + "/") ? "~" + cwd.slice(HOME.length) : cwd;
  const showPrompt = () => term.write(`${userName()}@crew:${dirLabel()}$ `, "tprompt");
  function setBusy(b) { busy = b; screen.dataset.busy = b ? "1" : ""; stopBtn.disabled = !b; }
  setBusy(false);

  function readLine(prompt) {       // for commands that ask a question
    return new Promise(res => {
      if (typeahead.length) return res(typeahead.shift());
      if (prompt) term.write(prompt);
      sink = line => { sink = null; res(line); };
    });
  }

  function submit() {
    const raw = input.value;
    input.value = "";
    term.write(raw + "\n", "techo");
    if (sink) return sink(raw);
    if (busy) { typeahead.push(raw); return; }
    if (!raw.trim()) return showPrompt();
    if (history[history.length - 1] !== raw) { history.push(raw); try { sessionStorage.setItem("crew.term.hist", JSON.stringify(history.slice(-200))); } catch {} }
    histPos = -1;
    setBusy(true);
    runLine(raw).catch(e => term.write("terminal error: " + (e && e.message || e) + "\n", "terr")).finally(() => {
      setBusy(false); typeahead.length = 0;
      if (partial.textContent) term.write("\n");           // a program left a line unfinished
      showPrompt();
    });
  }

  function interrupt() {
    if (busy || sink) {
      term.write("^C\n", "tdim");
      lineAborted = true;
      if (job) job.kill();
      if (sink) { const s = sink; sink = null; s(null); }
    } else {
      term.write(input.value + "^C\n", "techo"); input.value = ""; showPrompt();
    }
  }

  input.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c" && input.selectionStart === input.selectionEnd) { e.preventDefault(); interrupt(); }
    else if (e.ctrlKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      if (input.value) return;
      if (sink) { term.write("\n"); const s = sink; sink = null; s(null); }
      else if (!busy) term.write("Use the tabs above to leave. (exit() leaves Python.)\n", "tdim"), showPrompt();
    }
    else if (e.ctrlKey && e.key.toLowerCase() === "l") { e.preventDefault(); term.clear(); if (!busy && !sink) showPrompt(); }
    else if (e.ctrlKey && e.key.toLowerCase() === "u") { e.preventDefault(); input.value = ""; }
    else if (e.key === "ArrowUp" && !sink && !busy) {
      e.preventDefault();
      if (histPos < 0) histPos = history.length;
      if (histPos > 0) input.value = history[--histPos];
    }
    else if (e.key === "ArrowDown" && !sink && !busy) {
      e.preventDefault();
      if (histPos >= 0 && histPos < history.length - 1) input.value = history[++histPos];
      else { histPos = -1; input.value = ""; }
    }
    else if (e.key === "Tab" && !e.shiftKey && !sink && !busy) { e.preventDefault(); complete(); }
  });
  screen.addEventListener("mouseup", () => { if (!String(getSelection())) input.focus(); });
  stopBtn.addEventListener("click", () => { interrupt(); input.focus(); });
  clearBtn.addEventListener("click", () => { term.clear(); if (!busy && !sink) showPrompt(); input.focus(); });
  document.querySelector('.tabs button[data-tab="terminal"]')?.addEventListener("click", () => setTimeout(() => input.focus(), 0));

  // ---- Tab completion ----
  function complete() {
    const v = input.value, pos = input.selectionStart, head = v.slice(0, pos);
    const word = head.match(/[^\s|;&<>]*$/)[0], start = pos - word.length;
    const before = head.slice(0, start).replace(/\s+$/, "");
    const first = before === "" || /[|;&]$/.test(before);
    let options;
    if (first && !word.includes("/")) options = Object.keys(commands).filter(c => c.startsWith(word));
    else {
      const slash = word.lastIndexOf("/") + 1, dirPart = word.slice(0, slash), pre = word.slice(slash);
      const dir = resolve(dirPart || ".");
      options = children(dir).filter(n => n.startsWith(pre) && (pre.startsWith(".") || !n.startsWith(".")))
        .map(n => dirPart + n + (isDir(dir === "/" ? "/" + n : dir + "/" + n) ? "/" : ""));
    }
    if (!options.length) return;
    let common = options[0];
    for (const o of options) while (!o.startsWith(common)) common = common.slice(0, -1);
    if (common.length > word.length || options.length === 1) {
      const add = options.length === 1 && !common.endsWith("/") ? common + " " : common;
      input.value = v.slice(0, start) + add + v.slice(pos);
      input.setSelectionRange(start + add.length, start + add.length);
    } else {
      term.write(input.value + "\n", "techo");
      term.write(options.join("  ") + "\n", "tdim");
      showPrompt();
    }
  }

  // =====================================================================
  //  The shell: parsing
  // =====================================================================
  function expandVar(line, i) {
    const rest = line.slice(i + 1);
    let m;
    if ((m = rest.match(/^\?/))) return { text: env["?"], next: i + 2 };
    if ((m = rest.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}/))) return { text: env[m[1]] ?? "", next: i + m[0].length + 1 };
    if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) return { text: env[m[0]] ?? "", next: i + m[0].length + 1 };
    return { text: "$", next: i + 1 };
  }
  function tokenize(line) {
    env.PWD = cwd; env.USER = userName();
    const toks = [];
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === " " || c === "\t") { i++; continue; }
      if (c === "#") break;
      if (c === ";") { toks.push({ t: "op", v: ";" }); i++; continue; }
      if (c === "&" && line[i + 1] === "&") { toks.push({ t: "op", v: "&&" }); i += 2; continue; }
      if (c === "|") { toks.push({ t: "op", v: "|" }); i++; continue; }
      if (c === ">") { if (line[i + 1] === ">") { toks.push({ t: "op", v: ">>" }); i += 2; } else { toks.push({ t: "op", v: ">" }); i++; } continue; }
      if (c === "<") { toks.push({ t: "op", v: "<" }); i++; continue; }
      let v = "", glob = false;
      while (i < line.length) {
        const d = line[i];
        if (" \t;|<>".includes(d) || (d === "&" && line[i + 1] === "&")) break;
        if (d === "'") {
          const j = line.indexOf("'", i + 1);
          if (j < 0) throw new ShellError("unfinished quote ' (close it with another ')");
          v += line.slice(i + 1, j); i = j + 1;
        } else if (d === '"') {
          i++;
          while (i < line.length && line[i] !== '"') {
            if (line[i] === "\\" && '"\\$'.includes(line[i + 1] || "")) { v += line[i + 1]; i += 2; }
            else if (line[i] === "$") { const r = expandVar(line, i); v += r.text; i = r.next; }
            else v += line[i++];
          }
          if (i >= line.length) throw new ShellError('unfinished quote " (close it with another ")');
          i++;
        } else if (d === "\\") { v += line[i + 1] ?? ""; i += 2; }
        else if (d === "$") { const r = expandVar(line, i); v += r.text; i = r.next; }
        else {
          if (d === "*" || d === "?") glob = true;
          if (d === "~" && v === "" && (i + 1 === line.length || " \t/".includes(line[i + 1]))) v += HOME; else v += d;
          i++;
        }
      }
      toks.push({ t: "word", v, glob });
    }
    return toks;
  }
  function parse(toks) {
    const segs = [];
    let op = null, pl = [], cmd = { argv: [], in: null, out: null, append: false }, redir = null;
    const endCmd = () => {
      if (redir) throw new ShellError("a file name is missing after " + redir);
      if (!cmd.argv.length) throw new ShellError("a command is missing here");
      pl.push(cmd); cmd = { argv: [], in: null, out: null, append: false };
    };
    for (const t of toks) {
      if (t.t === "word") {
        if (redir === "<") cmd.in = t.v;
        else if (redir) { cmd.out = t.v; cmd.append = redir === ">>"; }
        else cmd.argv.push(t);
        redir = null;
      } else if (t.v === "<" || t.v === ">" || t.v === ">>") redir = t.v;
      else if (t.v === "|") endCmd();
      else { endCmd(); segs.push({ op, pipeline: pl }); pl = []; op = t.v; }
    }
    if (cmd.argv.length || redir || pl.length) endCmd();
    if (pl.length) segs.push({ op, pipeline: pl });
    return segs;
  }
  function expandArgs(words) {
    const out = [];
    for (const w of words) {
      if (!w.glob) { out.push(w.v); continue; }
      const slash = w.v.lastIndexOf("/") + 1, dirPart = w.v.slice(0, slash), pat = w.v.slice(slash);
      const rx = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      const hits = children(resolve(dirPart || ".")).filter(n => rx.test(n) && (pat.startsWith(".") || !n.startsWith("."))).map(n => dirPart + n);
      out.push(...(hits.length ? hits : [w.v]));
    }
    return out;
  }

  // =====================================================================
  //  The shell: running lines
  // =====================================================================
  // Split at ; and && (outside quotes) so $VARIABLES are read when each part runs.
  function splitLine(line) {
    const parts = [];
    let op = null, start = 0, q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; else if (c === "\\" && q === '"') i++; continue; }
      if (c === "'" || c === '"') q = c;
      else if (c === "\\") i++;
      else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) { parts.push({ op, text: line.slice(start, i) }); return parts; }
      else if (c === ";") { parts.push({ op, text: line.slice(start, i) }); op = ";"; start = i + 1; }
      else if (c === "&" && line[i + 1] === "&") { parts.push({ op, text: line.slice(start, i) }); op = "&&"; start = i + 2; i++; }
    }
    parts.push({ op, text: line.slice(start) });
    return parts;
  }

  async function runLine(line) {
    lineAborted = false;
    for (const part of splitLine(line)) {
      if (lineAborted) break;
      if (part.op === "&&" && env["?"] !== "0") continue;
      if (!part.text.trim()) continue;
      let seg;
      try { [seg] = parse(tokenize(part.text)); }
      catch (e) { term.write(`crew: ${e.message}\n`, "terr"); env["?"] = "2"; return; }
      if (seg) env["?"] = String(await runPipeline(seg.pipeline));
    }
  }

  async function runPipeline(pl) {
    let input = null, code = 0;
    for (let i = 0; i < pl.length; i++) {
      const c = pl[i], last = i === pl.length - 1;
      let stdin = input;
      try { if (c.in) stdin = rd(c.in); }
      catch (e) { term.write(`crew: ${e.message}\n`, "terr"); return 1; }
      const capture = !last || !!c.out;
      let buf = "";
      const argv = expandArgs(c.argv);
      const name = argv.shift();
      const ctx = {
        args: argv, stdin,
        out: (s, cls) => { if (capture) buf += s; else term.write(s, cls || ""); },
        err: s => term.write(s, "terr"),
        note: s => term.write(s, "thint"),
      };
      code = await exec(name, ctx);
      if (lineAborted) return 130;
      if (c.out) {
        try { fsWrite(resolve(c.out), buf, c.append); }
        catch (e) { term.write(`crew: ${e.message}\n`, "terr"); return 1; }
        input = null;
      } else input = capture ? buf : null;
    }
    return code;
  }

  const NO_NET = {
    curl: "download from the internet", wget: "download from the internet", ping: "use the network",
    ssh: "connect to other computers", scp: "connect to other computers", git: "talk to servers",
    npm: "install packages from the internet", npx: "install packages from the internet", yarn: "install packages from the internet",
    pip: "install packages from the internet", pip3: "install packages from the internet", apt: "install software", "apt-get": "install software",
    brew: "install software", docker: "run other programs", nc: "use the network", telnet: "use the network", ftp: "use the network",
    nslookup: "use the network", dig: "use the network", traceroute: "use the network",
  };
  async function exec(name, ctx) {
    const fn = commands[name];
    if (!fn) {
      if (NO_NET[name]) ctx.err(`${name}: this terminal has no internet, so commands that ${NO_NET[name]} can't work.\n`);
      else if (name === "sudo" || name === "su") ctx.err("There's nothing to be the boss of here: you can already change everything in ~ and /tmp.\n");
      else ctx.err(`${name}: command not found. Type help to see the commands.\n`);
      return 127;
    }
    try { return (await fn(ctx)) | 0; }
    catch (e) {
      if (e instanceof ShellError) { ctx.err(`${name}: ${e.message}\n`); return 1; }
      throw e;
    }
  }

  // =====================================================================
  //  Commands
  // =====================================================================
  const lines = t => { const a = t.split("\n"); if (a.length && a[a.length - 1] === "") a.pop(); return a; };
  const flags = (args, known) => {                       // -l -a -rf  and -n 5
    const f = {}, rest = [];
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { rest.push(...args.slice(i + 1)); break; }
      if (/^-[A-Za-z]+$/.test(a) && [...a.slice(1)].every(ch => known.includes(ch))) for (const ch of a.slice(1)) f[ch] = true;
      else if (/^-\d+$/.test(a) && known.includes("N")) f.N = +a.slice(1);
      else rest.push(a);
    }
    return { f, rest };
  };
  const need = (rest, n, usage) => { if (rest.length < n) throw new ShellError("missing something. Usage: " + usage); };
  const textOf = async (ctx, files) => {                 // files given, or the piped-in text
    if (files.length) return files.map(f => rd(f));
    if (ctx.stdin !== null) return [ctx.stdin];
    throw new ShellError("give it a file name, or pipe text into it");
  };

  const HELP = `Files and folders
  ls [-l] [-a] [folder]   list files        cd folder      go into a folder (cd alone = home)
  pwd                     where am I        mkdir [-p] f   make a folder
  touch file              make an empty file   cat file     show a file (cat > file: type text, Ctrl+D to finish)
  cp [-r] a b             copy              mv a b         move or rename
  rm [-r] name            delete            tree [folder]  show folders as a tree
  df                      how much disk is used

Text
  echo text               print text (try:  echo hi > notes.txt   or   echo more >> notes.txt)
  head / tail [-n 5] file   grep [-i -n -v -c] word [files]   wc [-l] file   sort [-r -n -u] file
  Use | to send one command's output to another:  cat notes.txt | grep todo | wc -l

Running code
  python file.py          run a Python program        python        an interactive Python prompt
  python -c "print(1+1)"  run one line                node file.js  run a JavaScript program
  run [file]              run a file, or the code in the Code tab's editor (by its language)
  editor save file        copy the Code tab's code into a file    editor load file   open a file in the Code tab
  python prog.py < in.txt   feed a file to a program's input;   echo 5 | python prog.py   feed text

Other
  clear   history   date   whoami   sleep N   export NAME=value   reset (restore the starter files)
  Ctrl+C stops a program, Ctrl+D ends input, Tab finishes names, Up/Down browse earlier commands.

No internet here: programs can't reach other computers, and pip, npm and curl can't work.
Python's own library (random, math, json, datetime...) is all there. Your files are saved in this browser only.
`;

  const langOf = name => ({ py: "python", js: "javascript", mjs: "javascript", html: "html", htm: "html", css: "css", java: "java", c: "c", cpp: "cpp", cs: "csharp",
    go: "go", rs: "rust", rb: "ruby", php: "php", sql: "sql", sh: "bash", txt: "text" })[(name.split(".").pop() || "").toLowerCase()];
  const EXT = { python: "py", javascript: "js", html: "html", css: "css", java: "java", c: "c", cpp: "cpp", csharp: "cs", go: "go", rust: "rs", ruby: "rb", php: "php", sql: "sql", bash: "sh", text: "txt" };

  const commands = {
    help: ctx => { ctx.out(HELP); return 0; },
    man: ctx => commands.help(ctx),
    clear: () => { term.clear(); return 0; },
    pwd: ctx => { ctx.out(cwd + "\n"); return 0; },
    whoami: ctx => { ctx.out(userName() + "\n"); return 0; },
    date: ctx => { ctx.out(new Date().toString() + "\n"); return 0; },
    history: ctx => { history.forEach((h, i) => ctx.out(String(i + 1).padStart(4) + "  " + h + "\n")); return 0; },
    true: () => 0,
    false: () => 1,
    exit: ctx => { ctx.note("This terminal stays open. (Use the tabs above to go elsewhere; exit() leaves Python.)\n"); return 0; },
    echo: ctx => {
      let a = ctx.args, nl = true, esc = false;
      while (a[0] === "-n" || a[0] === "-e") { if (a[0] === "-n") nl = false; else esc = true; a = a.slice(1); }
      let t = a.join(" ");
      if (esc) t = t.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      ctx.out(t + (nl ? "\n" : "")); return 0;
    },
    export: ctx => {
      for (const a of ctx.args) { const m = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) env[m[1]] = m[2]; }
      return 0;
    },
    sleep: ctx => new Promise(res => {
      const ms = Math.max(0, parseFloat(ctx.args[0]) || 0) * 1000;
      const t = setTimeout(() => { job = null; res(0); }, ms);
      job = { kill() { clearTimeout(t); job = null; res(130); } };
    }),
    cd: ctx => {
      const p = resolve(ctx.args[0] ?? "~");
      if (isFile(p)) throw new ShellError(`${ctx.args[0]}: That's a file, not a folder`);
      if (!isDir(p)) throw new ShellError(`${ctx.args[0]}: No such folder`);
      cwd = p; return 0;
    },
    ls: ctx => {
      const { f, rest } = flags(ctx.args, "la1");
      const targets = rest.length ? rest : ["."];
      let code = 0;
      targets.forEach((t, ti) => {
        const p = resolve(t);
        if (isFile(p)) { ctx.out((f.l ? `-  ${String(vfs.files.get(p).length).padStart(7)}  ` : "") + t + "\n"); return; }
        if (!isDir(p)) { ctx.err(`ls: ${t}: No such file or folder\n`); code = 1; return; }
        if (targets.length > 1) ctx.out((ti ? "\n" : "") + t + ":\n");
        const names = children(p).filter(n => f.a || !n.startsWith("."));
        const sep = f.l || f["1"] ? "\n" : "  ";
        names.forEach((n, i) => {
          const full = p === "/" ? "/" + n : p + "/" + n, dir = isDir(full);
          const pre = f.l ? (dir ? "d  " : "-  ") + String(dir ? 0 : vfs.files.get(full).length).padStart(7) + "  " : "";
          ctx.out(pre); ctx.out(n + (dir ? "/" : ""), dir ? "tdir" : ""); ctx.out(i < names.length - 1 ? sep : "\n");
        });
        if (!names.length) ctx.out("");
      });
      return code;
    },
    tree: ctx => {
      const root = resolve(ctx.args[0] ?? ".");
      if (!isDir(root)) throw new ShellError("No such folder");
      ctx.out(ctx.args[0] ?? ".", "tdir"); ctx.out("\n");
      let nd = 0, nf = 0;
      const walk = (dir, pre) => {
        const names = children(dir);
        names.forEach((n, i) => {
          const full = dir === "/" ? "/" + n : dir + "/" + n, end = i === names.length - 1, d = isDir(full);
          ctx.out(pre + (end ? "└── " : "├── ")); ctx.out(n, d ? "tdir" : ""); ctx.out("\n");
          if (d) { nd++; walk(full, pre + (end ? "    " : "│   ")); } else nf++;
        });
      };
      walk(root, "");
      ctx.out(`\n${nd} folder${nd === 1 ? "" : "s"}, ${nf} file${nf === 1 ? "" : "s"}\n`); return 0;
    },
    mkdir: ctx => { const { f, rest } = flags(ctx.args, "p"); need(rest, 1, "mkdir [-p] folder");
      for (const r of rest) { const p = resolve(r); if (isDir(p) && !f.p) throw new ShellError(`${r}: Already exists`); if (!f.p && !isDir(parentOf(p))) throw new ShellError(`${r}: The folder above it doesn't exist (use mkdir -p)`); mkdirp(p); }
      return 0; },
    touch: ctx => { need(ctx.args, 1, "touch file"); for (const a of ctx.args) { const p = resolve(a); if (!isFile(p)) fsWrite(p, "", false); } return 0; },
    rm: ctx => { const { f, rest } = flags(ctx.args, "rRf"); need(rest, 1, "rm [-r] name");
      let code = 0;
      for (const r of rest) {
        const p = resolve(r);
        if (!isFile(p) && !isDir(p)) { if (!f.f) { ctx.err(`rm: ${r}: No such file or folder\n`); code = 1; } continue; }
        if (isDir(p) && !(f.r || f.R)) { ctx.err(`rm: ${r}: It's a folder (use rm -r to delete it and what's inside)\n`); code = 1; continue; }
        remove(p);
      }
      return code; },
    cp: ctx => { const { f, rest } = flags(ctx.args, "rR"); need(rest, 2, "cp [-r] from to");
      const dst = resolve(rest[rest.length - 1]);
      for (const s of rest.slice(0, -1)) {
        const src = resolve(s);
        if (!isFile(src) && !isDir(src)) throw new ShellError(`${s}: No such file or folder`);
        if (isDir(src) && !(f.r || f.R)) throw new ShellError(`${s}: It's a folder (use cp -r)`);
        copyTo(src, isDir(dst) ? dst + "/" + baseOf(src) : dst);
      }
      return 0; },
    mv: ctx => { need(ctx.args, 2, "mv from to");
      const dst = resolve(ctx.args[ctx.args.length - 1]);
      for (const s of ctx.args.slice(0, -1)) {
        const src = resolve(s);
        if (!isFile(src) && !isDir(src)) throw new ShellError(`${s}: No such file or folder`);
        const to = isDir(dst) ? dst + "/" + baseOf(src) : dst;
        if (to === src) continue;
        if (under(to, src)) throw new ShellError("can't move a folder into itself");
        copyTo(src, to); remove(src);
      }
      return 0; },
    cat: async ctx => {
      if (ctx.args.length) { for (const a of ctx.args) ctx.out(rd(a)); return 0; }
      if (ctx.stdin !== null) { ctx.out(ctx.stdin); return 0; }
      for (;;) { const l = await readLine(); if (l === null) break; ctx.out(l + "\n"); }        // type text; Ctrl+D ends
      return 0;
    },
    head: async ctx => { const { f, rest } = flags(ctx.args, "nN"); let n = f.N ?? 10; if (rest[0] && ctx.args.includes("-n")) { n = +rest.shift() || 10; }
      for (const t of await textOf(ctx, rest)) ctx.out(lines(t).slice(0, n).join("\n") + "\n"); return 0; },
    tail: async ctx => { const { f, rest } = flags(ctx.args, "nN"); let n = f.N ?? 10; if (rest[0] && ctx.args.includes("-n")) { n = +rest.shift() || 10; }
      for (const t of await textOf(ctx, rest)) ctx.out(lines(t).slice(-n).join("\n") + "\n"); return 0; },
    wc: async ctx => { const { f, rest } = flags(ctx.args, "lwc"); const files = rest.length ? rest : [null];
      const all = !f.l && !f.w && !f.c;
      for (const fl of files) { const t = fl ? rd(fl) : (await textOf(ctx, []))[0];
        const parts = []; if (all || f.l) parts.push((t.match(/\n/g) || []).length); if (all || f.w) parts.push((t.match(/\S+/g) || []).length); if (all || f.c) parts.push(t.length);
        ctx.out(parts.map(x => String(x).padStart(6)).join("") + (fl ? " " + fl : "") + "\n"); }
      return 0; },
    sort: async ctx => { const { f, rest } = flags(ctx.args, "rnu");
      let l = []; for (const t of await textOf(ctx, rest)) l.push(...lines(t));
      l.sort(f.n ? (a, b) => parseFloat(a) - parseFloat(b) : (a, b) => a < b ? -1 : a > b ? 1 : 0);
      if (f.r) l.reverse(); if (f.u) l = l.filter((x, i) => i === 0 || x !== l[i - 1]);
      ctx.out(l.length ? l.join("\n") + "\n" : ""); return 0; },
    grep: async ctx => { const { f, rest } = flags(ctx.args, "inovc"); need(rest, 1, "grep [-i -n -v -c] word [files]");
      const pat = rest.shift();
      let rx; try { rx = new RegExp(pat, f.i ? "i" : ""); } catch { rx = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), f.i ? "i" : ""); }
      const files = rest.length ? rest : [null]; let any = false;
      for (const fl of files) {
        const t = fl ? rd(fl) : (await textOf(ctx, []))[0];
        let count = 0;
        lines(t).forEach((l, i) => { if (rx.test(l) !== !!f.v) { count++; any = true; if (!f.c) ctx.out((files.length > 1 ? fl + ":" : "") + (f.n ? (i + 1) + ":" : "") + l + "\n"); } });
        if (f.c) ctx.out((files.length > 1 ? fl + ":" : "") + count + "\n");
      }
      return any ? 0 : 1; },
    df: ctx => { ctx.out(`Disk: ${(used() / 1000).toFixed(1)} KB used of ${MAX_FS / 1000} KB (saved in this browser only)\n`); return 0; },
    reset: async ctx => {
      const a = await readLine("Delete ALL your files here and restore the starter files? (y/N) ");
      if (a && /^y/i.test(a.trim())) { vfsReset(); vfsSave(); cwd = HOME; ctx.out("Done.\n"); } else ctx.out("Nothing changed.\n");
      return 0;
    },
    editor: ctx => {
      const [sub, file] = ctx.args, api = window.crewCode;
      if (!api || !api.get) throw new ShellError("the Code tab's editor isn't ready yet");
      if (sub === "save") {
        const cur = api.get(), name = file || "code." + (EXT[cur.lang] || "txt");
        fsWrite(resolve(name), cur.text, false); ctx.out(`Saved the editor's code to ${name}\n`); return 0;
      }
      if (sub === "load") {
        need([file], 1, "editor load file");
        const text = rd(file); api.open(text, langOf(file) || "text");
        ctx.out(`Opened ${file} in the Code tab (if you said yes, everyone in the group sees it).\n`); return 0;
      }
      throw new ShellError("Usage: editor save [file]   or   editor load file");
    },
    run: async ctx => {
      const { rest } = flags(ctx.args, "");
      if (rest.length) {
        const lang = langOf(rest[0]);
        if (lang === "python") return commands.python({ ...ctx, args: rest });
        if (lang === "javascript") return commands.node({ ...ctx, args: rest });
        throw new ShellError(`can only run .py and .js files here (${rest[0]} isn't one)`);
      }
      const api = window.crewCode;
      if (!api || !api.get) throw new ShellError("the Code tab's editor isn't ready yet");
      const cur = api.get();
      if (!cur.text.trim()) throw new ShellError("the Code tab's editor is empty");
      if (cur.lang === "python") return runPython(ctx, { src: cur.text, filename: "<editor>", argv: ["<editor>"] });
      if (cur.lang === "javascript") return runNode(ctx, { src: cur.text, filename: "<editor>", args: [] });
      throw new ShellError(`the editor holds ${cur.lang}, but only Python and JavaScript run here. (Use the Code tab's Run for HTML.)`);
    },
    python: async ctx => {
      const a = ctx.args.slice();
      if (a[0] === "-V" || a[0] === "--version") { ctx.out("Python 3.14 (runs offline in your browser, via Pyodide)\n"); return 0; }
      if (a[0] === "-m") throw new ShellError("-m isn't supported here");
      if (a[0] === "-c") { if (a.length < 2) throw new ShellError("-c needs some code in quotes"); return runPython(ctx, { src: a[1], filename: "<string>", argv: ["-c", ...a.slice(2)] }); }
      if (a.length && a[0] !== "-") {
        const p = resolve(a[0]);
        if (!isFile(p)) throw new ShellError(`can't open file '${a[0]}': No such file (ls shows your files)`);
        return runPython(ctx, { src: vfs.files.get(p), filename: a[0], argv: a });
      }
      if (ctx.stdin !== null) return runPython({ ...ctx, stdin: null }, { src: ctx.stdin, filename: "<stdin>", argv: ["-"] });
      return runPythonRepl(ctx);
    },
    node: async ctx => {
      const a = ctx.args.slice();
      if (a[0] === "-v" || a[0] === "--version") { ctx.out("JavaScript, run by your browser (not Node.js)\n"); return 0; }
      if (a[0] === "-e") { if (a.length < 2) throw new ShellError("-e needs some code in quotes"); return runNode(ctx, { src: a[1], filename: "<string>", args: a.slice(2) }); }
      if (a.length) {
        const p = resolve(a[0]);
        if (!isFile(p)) throw new ShellError(`can't open file '${a[0]}': No such file (ls shows your files)`);
        return runNode(ctx, { src: vfs.files.get(p), filename: a[0], args: a.slice(1) });
      }
      if (ctx.stdin !== null) return runNode({ ...ctx, stdin: null }, { src: ctx.stdin, filename: "<stdin>", args: [] });
      throw new ShellError("there's no interactive JavaScript prompt here. Try: node file.js   or   node -e \"console.log(1 + 1)\"");
    },
  };
  commands.python3 = commands.py = commands.python;
  commands.js = commands.nodejs = commands.node;

  // =====================================================================
  //  Hints for the mistakes beginners make most
  // =====================================================================
  const PY_HINTS = [
    [/NameError: name '(.+?)' is not defined/, m => `Python doesn't know the name '${m[1]}'. Check the spelling (capital letters matter) and that you created it earlier in the program.`],
    [/IndentationError|unexpected indent|expected an indented block/, () => "Python cares about the spaces at the start of lines. Lines inside an if, for, while or def must be indented by the same amount (4 spaces is usual)."],
    [/SyntaxError/, () => "There's a typing mistake on that line or the one before it. Look for a missing colon ( : ), bracket, or quote mark."],
    [/TypeError: can only concatenate str/, () => "You can't join text and a number with +. Turn the number into text with str(...), or use an f-string like f\"Total: {total}\"."],
    [/TypeError/, () => "You used a value in a way that doesn't fit its type (for example adding text to a number). Check what each variable holds with print(type(x))."],
    [/ZeroDivisionError/, () => "Something was divided by zero."],
    [/IndexError/, () => "That position doesn't exist in the list. Counting starts at 0, so a list of 3 things has positions 0, 1 and 2."],
    [/KeyError/, () => "That key isn't in the dictionary. Check the spelling, or use d.get(key) which doesn't fail."],
    [/ValueError: invalid literal for int\(\)/, () => "int() was given something that isn't a whole number. Check what was typed in."],
    [/FileNotFoundError/, () => "That file doesn't exist here. Check the name and folder (ls shows your files)."],
    [/ModuleNotFoundError|ImportError/, () => "That module isn't available. This terminal has no internet, so only Python's built-in library works (no pip installs)."],
    [/EOFError/, () => "input() was called but there was nothing left to read."],
    [/AttributeError/, () => "That value doesn't have that attribute or method. Check the spelling; print(dir(x)) lists what it has."],
    [/RecursionError/, () => "A function keeps calling itself without stopping. Add a condition that ends it."],
  ];
  const JS_HINTS = [
    [/(\w+) is not defined/, () => "JavaScript doesn't know that name. Check the spelling (capital letters matter), or create it first with let or const."],
    [/is not a function/, () => "You tried to call something that isn't a function. Check the spelling, and that you aren't putting () after a plain value."],
    [/Cannot read propert(?:y|ies) of (undefined|null)/, () => "Something is empty (undefined or null) where an object was expected. Print it with console.log just before this line."],
    [/Unexpected (token|end of input|identifier|string)|missing \)|Invalid or unexpected token/, () => "That's a typing mistake in the code's structure. Look for a missing or extra ) ] } or quote mark, on this line or the one before."],
    [/Assignment to constant variable/, () => "A name made with const can't be changed. Use let if it needs to change."],
    [/already been declared/, () => "That name is used twice. Rename one, or remove the second let/const."],
    [/require is not defined|Cannot use import/, () => "This runs in the browser, not Node.js, so require() and import don't work. Everything must be in the one file."],
  ];
  const hintFrom = (table, text) => { for (const [rx, f] of table) { const m = text.match(rx); if (m) return f(m); } return ""; };

  // =====================================================================
  //  Running Python (Pyodide in a Web Worker)
  // =====================================================================
  const PY_PRELUDE = String.raw`
import sys, os, json, builtins, traceback, importlib
import code as _code
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

class _Quit:
    def __init__(self, name):
        self.name = name
    def __repr__(self):
        return "Use " + self.name + "() or Ctrl-D (i.e. EOF) to exit"
    def __call__(self, code=None):
        raise SystemExit(code)

builtins.exit = _Quit("exit")
builtins.quit = _Quit("quit")

def _crew_path():
    if sys.stdin is None or getattr(sys.stdin, "closed", False):
        sys.stdin = open(0, "r", closefd=False)
    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
    importlib.invalidate_caches()

def _crew_run(src, filename, argv_json):
    g = {"__name__": "__main__", "__file__": filename, "__builtins__": builtins}
    sys.argv = json.loads(argv_json)
    _crew_path()
    status = 0
    try:
        exec(compile(src, filename, "exec"), g)
    except SystemExit as e:
        c = e.code
        if c is None:
            status = 0
        elif isinstance(c, int):
            status = c
        else:
            sys.stdout.flush()
            print(c, file=sys.stderr)
            status = 1
    except BaseException:
        sys.stdout.flush()
        et, ev, tb = sys.exc_info()
        traceback.print_exception(et, ev, tb.tb_next if tb else None)
        status = 1
    finally:
        try:
            sys.stdout.flush()
        except Exception:
            pass
    return status

_repl = None
def _crew_repl_start():
    global _repl
    _crew_path()
    _repl = _code.InteractiveConsole({"__name__": "__console__", "__doc__": None})

def _crew_repl_push(line):
    try:
        return 1 if _repl.push(line) else 0
    except SystemExit:
        return -1
`;

  // This function's text becomes the worker's whole program, so it can't use
  // anything from outside itself.
  function pyWorkerMain() {
    let py = null, chan = "", origin = "";
    let segs = [], last = 0, timer = null;
    const dec = { o: new TextDecoder(), e: new TextDecoder() };
    const flush = () => {
      clearTimeout(timer); timer = null;
      if (segs.length) { postMessage({ k: "out", segs }); segs = []; }
      last = performance.now();
    };
    const emit = (s, text) => {
      if (!text) return;
      const prev = segs[segs.length - 1];
      if (prev && prev[0] === s) prev[1] += text; else segs.push([s, text]);
      if (performance.now() - last > 30) flush(); else if (!timer) timer = setTimeout(flush, 30);
    };
    const readLine = () => {                       // blocks until the person types a line
      for (;;) {
        const x = new XMLHttpRequest();
        x.open("GET", origin + "/api/stdin?chan=" + chan, false);
        try { x.send(); } catch (e) { return undefined; }
        if (x.status === 200) return x.responseText;
        if (x.status !== 408) return undefined;
      }
    };
    const ROOTS = ["/home/crew", "/tmp"];
    const wipe = d => {
      for (const n of py.FS.readdir(d)) {
        if (n === "." || n === "..") continue;
        const p = d + "/" + n;
        if (py.FS.isDir(py.FS.stat(p).mode)) { wipe(p); py.FS.rmdir(p); } else py.FS.unlink(p);
      }
    };
    const putFiles = m => {
      for (const r of ROOTS) { py.FS.mkdirTree(r); wipe(r); }
      for (const d of m.dirs.slice().sort((a, b) => a.length - b.length)) py.FS.mkdirTree(d);
      for (const [p, t] of Object.entries(m.files)) py.FS.writeFile(p, t);
    };
    const takeFiles = () => {
      const files = {}, dirs = [], skipped = [];
      const walk = d => {
        for (const n of py.FS.readdir(d)) {
          if (n === "." || n === "..") continue;
          const p = d + "/" + n, st = py.FS.stat(p);
          if (py.FS.isDir(st.mode)) { dirs.push(p); walk(p); }
          else if (st.size <= 1000000) files[p] = py.FS.readFile(p, { encoding: "utf8" });
          else skipped.push(p);
        }
      };
      for (const r of ROOTS) walk(r);
      return { files, dirs, skipped };
    };
    onmessage = async e => {
      const m = e.data;
      try {
        if (m.k === "init") {
          origin = m.origin;
          importScripts(m.base + "pyodide.js");
          py = await loadPyodide({ indexURL: m.base });
          py.setStdout({ write(b) { emit("o", dec.o.decode(b, { stream: true })); return b.length; } });
          py.setStderr({ write(b) { emit("e", dec.e.decode(b, { stream: true })); return b.length; } });
          py.setStdin({ stdin() { flush(); return readLine(); } });
          py.runPython(m.prelude);
          postMessage({ k: "ready", version: py.runPython("import sys; sys.version.split()[0]") });
        } else if (m.k === "run") {
          chan = m.chan;
          if (m.files) putFiles(m);
          py.FS.chdir(m.cwd);
          let code;
          if (m.kind === "repl-start") { py.globals.get("_crew_repl_start")(); code = 0; }
          else if (m.kind === "repl-line") code = py.globals.get("_crew_repl_push")(m.line);
          else code = py.globals.get("_crew_run")(m.src, m.filename, JSON.stringify(m.argv));
          flush();
          postMessage({ k: "done", code, ...takeFiles() });
        }
      } catch (err) {
        flush();
        postMessage({ k: m.k === "init" ? "fail" : "crash", text: String((err && err.message) || err) });
      }
    };
  }

  const PY = {
    w: null, loading: null, version: "", listener: null,
    setState(t) { stateEl.textContent = t; },
    async ensure() {
      if (this.w && this.version) return;
      if (this.loading) return this.loading;
      let head;
      try { head = await fetch(PY_BASE + "pyodide-lock.json", { cache: "no-cache" }); } catch { head = null; }
      if (!head || !head.ok) {
        const err = new ShellError("Python isn't installed on the host computer yet.");
        err.setup = true; throw err;
      }
      this.setState("Python: starting…");
      term.write("Starting Python… (the first time takes a few seconds)\n", "tdim");
      this.loading = new Promise((resolveP, reject) => {
        const url = URL.createObjectURL(new Blob(["(" + pyWorkerMain.toString() + ")();"], { type: "text/javascript" }));
        const w = new Worker(url);
        this.w = w;
        const fail = text => { try { w.terminate(); } catch {} URL.revokeObjectURL(url); this.w = null; this.version = ""; this.loading = null; this.setState("Python: not started"); reject(new ShellError(text)); };
        w.onerror = e => fail("couldn't start Python: " + (e.message || "worker error"));
        w.onmessage = e => {
          const m = e.data;
          if (m.k === "ready") { this.version = m.version; this.loading = null; this.setState("Python " + m.version + ": ready"); w.onmessage = ev => this.listener && this.listener(ev.data); w.onerror = ev => this.listener && this.listener({ k: "crash", text: ev.message || "Python stopped" }); resolveP(); }
          else if (m.k === "fail") fail("couldn't start Python: " + m.text);
        };
        w.postMessage({ k: "init", base: PY_BASE, origin: location.origin, prelude: PY_PRELUDE });
      });
      return this.loading;
    },
    kill() {
      if (this.w) { try { this.w.terminate(); } catch {} }
      this.w = null; this.version = ""; this.loading = null; this.listener = null;
      this.setState("Python: not started");
    },
  };

  const newChan = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  async function relay(chan, op, extra = {}) {
    try {
      const r = await fetch("/api/stdin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...S, chan, op, ...extra }) });
      return r.ok;
    } catch { return false; }
  }
  const setupHelp = ctx => {
    ctx.err("Python isn't installed on the host computer yet. It's a one-time download of about 7 MB.\n");
    ctx.note("On the host computer, open a terminal in the CREW folder and run:   python3 setup_python.py\nThen try again here. No restart is needed.\n");
    return 127;
  };

  // Output from a program arrives in pieces: [["o", text], ["e", text]]
  function makeOut(ctx, state) {
    return segs => {
      for (const [s, text] of segs) {
        state.total += text.length;
        if (state.total > MAX_OUT) { if (!state.over) { state.over = true; state.limit(); } return; }
        if (s === "e") { ctx.err(text); state.errText += text; if (state.errText.length > 4000) state.errText = state.errText.slice(-4000); }
        else ctx.out(text);
      }
    };
  }

  async function startPy(ctx) {
    try { await PY.ensure(); return true; }
    catch (e) { if (e.setup) setupHelp(ctx); else ctx.err(e.message + "\n"); return false; }
  }
  function workerPayload() {
    const files = {};
    for (const [p, t] of vfs.files) if (writable(p)) files[p] = t;
    return { files, dirs: [...vfs.dirs].filter(writable) };
  }

  async function runPython(ctx, spec) {
    if (!(await startPy(ctx))) return 127;
    const chan = newChan();
    await relay(chan, "open");
    if (ctx.stdin !== null) { await relay(chan, "lines", { lines: lines(ctx.stdin) }); await relay(chan, "eof"); }
    const state = { total: 0, over: false, errText: "", limit: () => finish(1, true) };
    const show = makeOut(ctx, state);
    let finish;
    const code = await new Promise(resolveRun => {
      let done = false;
      finish = (c, overLimit) => {
        if (done) return; done = true;
        PY.listener = null; sink = null; job = null;
        relay(chan, "close");
        if (overLimit) { PY.kill(); ctx.err(`\nStopped: the program printed more than ${MAX_OUT / 1e6} MB. Is there a loop that never ends?\n`); }
        resolveRun(c);
      };
      job = { kill() { PY.kill(); finish(130); } };
      if (ctx.stdin === null) sink = line => { relay(chan, line === null ? "eof" : "line", line === null ? {} : { text: line }); };
      PY.listener = m => {
        if (m.k === "out") show(m.segs);
        else if (m.k === "done") { applySync(m); finish(m.code); }
        else if (m.k === "crash") { ctx.err("Python stopped: " + m.text + "\n"); PY.kill(); finish(1); }
      };
      PY.setState("Python " + PY.version + ": running");
      PY.w.postMessage({ k: "run", kind: "file", chan, cwd, src: spec.src, filename: spec.filename, argv: spec.argv, ...workerPayload() });
    });
    if (PY.w) PY.setState("Python " + PY.version + ": ready");
    if (code === 1 && state.errText) { const h = hintFrom(PY_HINTS, state.errText); if (h) ctx.note("Hint: " + h + "\n"); }
    return code;
  }

  async function runPythonRepl(ctx) {
    if (!(await startPy(ctx))) return 127;
    const chan = newChan();
    await relay(chan, "open");
    const state = { total: 0, over: false, errText: "", limit: () => {} };
    const show = makeOut(ctx, state);
    let more = false, working = false, finish, pending = null;
    const prompt = () => term.write(more ? "... " : ">>> ", "tprompt");
    const call = payload => new Promise(res => { pending = res; PY.w.postMessage({ k: "run", chan, cwd, ...payload }); });
    const code = await new Promise(resolveRun => {
      let done = false;
      finish = c => { if (done) return; done = true; PY.listener = null; sink = null; job = null; pending = null; relay(chan, "close"); resolveRun(c); };
      job = { kill() { PY.kill(); finish(130); } };
      PY.listener = m => {
        if (m.k === "out") show(m.segs);
        else if (m.k === "done" || m.k === "crash") {
          if (m.k === "crash") { ctx.err("Python stopped: " + m.text + "\n"); PY.kill(); return finish(1); }
          applySync(m);
          const r = pending; pending = null; if (r) r(m.code);
        }
      };
      sink = async line => {
        if (working) { relay(chan, line === null ? "eof" : "line", line === null ? {} : { text: line }); return; }   // input() inside a statement
        if (line === null) { if (!more) { term.write("\n"); return finish(0); } more = false; return prompt(); }
        working = true;
        const r = await call({ kind: "repl-line", line });
        working = false;
        if (!done) { if (r === -1) return finish(0); more = r === 1; prompt(); }
      };
      (async () => {
        const first = await call({ kind: "repl-start", ...workerPayload() });
        if (done) return;
        term.write(`Python ${PY.version} (offline, in your browser). Type exit() or press Ctrl+D to leave.\n`, "tdim");
        prompt();
      })();
    });
    if (PY.w) PY.setState("Python " + PY.version + ": ready");
    return code;
  }

  // =====================================================================
  //  Running JavaScript (a Web Worker per program)
  // =====================================================================
  // Runs inside the worker, squashed onto one line so your line numbers stay right.
  function jsBoot(args) {
    const post = self.postMessage.bind(self);
    let buf = [], last = 0, timer = null, pending = null;
    const flush = () => { clearTimeout(timer); timer = null; if (buf.length) { post({ k: "out", segs: buf }); buf = []; } last = performance.now(); };
    const emit = (s, t) => { buf.push([s, t]); if (buf.length > 200 || performance.now() - last > 30) flush(); else if (!timer) timer = setTimeout(flush, 30); };
    const show = v => {
      if (typeof v === "string") return v;
      if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
      if (typeof v === "bigint") return v + "n";
      if (v instanceof Error) return String(v);
      try { const s = JSON.stringify(v, (k, x) => typeof x === "bigint" ? x + "n" : x, 2); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
    };
    ["log", "info", "debug"].forEach(k => { console[k] = (...a) => emit("o", a.map(show).join(" ") + "\n"); });
    ["warn", "error"].forEach(k => { console[k] = (...a) => emit("e", a.map(show).join(" ") + "\n"); });
    self.input = p => new Promise(res => { flush(); pending = res; post({ k: "need", prompt: p == null ? "" : String(p) }); });
    self.process = { argv: ["node"].concat(args), env: {}, stdout: { write: s => { emit("o", String(s)); return true; } }, stderr: { write: s => { emit("e", String(s)); return true; } }, exit: c => { throw { crewExit: c | 0 }; } };
    let bodyDone = false;
    const timers = new Set();
    const raw = self.setTimeout.bind(self);
    let failed = false;
    const check = () => { if (bodyDone && !timers.size && !pending) raw(() => { if (!failed && !timers.size && !pending) { flush(); post({ k: "fin", code: 0 }); } }, 25); };
    self.onmessage = e => { if (e.data.k === "line" && pending) { const r = pending; pending = null; r(e.data.text); } };
    const lineOf = e => { const m = e && e.stack && String(e.stack).split("\n").find(l => l.includes("blob:")); const n = m && m.match(/:(\d+):\d+\)?\s*$/); return n ? +n[1] : 0; };
    self.__crewEnd = e => {
      failed = true;
      flush();
      if (e && e.crewExit !== undefined) return post({ k: "fin", code: e.crewExit });
      post({ k: "error", text: e && e.name ? e.name + ": " + e.message : String(e), line: lineOf(e) });
    };
    self.__crewDone = () => { bodyDone = true; check(); };
    ["setTimeout", "setInterval"].forEach(name => {
      const orig = self[name], again = name === "setInterval";
      self[name] = (f, ms, ...a) => {
        const id = orig(() => { if (!again) timers.delete(id); try { f(...a); } catch (e) { self.__crewEnd(e); return; } check(); }, ms);
        timers.add(id); return id;
      };
    });
    ["clearTimeout", "clearInterval"].forEach(name => { const orig = self[name]; self[name] = id => { timers.delete(id); orig(id); }; });
    self.addEventListener("unhandledrejection", ev => { ev.preventDefault(); self.__crewEnd(ev.reason instanceof Error ? ev.reason : new Error(String(ev.reason))); });
    self.fetch = self.XMLHttpRequest = self.WebSocket = self.EventSource = self.importScripts = undefined;
  }
  const JS_BOOT = "(" + jsBoot.toString().replace(/\n\s*/g, " ") + ")";

  async function runNode(ctx, spec) {
    const state = { total: 0, over: false, errText: "", limit: () => end(1, true) };
    const show = makeOut(ctx, state);
    const queue = ctx.stdin !== null ? [...lines(ctx.stdin), null] : [];
    const interactive = ctx.stdin === null;
    let w, url, waiting = false, end;
    const source = JS_BOOT + "(" + JSON.stringify(spec.args) + ");(async()=>{try{" + spec.src + "\n}catch(e){__crewEnd(e);return}__crewDone()})();";
    return new Promise(resolveRun => {
      let done = false;
      end = (c, overLimit) => {
        if (done) return; done = true;
        sink = null; job = null;
        try { w.terminate(); } catch {}
        URL.revokeObjectURL(url);
        if (overLimit) ctx.err(`\nStopped: the program printed more than ${MAX_OUT / 1e6} MB. Is there a loop that never ends?\n`);
        if (c === 1 && state.errText) { const h = hintFrom(JS_HINTS, state.errText); if (h) ctx.note("Hint: " + h + "\n"); }
        resolveRun(c);
      };
      const deliver = () => { if (waiting && queue.length) { waiting = false; w.postMessage({ k: "line", text: queue.shift() }); } };
      const fail = (text, line) => { const t = (line > 0 ? `Line ${line}: ` : "") + text + "\n"; ctx.err(t); state.errText = text; end(1); };
      url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try { w = new Worker(url); } catch (e) { URL.revokeObjectURL(url); ctx.err(String(e) + "\n"); return resolveRun(1); }
      job = { kill() { end(130); } };
      if (interactive) sink = line => { queue.push(line); deliver(); };
      w.onerror = e => { e.preventDefault(); fail(String(e.message).replace(/^Uncaught /, ""), e.lineno); };
      w.onmessage = e => {
        const m = e.data;
        if (m.k === "out") show(m.segs);
        else if (m.k === "need") { if (m.prompt && interactive) ctx.out(m.prompt); waiting = true; if (!interactive && !queue.length) queue.push(null); deliver(); }
        else if (m.k === "error") fail(m.text, m.line);
        else if (m.k === "fin") end(m.code);
      };
    });
  }

  // =====================================================================
  //  Start
  // =====================================================================
  PY.setState("Python: not started");
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    term.write("CREW terminal. A safe practice shell in your browser: no internet, files saved here only.\n", "tdim");
    term.write("Type help to see what you can do, or try:  python hello.py\n\n", "tdim");
    showPrompt();
  };
  // The same terminal can sit in its own tab or in the Code tab's bottom panel.
  function place(container, embedded) {
    const top = screen.scrollTop, stick = nearBottom();
    root.classList.toggle("embedded", embedded);
    container.replaceChildren(root);
    screen.scrollTop = stick ? screen.scrollHeight : top;
  }
  document.querySelector('.tabs button[data-tab="terminal"]')?.addEventListener("click", () => { place(pane, false); start(); });
  setTimeout(() => { if (!pane.classList.contains("hidden")) start(); }, 0);
  window.crewTerminal = {
    focus: () => input.focus(),
    start,
    mount(container) { start(); place(container, true); input.focus(); },
    unmount() { place(pane, false); },
    clear() { clearBtn.click(); },
    interrupt,
    runLine(text) { if (busy || sink) return false; start(); input.value = text; submit(); return true; },
  };
})();
