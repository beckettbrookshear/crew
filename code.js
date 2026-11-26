/* CREW Code tab: a shared editor, a Run button, and a snippet board.
 *
 * Loaded after the main page script, so it can use its helpers
 * ($, el, send, S, handle, amOwner). It fills <div id="tab-code"> and wraps
 * handle() to receive the server's code messages (see codeshare.py).
 *
 * Running happens only in your own browser: JavaScript runs in a Web Worker
 * and HTML in a sandboxed frame. Both are cut off from the internet, from
 * CREW and from your files, so running someone else's code is low-risk.
 * (That's a safety net against accidents and simple tricks, not a promise
 * that nothing could ever get out, so still read code you don't trust.)
 */
(() => {
  "use strict";
  const pane = document.getElementById("tab-code");
  if (!pane) return;

  const LANGS = [
    ["javascript", "JavaScript (runs here)", "js"], ["html", "HTML page (runs here)", "html"],
    ["css", "CSS", "css"], ["python", "Python", "py"], ["java", "Java", "java"],
    ["c", "C", "c"], ["cpp", "C++", "cpp"], ["csharp", "C#", "cs"], ["go", "Go", "go"],
    ["rust", "Rust", "rs"], ["ruby", "Ruby", "rb"], ["php", "PHP", "php"],
    ["sql", "SQL", "sql"], ["bash", "Shell script", "sh"], ["text", "Plain text", "txt"],
  ];
  const RUNNABLE = new Set(["javascript", "html"]);
  const IN_TERMINAL = new Set(["python"]);      // run by the Terminal (terminal.js), shown in the panel
  const RUN_MS = 10000;          // longest a run may take
  const AFTER_MS = 2000;         // how long to keep listening after the script ends (timers)

  const EXAMPLES = {
    "": ["Start from an example…", null, null],
    hello: ["JavaScript: Hello, world", "javascript",
`// Press the Run button above to try this.
// Lines starting with // are comments: the computer ignores them.

const name = "CREW";
console.log("Hello, " + name + "!");

// A loop: do something several times.
for (let i = 1; i <= 3; i++) {
  console.log("Count: " + i);
}
`],
    fizz: ["JavaScript: FizzBuzz", "javascript",
`// Print 1 to 20. For multiples of 3 print Fizz, of 5 print Buzz, of both FizzBuzz.
for (let n = 1; n <= 20; n++) {
  if (n % 15 === 0) console.log("FizzBuzz");
  else if (n % 3 === 0) console.log("Fizz");
  else if (n % 5 === 0) console.log("Buzz");
  else console.log(n);
}
`],
    list: ["JavaScript: Lists and functions", "javascript",
`// A function turns input into output.
function double(x) {
  return x * 2;
}

const numbers = [1, 2, 3, 4, 5];
const doubled = numbers.map(double);
console.log("Doubled:", doubled);
console.log("Total:", doubled.reduce((sum, x) => sum + x, 0));
`],
    page: ["HTML: My first web page", "html",
`<!-- Press Run to see this page below the editor. -->
<h1>Hello from CREW</h1>
<button id="b">Click me</button>
<p id="out"></p>

<style>
  body { font-family: sans-serif; padding: 12px; }
  button { padding: 6px 12px; }
</style>

<script>
  let clicks = 0;
  document.getElementById("b").onclick = () => {
    clicks++;
    document.getElementById("out").textContent = "Clicked " + clicks + " times";
    console.log("clicked", clicks);
  };
</script>
`],
  };

  // Plain-English help for the errors beginners hit most.
  const HINTS = [
    [/(\w+) is not defined/i, "JavaScript doesn't know that name. Check the spelling (capital letters matter), or create it first with let or const."],
    [/is not a function/i, "You tried to call something that isn't a function. Check the spelling, and that you aren't using () on a plain value."],
    [/Cannot read propert(?:y|ies) of (undefined|null)/i, "Something is empty (undefined or null) when the code expected an object. Print it with console.log just before this line to see what it holds."],
    [/Unexpected (token|end of input|identifier|string)|missing \)|Invalid or unexpected token/i, "That's a typing mistake in the code's structure. Look for a missing or extra ) ] } or quote, on this line or the one before."],
    [/Assignment to constant variable/i, "A name made with const can't be changed. Use let instead if it needs to change."],
    [/already been declared/i, "That name is used twice. Rename one, or remove the second let/const."],
    [/Maximum call stack/i, "A function keeps calling itself without stopping. Add a condition that ends the repeating."],
  ];
  const hintFor = msg => (HINTS.find(([rx]) => rx.test(msg)) || [])[1] || "";

  // =====================================================================
  // The Code tab is laid out like a desktop code editor: an activity bar,
  // a side bar (Explorer / Search / Run), editor tabs, a syntax-coloured
  // editor with line numbers, bracket matching and a minimap, a panel
  // (Problems / Output / Preview), a status bar, a command palette
  // (Ctrl+Shift+P or F1) and the usual keyboard shortcuts.
  // =====================================================================
  const MONO = `Menlo, Monaco, Consolas, "Droid Sans Mono", "DejaVu Sans Mono", "Courier New", monospace`;
  const LANG_COLOR = { javascript: "#e8d44d", html: "#e8734a", css: "#4fa3e8", python: "#5b9bd5", java: "#e0823d", c: "#7fa2cf",
    cpp: "#7fa2cf", csharp: "#a07de0", go: "#4ec3dd", rust: "#d9895c", ruby: "#e0524b", php: "#8f93e0", sql: "#e3bd52", bash: "#8dc85a", text: "#9aa0aa" };
  const LANG_TAG = { javascript: "JS", html: "<>", css: "#", python: "PY", java: "J", c: "C", cpp: "C+", csharp: "C#", go: "GO",
    rust: "RS", ruby: "RB", php: "PHP", sql: "SQL", bash: "$_", text: "≡" };
  // Line icons in VS Code's style. Most paths come from Feather Icons (MIT licence, https://feathericons.com).
  const ICON = {
    files: '<svg viewBox="0 0 24 24"><path d="M15 3H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z"/><path d="M15 3v4h4"/><path d="M3 8v11a2 2 0 0 0 2 2h9"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="14" cy="10" r="6.5"/><path d="M9.3 14.7L3 21"/></svg>',
    run: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path class="fill" d="M7 4.5v15l12-7.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect class="fill" x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
    msg: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M7 8h10M7 12h6"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M9 3h6l-1 6 3.5 3v2h-11v-2L10 9z"/><path d="M12 14v7"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg>',
    max: '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle class="fill" cx="5" cy="12" r="1.4"/><circle class="fill" cx="12" cy="12" r="1.4"/><circle class="fill" cx="19" cy="12" r="1.4"/></svg>',
    clear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    users: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  };

  const style = document.createElement("style");
  style.textContent = `
    #tab-code.pane { padding: 0; }
    #tab-code .ide { --ide-bg:#1e1e1e; --ide-side:#252526; --ide-act:#333333; --ide-tabs:#252526; --ide-line:#2b2b2b; --ide-text:#d4d4d4;
      --ide-mut:#a0a0a0; --ide-dim:#858585; --ide-hl:#2a2d2e; --ide-hover:#2a2d2e; --ide-input:#3c3c3c; --ide-sel:#264f78;
      --ide-accent:#007acc; --ide-caret:#aeafad; --ide-status:#007acc; --ide-status-text:#fff; --ide-shadow:rgba(0,0,0,.36);
      --tk-c:#6a9955; --tk-s:#ce9178; --tk-n:#b5cea8; --tk-k:#569cd6; --tk-l:#569cd6; --tk-f:#dcdcaa; --tk-t:#4ec9b0;
      --tk-tag:#569cd6; --tk-attr:#9cdcfe; --tk-p:#9cdcfe; --tk-r:#d16969; --br0:#ffd700; --br1:#da70d6; --br2:#179fff;
      --err:#f14c4c; --warn:#cca700; --ok:#73c991; --tk-ctl:#c586c0; --ide-tab-off:#2d2d2d; --ide-selrow:#37373d; --ide-btn:#0e639c;
      display: grid; grid-template-columns: 44px var(--side-w, 240px) minmax(0, 1fr) auto; grid-template-rows: minmax(0, 1fr) 24px;
      height: 640px; background: var(--ide-bg); color: var(--ide-text); border-radius: var(--r, 10px); overflow: hidden;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif; position: relative; }
    #tab-code .ide.light { --ide-bg:#ffffff; --ide-side:#f3f3f3; --ide-act:#2c2c2c; --ide-tabs:#f3f3f3; --ide-line:#e5e5e5; --ide-text:#333333;
      --ide-mut:#616161; --ide-dim:#8a8a8a; --ide-hl:#e8e8e8; --ide-hover:#e8e8e8; --ide-input:#ffffff; --ide-sel:#add6ff;
      --ide-caret:#000000; --ide-status:#007acc; --ide-shadow:rgba(0,0,0,.18);
      --tk-c:#008000; --tk-s:#a31515; --tk-n:#098658; --tk-k:#0000ff; --tk-l:#0000ff; --tk-f:#795e26; --tk-t:#267f99;
      --tk-tag:#800000; --tk-attr:#e50000; --tk-p:#001080; --tk-r:#811f3f; --br0:#0431fa; --br1:#319331; --br2:#7b3814;
      --tk-ctl:#af00db; --ide-tab-off:#ececec; --ide-selrow:#e4e6f1; --ide-btn:#007acc; }
    #tab-code .ide.noside { grid-template-columns: 44px 0 minmax(0, 1fr) auto; }
    #tab-code .ide #codeAside { grid-row: 1; grid-column: 4; width: min(380px, 40vw); border-left: 1px solid var(--ide-line); background: var(--ide-side); overflow: auto; min-height: 0; }
    @media (max-width: 760px) { #tab-code .ide #codeAside { width: 78vw; } }
    #tab-code .ide.noside .side, #tab-code .ide.noside .sash-side { display: none; }
    #tab-code .ide button { font: inherit; color: inherit; }
    #tab-code .ide .hidden { display: none !important; }
    #tab-code .ide .dim { color: var(--ide-dim); }

    /* activity bar */
    #tab-code .ide .act { grid-row: 1; background: var(--ide-act); display: flex; flex-direction: column; align-items: center; }
    #tab-code .ide .act button { width: 44px; height: 46px; border: 0; background: none; border-radius: 0; color: var(--ide-dim); padding: 0;
      display: grid; place-items: center; position: relative; cursor: pointer; }
    #tab-code .ide .act button:hover { color: var(--ide-text); }
    #tab-code .ide .act button.on { color: var(--ide-text); box-shadow: inset 2px 0 var(--ide-accent); }
    #tab-code .ide .act svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    #tab-code .ide .act .grow { flex: 1; }
    #tab-code .ide .act .pip { position: absolute; right: 6px; bottom: 8px; min-width: 15px; height: 15px; border-radius: 8px; background: var(--ide-accent);
      color: #fff; font-size: 10px; line-height: 15px; text-align: center; padding: 0 3px; }

    /* side bar */
    #tab-code .ide .side { background: var(--ide-side); border-right: 1px solid var(--ide-line); overflow: auto; min-width: 0; }
    #tab-code .ide .side h4 { margin: 0; padding: 11px 12px 8px 20px; font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--ide-mut); }
    #tab-code .ide .sec > summary { list-style: none; cursor: pointer; padding: 4px 6px; font-size: 11px; font-weight: 700; letter-spacing: .04em;
      text-transform: uppercase; display: flex; align-items: center; gap: 4px; border-top: 1px solid var(--ide-line); user-select: none; }
    #tab-code .ide .sec > summary::-webkit-details-marker { display: none; }
    #tab-code .ide .sec > summary::before { content: "›"; display: inline-block; width: 12px; text-align: center; font-size: 14px; transition: transform .1s; }
    #tab-code .ide .sec[open] > summary::before { transform: rotate(90deg); }
    #tab-code .ide .item { display: flex; align-items: center; gap: 6px; padding: 2px 8px 2px 22px; cursor: pointer; white-space: nowrap; min-height: 22px; }
    #tab-code .ide .item:hover { background: var(--ide-hover); }
    #tab-code .ide .item.on { background: var(--ide-hl); box-shadow: inset 0 0 0 1px var(--ide-accent); }
    #tab-code .ide .item .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    #tab-code .ide .item .acts { display: none; gap: 1px; }
    #tab-code .ide .item:hover .acts { display: flex; }
    #tab-code .ide .item .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ide-text); flex: none; }
    #tab-code .ide .item mark, #tab-code .ide .pal mark { background: rgba(234,170,60,.35); color: inherit; border-radius: 2px; }
    #tab-code .ide .tag { font: 700 9.5px/1 ${MONO}; min-width: 18px; text-align: center; flex: none; }
    #tab-code .ide .sym { font-size: 12px; width: 14px; text-align: center; flex: none; }
    #tab-code .ide .sym.f { color: #b48ef0; } #tab-code .ide .sym.c { color: #e8a33c; } #tab-code .ide .sym.v { color: #68b0f4; }
    #tab-code .ide .empty-note { padding: 4px 22px 8px; color: var(--ide-dim); font-size: 12px; }
    #tab-code .ide .spad { padding: 0 12px 10px 20px; }
    #tab-code .ide .side input { width: 100%; background: var(--ide-input); border: 1px solid var(--ide-line); color: var(--ide-text); padding: 4px 7px;
      border-radius: 3px; font-size: 13px; }
    #tab-code .ide .side input:focus { outline: 1px solid var(--ide-accent); border-color: var(--ide-accent); }
    #tab-code .ide .hit { padding-left: 20px; flex-direction: column; align-items: stretch; gap: 0; }
    #tab-code .ide .hit .nm { font-family: ${MONO}; font-size: 12px; }
    #tab-code .ide .hit .dim { font-size: 11px; }
    #tab-code .ide .bigrun { width: 100%; background: var(--ide-accent); color: #fff; border: 0; border-radius: 3px; padding: 6px; font-weight: 600; cursor: pointer; margin: 2px 0 6px; }
    #tab-code .ide .bigrun:disabled { opacity: .45; cursor: default; }
    #tab-code .ide .note { color: var(--ide-mut); font-size: 12.5px; margin: 6px 0; }
    #tab-code .ide ul.help { margin: 4px 0 10px; padding-left: 16px; color: var(--ide-mut); font-size: 12.5px; }
    #tab-code .ide ul.help li { margin: 3px 0; }
    #tab-code .ide table.keys { width: 100%; font-size: 12px; border-collapse: collapse; color: var(--ide-mut); }
    #tab-code .ide table.keys td { padding: 2px 0; }
    #tab-code .ide kbd { font: 11px ${MONO}; background: var(--ide-hover); border: 1px solid var(--ide-line); border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; color: var(--ide-text); white-space: nowrap; }

    /* editor column */
    #tab-code .ide .main { display: grid; grid-template-rows: 35px 22px minmax(0, 1fr) var(--panel-h, 200px); min-width: 0; min-height: 0; position: relative; }
    #tab-code .ide.nopanel .main { grid-template-rows: 35px 22px minmax(0, 1fr) 0; }
    #tab-code .ide.nopanel .panel { display: none; }
    #tab-code .ide .tabsbar { display: flex; background: var(--ide-tabs); align-items: stretch; min-width: 0; overflow: hidden; }
    #tab-code .ide .etab { display: flex; align-items: center; gap: 6px; padding: 0 10px 0 12px; background: var(--ide-tabs); color: var(--ide-mut);
      border-right: 1px solid var(--ide-line); cursor: pointer; white-space: nowrap; font-size: 13px; }
    #tab-code .ide .etab.on { background: var(--ide-bg); color: var(--ide-text); box-shadow: inset 0 1px var(--ide-accent); }
    #tab-code .ide .etab.peek .nm { font-style: italic; }
    #tab-code .ide .etab .x { width: 18px; height: 18px; display: grid; place-items: center; border-radius: 4px; color: var(--ide-mut); visibility: hidden; }
    #tab-code .ide .etab .x:hover { background: var(--ide-hover); }
    #tab-code .ide .etab:hover .x, #tab-code .ide .etab.on .x { visibility: visible; }
    #tab-code .ide .etab .dirty { width: 8px; height: 8px; border-radius: 50%; background: var(--ide-text); }
    #tab-code .ide .tactions { margin-left: auto; display: flex; align-items: center; gap: 1px; padding: 0 6px; flex: none; }
    #tab-code .ide .ib { border: 0; background: none; color: var(--ide-mut); padding: 3px 6px; border-radius: 4px; font-size: 13px; line-height: 1.2; cursor: pointer; min-width: 24px; }
    #tab-code .ide .ib:hover { background: var(--ide-hover); color: var(--ide-text); }
    #tab-code .ide .ib:disabled { opacity: .35; cursor: default; background: none; }
    #tab-code .ide .ib.run { color: var(--ok); font-size: 14px; }
    #tab-code .ide .ib.on { background: var(--ide-hl); color: var(--ide-text); box-shadow: inset 0 0 0 1px var(--ide-accent); }
    #tab-code .ide .crumbs { font-size: 12.5px; color: var(--ide-mut); padding: 2px 14px; background: var(--ide-bg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #tab-code .ide .crumbs b { color: var(--ide-text); font-weight: 400; }
    #tab-code .ide .ed { position: relative; display: flex; min-height: 0; background: var(--ide-bg); }
    #tab-code .ide .gut { flex: none; overflow: hidden; color: var(--ide-dim); text-align: right; user-select: none; font: var(--fs, 13.5px)/var(--lh, 20px) ${MONO}; }
    #tab-code .ide .gutin { padding: 4px 16px 0 12px; will-change: transform; }
    #tab-code .ide .gut .ln { height: var(--lh, 20px); }
    #tab-code .ide .gut .ln.on { color: var(--ide-text); }
    #tab-code .ide .gut .ln.err { color: var(--err); }
    #tab-code .ide .area { position: relative; flex: 1; min-width: 0; overflow: hidden; }
    #tab-code .ide .layer { position: absolute; top: 0; left: 0; pointer-events: none; will-change: transform; min-width: 100%; }
    #tab-code .ide .curline { position: absolute; left: 0; right: 0; height: var(--lh, 20px); box-shadow: inset 0 0 0 1px var(--ide-hl); background: color-mix(in srgb, var(--ide-hl) 55%, transparent); }
    #tab-code .ide pre.hl, #tab-code .ide textarea.src { margin: 0; border: 0; padding: 4px 28px 4px 6px; font: var(--fs, 13.5px)/var(--lh, 20px) ${MONO};
      font-variant-ligatures: none; letter-spacing: 0; tab-size: 2; -moz-tab-size: 2; white-space: pre; overflow-wrap: normal; word-wrap: normal; box-sizing: border-box; }
    #tab-code .ide pre.hl { position: relative; color: var(--ide-text); width: max-content; min-width: 100%; }
    #tab-code .ide textarea.src { position: absolute; inset: 0; width: 100%; height: 100%; resize: none; background: transparent; color: transparent;
      caret-color: var(--ide-caret); outline: none; overflow: auto; border-radius: 0; z-index: 1; }
    #tab-code .ide textarea.src::selection { background: var(--ide-sel); color: transparent; }
    #tab-code .ide textarea.src::placeholder { color: var(--ide-dim); white-space: pre; }
    #tab-code .ide .tk-c { color: var(--tk-c); font-style: italic; } #tab-code .ide .tk-s { color: var(--tk-s); } #tab-code .ide .tk-n { color: var(--tk-n); }
    #tab-code .ide .tk-k { color: var(--tk-k); } #tab-code .ide .tk-ctl { color: var(--tk-ctl); } #tab-code .ide .tk-l { color: var(--tk-l); } #tab-code .ide .tk-f { color: var(--tk-f); } #tab-code .ide .tk-t { color: var(--tk-t); }
    #tab-code .ide .tk-tag { color: var(--tk-tag); } #tab-code .ide .tk-attr { color: var(--tk-attr); } #tab-code .ide .tk-p { color: var(--tk-p); } #tab-code .ide .tk-r { color: var(--tk-r); }
    #tab-code .ide .br0 { color: var(--br0); } #tab-code .ide .br1 { color: var(--br1); } #tab-code .ide .br2 { color: var(--br2); }
    #tab-code .ide .mb { box-shadow: inset 0 0 0 1px var(--ide-mut); border-radius: 2px; background: rgba(128,140,160,.18); }
    #tab-code .ide .fm { background: rgba(234,170,60,.28); border-radius: 2px; }
    #tab-code .ide .fm.cur { background: rgba(234,170,60,.62); box-shadow: 0 0 0 1px #e5b850; }
    #tab-code .ide .sq { text-decoration: underline wavy var(--err); text-decoration-skip-ink: none; text-underline-offset: 3px; }

    /* minimap */
    #tab-code .ide .mini { flex: none; width: 84px; position: relative; overflow: hidden; cursor: pointer; box-shadow: inset 1px 0 var(--ide-line); }
    #tab-code .ide.nomini .mini { display: none; }
    #tab-code .ide .mini pre.hl { position: absolute; top: 0; left: 4px; transform-origin: 0 0; pointer-events: none; opacity: .8; min-width: 0; width: max-content; padding: 4px 0; }
    #tab-code .ide .mini .view { position: absolute; left: 0; right: 0; background: rgba(140,150,170,.14); }
    #tab-code .ide .mini:hover .view { background: rgba(140,150,170,.24); }

    /* find widget */
    #tab-code .ide .find { position: absolute; top: 0; right: 100px; z-index: 4; background: var(--ide-side); border: 1px solid var(--ide-line); border-top: 0;
      box-shadow: 0 2px 10px var(--ide-shadow); padding: 5px 6px; display: grid; gap: 4px; border-radius: 0 0 5px 5px; }
    #tab-code .ide .find .frow { display: flex; align-items: center; gap: 2px; }
    #tab-code .ide .find input { background: var(--ide-input); border: 1px solid var(--ide-line); color: var(--ide-text); padding: 3px 6px; width: 200px; border-radius: 3px; font-size: 13px; }
    #tab-code .ide .find input:focus { outline: none; border-color: var(--ide-accent); }
    #tab-code .ide .find .cnt { font-size: 12px; color: var(--ide-mut); min-width: 70px; padding: 0 6px; white-space: nowrap; }

    /* snippet preview */
    #tab-code .ide .peekview { position: absolute; inset: 0; z-index: 3; background: var(--ide-bg); display: grid; grid-template-rows: auto minmax(0, 1fr); }
    #tab-code .ide .peekhead { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--ide-line); font-size: 12.5px; color: var(--ide-mut); }
    #tab-code .ide .peekhead b { color: var(--ide-text); }
    #tab-code .ide .peekhead .grow { flex: 1; }
    #tab-code .ide .peekbody { overflow: auto; }
    #tab-code .ide .peekbody pre.hl { counter-reset: ln; padding-left: 0; }
    #tab-code .ide .peekbody .row { display: block; }
    #tab-code .ide .peekbody .row::before { counter-increment: ln; content: counter(ln); display: inline-block; width: 4.5ch; padding-right: 16px; text-align: right; color: var(--ide-dim); }
    #tab-code .ide .peekbody .row.on { background: var(--ide-hl); }

    /* panel */
    #tab-code .ide .panel { border-top: 1px solid var(--ide-line); display: grid; grid-template-rows: 32px minmax(0, 1fr); min-height: 0; background: var(--ide-bg); position: relative; }
    #tab-code .ide .ptabs { display: flex; align-items: center; gap: 4px; padding: 0 8px 0 12px; min-width: 0; }
    #tab-code .ide .ptabs .pt { border: 0; background: none; color: var(--ide-mut); padding: 6px 6px 5px; border-radius: 0; border-bottom: 1px solid transparent;
      font-size: 11px; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; }
    #tab-code .ide .ptabs .pt:hover { color: var(--ide-text); }
    #tab-code .ide .ptabs .pt.on { color: var(--ide-text); border-bottom-color: var(--ide-text); }
    #tab-code .ide .ptabs .pcount { display: inline-block; min-width: 16px; height: 16px; line-height: 16px; border-radius: 8px; background: var(--ide-hover);
      font-size: 10px; text-align: center; margin-left: 5px; padding: 0 4px; }
    #tab-code .ide .ptabs .grow { flex: 1; }
    #tab-code .ide .ptabs .pstate { font-size: 12px; color: var(--ide-mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #tab-code .ide .pbody { overflow: auto; min-height: 0; }
    #tab-code .ide .termbox { height: 100%; min-height: 0; overflow: hidden; }
    #tab-code .ide .pbody:has(> .termbox:not(.hidden)) { overflow: hidden; }
    #tab-code .ide .lines { padding: 4px 14px; font: 12.5px/1.55 ${MONO}; white-space: pre-wrap; word-break: break-word; }
    #tab-code .ide .lines .warn { color: var(--warn); }
    #tab-code .ide .lines .error { color: var(--err); }
    #tab-code .ide .lines .hint { color: var(--ide-mut); font: 12.5px/1.45 system-ui, sans-serif; margin: 0 0 4px; }
    #tab-code .ide .lines .empty, #tab-code .ide .probs .empty { color: var(--ide-dim); font: 12.5px system-ui, sans-serif; padding: 4px 0; }
    #tab-code .ide .probs { padding: 2px 0; }
    #tab-code .ide .probs .empty { padding: 6px 14px; }
    #tab-code .ide .prob { padding: 2px 14px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
    #tab-code .ide .prob:hover { background: var(--ide-hover); }
    #tab-code .ide .prob .dim { white-space: nowrap; margin-left: auto; padding-left: 8px; }
    #tab-code .ide .prob .perr { color: var(--err); } #tab-code .ide .prob .pwarn { color: var(--warn); }
    #tab-code .ide .framebox iframe { display: block; width: 100%; height: 100%; min-height: 160px; border: 0; background: #fff; }
    #tab-code .ide .framebox { height: 100%; }
    #tab-code .ide .sash-side { position: absolute; top: 0; bottom: 24px; width: 5px; cursor: ew-resize; z-index: 5; }
    #tab-code .ide .sash-panel { position: absolute; left: 0; right: 0; top: -3px; height: 6px; cursor: ns-resize; z-index: 5; }
    #tab-code .ide .sash-side:hover, #tab-code .ide .sash-panel:hover, #tab-code .ide .dragging { background: var(--ide-accent); }

    /* status bar */
    #tab-code .ide .sbar { grid-column: 1 / -1; background: var(--ide-status); color: var(--ide-status-text); display: flex; align-items: stretch; font-size: 12px;
      padding: 0 6px; white-space: nowrap; overflow: hidden; }
    #tab-code .ide .sbar.conflict { background: #b35d16; }
    #tab-code .ide .sbar .si { padding: 0 7px; display: flex; align-items: center; gap: 4px; border: 0; background: none; color: inherit; border-radius: 0; font-size: 12px; }
    #tab-code .ide .sbar button.si { cursor: pointer; }
    #tab-code .ide .sbar button.si:hover { background: rgba(255,255,255,.16); }
    #tab-code .ide .sbar .grow { flex: 1; }
    #tab-code .ide .sbar .soft { opacity: .85; }

    /* command palette, notifications */
    #tab-code .ide .pal { position: absolute; top: 6px; left: 50%; transform: translateX(-50%); width: min(600px, 94%); background: var(--ide-side);
      border: 1px solid var(--ide-line); box-shadow: 0 8px 28px var(--ide-shadow); z-index: 20; border-radius: 6px; padding: 6px; }
    #tab-code .ide .pal input { width: 100%; background: var(--ide-input); border: 1px solid var(--ide-accent); color: var(--ide-text); padding: 5px 8px;
      border-radius: 3px; font-size: 13.5px; outline: none; }
    #tab-code .ide .pal .opts { max-height: 340px; overflow: auto; margin-top: 5px; }
    #tab-code .ide .pal .opt { display: flex; align-items: center; padding: 3px 8px; gap: 8px; cursor: pointer; border-radius: 3px; min-height: 24px; }
    #tab-code .ide .pal .opt.on { background: var(--ide-hl); box-shadow: inset 0 0 0 1px var(--ide-accent); }
    #tab-code .ide .pal .opt .det { color: var(--ide-mut); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tab-code .ide .pal .opt .k { margin-left: auto; flex: none; }
    #tab-code .ide .pal .hint { color: var(--ide-mut); font-size: 12.5px; padding: 4px 8px; }
    #tab-code .ide .toast { position: absolute; right: 14px; bottom: 36px; z-index: 15; background: var(--ide-side); border: 1px solid var(--ide-line);
      box-shadow: 0 4px 18px var(--ide-shadow); padding: 10px 12px; border-radius: 6px; max-width: min(400px, 90%); display: grid; gap: 8px; font-size: 13px; }
    #tab-code .ide .toast .row { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    #tab-code .ide .toast button { background: var(--ide-hover); border: 1px solid var(--ide-line); border-radius: 3px; padding: 3px 10px; cursor: pointer; }
    #tab-code .ide .toast button.primary { background: var(--ide-accent); border-color: var(--ide-accent); color: #fff; }
    #tab-code .ide .flash { bottom: 36px; }


    /* ---- VS Code look ---- */
    /* scrollbars like VS Code's: slim, no arrows, see-through */
    #tab-code .ide ::-webkit-scrollbar { width: 10px; height: 10px; }
    #tab-code .ide ::-webkit-scrollbar-track, #tab-code .ide ::-webkit-scrollbar-corner { background: transparent; }
    #tab-code .ide ::-webkit-scrollbar-thumb { background: rgba(121,121,121,.4); }
    #tab-code .ide ::-webkit-scrollbar-thumb:hover { background: rgba(100,100,100,.7); }
    #tab-code .ide ::-webkit-scrollbar-thumb:active { background: rgba(191,191,191,.4); }
    #tab-code .ide ::-webkit-scrollbar-button { display: none; }
    /* (the page sets thin scrollbars everywhere; inside the editor use VS Code's instead) */
    :root #tab-code .ide, :root #tab-code .ide * { scrollbar-width: auto; scrollbar-color: auto; }
    @supports not selector(::-webkit-scrollbar) { :root #tab-code .ide, :root #tab-code .ide * { scrollbar-width: thin; scrollbar-color: rgba(121,121,121,.45) transparent; } }
    /* icons */
    #tab-code .ide svg { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
    #tab-code .ide svg .fill { fill: currentColor; stroke: none; }
    #tab-code .ide .ib.icon { width: 26px; height: 24px; padding: 0; display: inline-grid; place-items: center; }
    #tab-code .ide .ib.icon svg { width: 16px; height: 16px; }
    #tab-code .ide .ib.run { color: #89d185; }
    #tab-code .ide .act button svg { width: 24px; height: 24px; stroke-width: 1.4; }
    #tab-code .ide .act button { height: 48px; }
    #tab-code .ide .sbar svg { width: 14px; height: 14px; margin-right: 3px; }
    #tab-code .ide .tag svg { width: 13px; height: 13px; vertical-align: -2px; }
    #tab-code .ide .etab { background: var(--ide-tab-off); }
    #tab-code .ide .etab.on { background: var(--ide-bg); }
    #tab-code .ide .item.on { background: var(--ide-selrow); box-shadow: none; }
    #tab-code .ide .ib.on { box-shadow: none; }
    #tab-code .ide .act button.on { box-shadow: inset 2px 0 #fff; color: #fff; }
    #tab-code .ide .act button:hover { color: #fff; }
    #tab-code .ide.light .act button { color: rgba(255,255,255,.55); }
    #tab-code .ide.light .act button.on, #tab-code .ide.light .act button:hover { color: #fff; }
    #tab-code .ide .bigrun, #tab-code .ide .toast button.primary { background: var(--ide-btn); border-color: var(--ide-btn); }
    #tab-code .ide .bigrun:hover { filter: brightness(1.15); }

    /* While the Code tab is open it fills the window, like a desktop editor. */
    body.code-open { overflow: hidden; padding-bottom: 0 !important; }
    body.code-open #crewStatusbar { display: none !important; }
    body.code-open #app { display: flex; flex-direction: column; height: 100vh; }
    body.code-open #app > header { flex: none; }
    body.code-open .layout { flex: 1; min-height: 0; display: block !important; padding: 0 !important; margin: 0 !important; max-width: none !important; gap: 0 !important; }
    body.code-open .layout > aside { display: none !important; }
    body.code-open .layout > main { height: 100%; display: flex; flex-direction: column; border: 0 !important; border-radius: 0 !important; background: transparent !important; }
    body.code-open .layout > main > .tabs { flex: none; }
    body.code-open #tab-code { flex: 1; min-height: 0; padding: 0; }
    body.code-open #tab-code .ide { height: 100% !important; border-radius: 0; }
    /* CREW's own top bars take the editor's colours, so it reads as one title bar. */
    body.code-open.code-dark #app > header, body.code-open.code-dark .layout > main > .tabs { --panel:#3c3c3c; --text:#cccccc; --muted:#a0a0a0; --line:#2b2b2b; --soft:#505050; --accent:#007acc;
      background: #3c3c3c !important; color: #cccccc; border-color: #2b2b2b !important; }
    body.code-open.code-light #app > header, body.code-open.code-light .layout > main > .tabs { --panel:#dddddd; --text:#333333; --muted:#616161; --line:#c8c8c8; --soft:#ececec; --accent:#007acc;
      background: #dddddd !important; color: #333333; border-color: #c8c8c8 !important; }
    body.code-open #app > header .pill, body.code-open #app > header button { background: var(--soft); color: inherit; border-color: transparent; }
    body.code-open .layout > main > .tabs button.on { border-bottom-color: #007acc; }
    /* compact, flat top bars, like VS Code's title area */
    body.code-open #app > header { padding: 4px 10px; gap: 8px; min-height: 0; }
    body.code-open #app > header .pill { font-size: 11.5px; padding: 1px 8px; }
    body.code-open #app > header button { padding: 3px 10px; font-size: 12px; }
    body.code-open .layout > main > .tabs { justify-content: flex-start !important; flex-wrap: nowrap !important; overflow-x: auto; padding: 0 4px !important; gap: 0 !important; scrollbar-width: none; }
    body.code-open .layout > main > .tabs button { border: 0 !important; border-bottom: 1px solid transparent !important; border-radius: 0 !important; background: none !important;
      padding: 7px 12px !important; font-size: 13px !important; font-weight: 400 !important; color: var(--muted) !important; white-space: nowrap; }
    body.code-open .layout > main > .tabs button:hover { color: var(--text) !important; }
    body.code-open .layout > main > .tabs button.on { color: var(--text) !important; border-bottom-color: #007acc !important; }
    body.code-open.code-dark .layout > main > .tabs button.on { color: #ffffff; }

    body.ide-full #tab-code { position: fixed; inset: 0; z-index: 60; }
    body.ide-full #tab-code .ide { height: 100vh !important; border-radius: 0; }
    @media (max-width: 760px) {
      #tab-code .ide .mini { display: none; }
      #tab-code .ide .sbar .wide { display: none; }
      #tab-code .ide .find { right: 8px; left: 8px; } #tab-code .ide .find input { width: 100%; min-width: 0; }
    }
  `;
  document.head.append(style);

  // ---------- small helpers ----------
  const svg = s => { const t = document.createElement("template"); t.innerHTML = s.trim(); return t.content.firstChild; };
  const ib = (text, title, onclick, cls = "") => el("button", { type: "button", className: "ib " + cls, textContent: text, title, onclick });
  const ibi = (icon, title, onclick, cls = "") => { const b = ib("", title, onclick, "icon " + cls); b.ariaLabel = title; b.append(svg(icon)); return b; };
  const kbd = k => el("kbd", { textContent: k });
  const esc = s => s.replace(/[&<>]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;");
  const prefs = Object.assign({ side: innerWidth > 760, panel: true, mini: true, fs: 14, light: false, view: "explorer", sideW: 240, panelH: 200 },
                              store.get("crewIde") || {});
  const savePrefs = () => store.set("crewIde", prefs);
  let LH = 20, CW = 8;            // line height and character width in the editor, in pixels

  // ---------- the frame ----------
  const ide = el("div", { className: "ide" });
  const act = el("nav", { className: "act", ariaLabel: "Views" });
  const side = el("div", { className: "side", role: "complementary" });
  const main = el("section", { className: "main" });
  const statusBar = el("footer", { className: "sbar" });
  const sashSide = el("div", { className: "sash-side", title: "Drag to resize" });
  // A right-hand slot other scripts can fill (codechat.js puts "Ask Claude" here).
  const aside = el("div", { id: "codeAside", className: "hidden" });
  ide.append(act, side, main, aside, statusBar, sashSide);
  new MutationObserver(() => { fit(); schedule(); }).observe(aside, { attributes: true, attributeFilter: ["class"] });
  pane.replaceChildren(ide);

  // ---------- activity bar ----------
  const actBtn = (icon, title, fn) => { const b = el("button", { type: "button", title, ariaLabel: title, onclick: fn }); b.append(svg(icon)); return b; };
  const actButtons = {
    explorer: actBtn(ICON.files, "Explorer (Ctrl+Shift+E)", () => showView("explorer", true)),
    search: actBtn(ICON.search, "Search (Ctrl+Shift+F)", () => showView("search", true)),
    run: actBtn(ICON.run, "Run (Ctrl+Shift+D)", () => showView("run", true)),
  };
  const chatPip = el("span", { className: "pip hidden" });
  const chatAct = actBtn(ICON.chat, "Group chat", () => document.querySelector('.tabs button[data-tab="chat"]')?.click());
  chatAct.append(chatPip);
  const claudeAct = actBtn(ICON.spark, "Claude Code (sign in with your own account)", () => document.getElementById("claudeTab")?.click());
  act.append(actButtons.explorer, actButtons.search, actButtons.run, chatAct, claudeAct, el("div", { className: "grow" }),
    actBtn(ICON.gear, "Commands (Ctrl+Shift+P or F1)", () => palette("cmd")));

  function showView(id, toggle) {
    if (toggle && prefs.side && prefs.view === id) prefs.side = false;
    else { prefs.side = true; prefs.view = id; }
    savePrefs(); layout();
    if (prefs.side && id === "search") setTimeout(() => { searchBox.focus(); searchBox.select(); }, 0);
  }
  { // mirror the main page's chat count and Claude Code tab onto the activity bar
    const unreadEl = document.getElementById("unread"), claudeTab = document.getElementById("claudeTab");
    const sync = () => {
      const n = unreadEl && !unreadEl.classList.contains("hidden") ? unreadEl.textContent : "";
      chatPip.textContent = n; chatPip.classList.toggle("hidden", !n);
      claudeAct.classList.toggle("hidden", !claudeTab || claudeTab.classList.contains("hidden"));
    };
    for (const n of [unreadEl, claudeTab]) if (n) new MutationObserver(sync).observe(n, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }

  // ---------- side bar: explorer ----------
  const section = (title, open, ...body) => el("details", { className: "sec", open }, el("summary", { textContent: title }), ...body);
  const fileItem = el("div", { className: "item on", title: "The shared file everyone in the group edits live" });
  const outlineBox = el("div");
  const snipBox = el("div");
  const exBox = el("div");
  const secWork = section("Group workspace", true, fileItem);
  const secOutline = section("Outline", true, outlineBox);
  const secSnips = section("Pinned snippets", true, snipBox);
  const viewExplorer = el("div", {}, el("h4", { textContent: "Explorer" }), secWork, secOutline, secSnips, section("Examples", false, exBox));
  for (const [k, v] of Object.entries(EXAMPLES)) if (v[1])
    exBox.append(el("div", { className: "item", title: "Load into the shared editor", onclick: () => loadExample(k) },
      langTag(v[1]), el("span", { className: "nm", textContent: v[0].replace(/^[^:]+:\s*/, "") })));
  fileItem.addEventListener("click", () => { closePeek(); ta.focus(); });

  function langTag(l) { return el("span", { className: "tag", textContent: LANG_TAG[l] || "≡", style: `color:${LANG_COLOR[l] || "#999"}` }); }

  // ---------- side bar: search ----------
  const searchBox = el("input", { type: "search", placeholder: "Search the code and snippets", spellcheck: false });
  const searchRes = el("div");
  const viewSearch = el("div", {}, el("h4", { textContent: "Search" }), el("div", { className: "spad" }, searchBox), searchRes);
  searchBox.addEventListener("input", renderSearch);
  searchBox.addEventListener("keydown", e => { if (e.key === "Enter") searchRes.querySelector(".item")?.click(); });
  function hitItem(where, line, text, k, len, fn) {
    const a = Math.max(0, k - 24), t = text.slice(a, k + len + 80);
    return el("div", { className: "item hit", title: `${where}, line ${line}`, onclick: fn },
      el("span", { className: "nm" }, (a ? "…" : "") + t.slice(0, k - a), el("mark", { textContent: t.slice(k - a, k - a + len) }), t.slice(k - a + len)),
      el("span", { className: "dim", textContent: `${where} · line ${line}` }));
  }
  function renderSearch() {
    const q = searchBox.value;
    if (!q) return searchRes.replaceChildren(el("div", { className: "empty-note", textContent: "Type to search every line of the shared file and the pinned snippets." }));
    const lq = q.toLowerCase(), hits = [];
    ta.value.split("\n").forEach((line, i) => {
      const k = line.toLowerCase().indexOf(lq);
      if (k >= 0 && hits.length < 300) hits.push(hitItem(fileName(), i + 1, line, k, q.length, () => revealLine(i + 1, k, q.length)));
    });
    for (const sn of snippets) sn.text.split("\n").forEach((line, i) => {
      const k = line.toLowerCase().indexOf(lq);
      if (k >= 0 && hits.length < 300) hits.push(hitItem("Snippet: " + sn.title, i + 1, line, k, q.length, () => peek(sn, i + 1)));
    });
    searchRes.replaceChildren(el("div", { className: "empty-note", textContent: hits.length ? `${hits.length}${hits.length >= 300 ? "+" : ""} result${hits.length === 1 ? "" : "s"}` : "No results." }), ...hits);
  }

  // ---------- side bar: run ----------
  const runBig = el("button", { type: "button", className: "bigrun", textContent: "▶  Run", onclick: () => run() });
  const runNote = el("p", { className: "note" });
  const viewRun = el("div", {}, el("h4", { textContent: "Run" }),
    el("div", { className: "spad" }, runBig, runNote,
      el("ul", { className: "help" },
        el("li", { textContent: "Everyone in the group edits the same file, live. If two people type at once, you'll be asked whose version to keep." }),
        el("li", { textContent: "Run runs the code on your own computer only, in a sandbox with no internet and no access to your files. JavaScript and HTML can run here; for other languages, copy or download the code and run it where you normally do." }),
        el("li", { textContent: "Pin code as a snippet so it isn't lost when someone changes the file." })),
      el("table", { className: "keys" }, ...[
        ["Command palette", "Ctrl+Shift+P"], ["Run / Stop", "F5 / Shift+F5"], ["Find / Replace", "Ctrl+F / Ctrl+H"],
        ["Go to line", "Ctrl+G"], ["Go to file or snippet", "Ctrl+P"], ["Comment line", "Ctrl+/"], ["Move line", "Alt+↑ / Alt+↓"],
        ["Copy line", "Shift+Alt+↓"], ["Delete line", "Ctrl+Shift+K"], ["Select next match", "Ctrl+D"],
        ["Side bar / panel", "Ctrl+B / Ctrl+J"], ["Font size", "Ctrl+= / Ctrl+-"],
      ].map(([a, b]) => el("tr", {}, el("td", { textContent: a }), el("td", { style: "text-align:right" }, kbd(b)))))));
  const views = { explorer: viewExplorer, search: viewSearch, run: viewRun };
  side.append(viewExplorer, viewSearch, viewRun);

  // ---------- editor tabs and title actions ----------
  const runBtn = ibi(ICON.play, "Run (F5)", () => run(), "run");
  const stopBtn = ibi(ICON.stop, "Stop (Shift+F5)", () => { out("Stopped.", "warn"); stop("Stopped."); });
  const chatBtn = ibi(ICON.msg, "Send the selected code (or all of it) to chat", () => sendToChat());
  const snipBtn = ibi(ICON.pin, "Pin this code as a snippet", () => shareSnippet());
  const copyBtn = ibi(ICON.copy, "Copy all the code", () => copyAll());
  const dlBtn = ibi(ICON.download, "Download this file", () => download());
  const fullBtn = ibi(ICON.max, "Full-window editor", () => toggleFull());
  const moreBtn = ibi(ICON.more, "All commands (Ctrl+Shift+P)", () => palette("cmd"));
  const mainTabName = el("span", { className: "nm" });
  const mainTabDirty = el("span", { className: "dirty hidden", title: "Sending your changes…" });
  const mainTabTag = el("span");
  const mainTab = el("div", { className: "etab on", title: "Shared with everyone in the group", onclick: () => { closePeek(); ta.focus(); } },
    mainTabTag, mainTabName, mainTabDirty);
  const peekName = el("span", { className: "nm" });
  const peekTab = el("div", { className: "etab peek hidden", title: "Snippet preview (read-only)", onclick: () => showPeek() },
    el("span", { className: "tag" }, svg(ICON.pin)), peekName, el("span", { className: "x", textContent: "✕", title: "Close", onclick: e => { e.stopPropagation(); closePeek(true); } }));
  const tabsbar = el("div", { className: "tabsbar" }, mainTab, peekTab,
    el("div", { className: "tactions" }, runBtn, stopBtn, el("span", { id: "codeAsideBtn" }), chatBtn, snipBtn, copyBtn, dlBtn, fullBtn, moreBtn));
  const crumbs = el("div", { className: "crumbs" });

  // ---------- the editor ----------
  const gutIn = el("div", { className: "gutin" });
  const gut = el("div", { className: "gut", ariaHidden: "true" }, gutIn);
  const hl = el("pre", { className: "hl", ariaHidden: "true" });
  const curLine = el("div", { className: "curline" });
  const layer = el("div", { className: "layer" }, curLine, hl);
  const ta = el("textarea", { className: "src", spellcheck: false, autocomplete: "off", wrap: "off", ariaLabel: "Shared code editor",
    placeholder: "Type or paste code here. Everyone in the group sees it live.\n\nTry an example from the Explorer, or press Ctrl+Shift+P for every command." });
  ta.setAttribute("autocapitalize", "off"); ta.setAttribute("autocorrect", "off");
  const area = el("div", { className: "area" }, layer, ta);
  const miniPre = el("pre", { className: "hl" });
  const miniView = el("div", { className: "view" });
  const mini = el("div", { className: "mini", title: "Minimap: click or drag to scroll" }, miniPre, miniView);

  const findIn = el("input", { type: "text", placeholder: "Find", spellcheck: false, ariaLabel: "Find" });
  const replIn = el("input", { type: "text", placeholder: "Replace", spellcheck: false, ariaLabel: "Replace" });
  const findCount = el("span", { className: "cnt" });
  const caseBtn = ib("Aa", "Match case", () => { find.matchCase = !find.matchCase; caseBtn.classList.toggle("on", find.matchCase); doFind(true); });
  const replRow = el("div", { className: "frow" }, replIn, ib("⇄", "Replace (Enter)", () => replaceOne()), ib("⇉", "Replace all", () => replaceAll()));
  const findBox = el("div", { className: "find hidden" },
    el("div", { className: "frow" }, findIn, caseBtn, findCount, ib("↑", "Previous match (Shift+Enter)", () => step(-1)),
      ib("↓", "Next match (Enter)", () => step(1)), ib("✕", "Close (Escape)", () => closeFind())), replRow);

  const peekHead = el("div", { className: "peekhead" });
  const peekBody = el("div", { className: "peekbody" });
  const peekView = el("div", { className: "peekview hidden" }, peekHead, peekBody);
  const conflictBox = el("div", { className: "toast hidden" });
  const flashBox = el("div", { className: "toast flash hidden" });
  const ed = el("div", { className: "ed" }, gut, area, mini, findBox, peekView, conflictBox, flashBox);

  // ---------- the panel ----------
  const pt = id => el("button", { type: "button", className: "pt", onclick: () => showPanel(id) });
  const ptProblems = pt("problems"), ptOutput = pt("output"), ptPreview = pt("preview"), ptTerminal = pt("terminal");
  const probCount = el("span", { className: "pcount" });
  ptProblems.append("Problems", probCount); ptOutput.append("Output"); ptPreview.append("Preview"); ptTerminal.append("Terminal");
  const state = el("span", { className: "pstate" });
  const lines = el("div", { className: "lines" });
  const probList = el("div", { className: "probs hidden" });
  const frameBox = el("div", { className: "framebox hidden" });
  const termBox = el("div", { className: "termbox hidden" });
  const sashPanel = el("div", { className: "sash-panel", title: "Drag to resize" });
  const panel = el("div", { className: "panel" }, sashPanel,
    el("div", { className: "ptabs" }, ptProblems, ptOutput, ptPreview, ptTerminal, el("span", { className: "grow" }), state,
      ibi(ICON.clear, "Clear (output or terminal)", () => panelView === "terminal" ? window.crewTerminal?.clear() : clearOut()), ibi(ICON.close, "Close panel (Ctrl+J)", () => { prefs.panel = false; savePrefs(); layout(); })),
    el("div", { className: "pbody" }, lines, probList, frameBox, termBox));
  main.append(tabsbar, crumbs, ed, panel);
  let panelView = "output";
  function showPanel(id) {
    panelView = id; prefs.panel = true; savePrefs();
    for (const [k, b, box] of [["problems", ptProblems, probList], ["output", ptOutput, lines], ["preview", ptPreview, frameBox], ["terminal", ptTerminal, termBox]]) {
      b.classList.toggle("on", k === id); box.classList.toggle("hidden", k !== id);
    }
    layout();
    if (id === "terminal") mountTerminal();
  }
  function mountTerminal() {       // the one terminal moves in here (it also has its own tab)
    if (!window.crewTerminal) { termBox.textContent = "The terminal isn't available."; return; }
    window.crewTerminal.mount(termBox);
  }
  function toggleTerminal() {      // Ctrl+`
    if (prefs.panel && panelView === "terminal") { prefs.panel = false; savePrefs(); layout(); ta.focus(); }
    else showPanel("terminal");
  }

  // ---------- status bar ----------
  const sbSync = el("button", { type: "button", className: "si", title: "Changes are shared with your group as you type", onclick: () => showView("run") });
  const sbProb = el("button", { type: "button", className: "si", title: "Problems (Ctrl+Shift+M)", onclick: () => showPanel("problems") });
  const sbBy = el("span", { className: "si soft wide" });
  const sbPos = el("button", { type: "button", className: "si", title: "Go to line (Ctrl+G)", onclick: () => palette("goto") });
  const sbLang = el("button", { type: "button", className: "si", title: "Select language mode", onclick: () => palette("lang") });
  const sbPeople = el("button", { type: "button", className: "si wide", title: "People in this group", onclick: () => document.querySelector('.tabs button[data-tab="chat"]')?.click() });
  statusBar.append(sbSync, sbProb, sbBy, el("span", { className: "grow" }), sbPos,
    el("span", { className: "si wide", textContent: "Spaces: 2" }), el("span", { className: "si wide", textContent: "UTF-8" }),
    el("span", { className: "si wide", textContent: "LF" }), sbLang, sbPeople);

  // ---------- command palette ----------
  const palIn = el("input", { type: "text", spellcheck: false, ariaLabel: "Command palette" });
  const palList = el("div", { className: "opts" });
  const palBox = el("div", { className: "pal hidden" }, palIn, palList);
  ide.append(palBox);

  // ======================================================================
  // shared-file state (same protocol as before: see codeshare.py)
  // ======================================================================
  let langId = "javascript";
  let by = "";                     // who last edited the shared code
  let dirty = false;               // I've typed something not yet sent
  let timer = null;
  let remote = null;               // an incoming version waiting for me to accept
  let missed = 0;
  let snippets = [];
  let confirmed = "";              // someone else's code I've agreed to run

  const me = () => (typeof S !== "undefined" && S ? S.name : "");
  const label = () => (LANGS.find(l => l[0] === langId) || LANGS[0]);
  const fileName = () => (langId === "html" ? "index" : "main") + "." + label()[2];
  const lastBy = () => by ? (by === me() ? "Last edit by you" : `Last edit by ${by}`) : "";

  function setLang(l, share) {
    if (!LANGS.some(x => x[0] === l)) return;
    langId = l;
    mainTabTag.replaceChildren(langTag(l));
    mainTabName.textContent = fileName();
    fileItem.replaceChildren(langTag(l), el("span", { className: "nm", textContent: fileName() }), mainTabDirty.cloneNode());
    sbLang.textContent = "{ } " + label()[1].replace(" (runs here)", "");
    ptPreview.classList.toggle("hidden", l !== "html");
    updateCrumbs(); updateButtons(); tokFor = null; schedule();
    if (share) push();
  }
  function updateCrumbs() {
    const room = typeof S !== "undefined" && S ? S.room : "crew";
    crumbs.replaceChildren(room + "  ›  ", el("b", { textContent: fileName() }), symbolAtCaret ? "  ›  " + symbolAtCaret : "");
    secWork.firstChild.textContent = "Group: " + room;
  }
  function syncStatus() {
    statusBar.classList.toggle("conflict", !!remote);
    sbSync.textContent = remote ? "⚠ Conflict: choose a version" : dirty ? "⟳ Sending…" : "✓ Live with group";
    mainTabDirty.classList.toggle("hidden", !dirty);
    const d = fileItem.querySelector(".dirty, .dot"); if (d) d.className = dirty ? "dot" : "hidden";
    sbBy.textContent = lastBy();
  }
  function flash(text, ms = 3500) {
    flashBox.replaceChildren(el("div", { textContent: text }));
    flashBox.classList.remove("hidden");
    clearTimeout(flash.t); flash.t = setTimeout(() => flashBox.classList.add("hidden"), ms);
  }

  function setText(text) {         // replace the editor, keeping the cursor near where it was
    const old = ta.value;
    if (old === text) return;
    let p = 0;
    while (p < old.length && p < text.length && old[p] === text[p]) p++;
    let s = 0;
    while (s < old.length - p && s < text.length - p && old[old.length - 1 - s] === text[text.length - 1 - s]) s++;
    const fix = c => c <= p ? c : c >= old.length - s ? c + text.length - old.length : p;
    const [a, b] = [fix(ta.selectionStart), fix(ta.selectionEnd)];
    const top = ta.scrollTop, left = ta.scrollLeft;
    ta.value = text;
    ta.setSelectionRange(a, b);
    ta.scrollTop = top; ta.scrollLeft = left;
    runProblems = [];
    textChanged();
  }

  function push() {                // send my edits to everyone
    clearTimeout(timer);
    dirty = false;
    by = me();
    syncStatus();
    send({ type: "code", text: ta.value, lang: langId }).catch(() => { dirty = true; syncStatus(); sbSync.textContent = "⚠ Offline: retrying…"; });
  }
  function edited() {
    dirty = true;
    if (runProblems.length) runProblems = [];
    syncStatus();
    clearTimeout(timer);
    timer = setTimeout(push, 300);
    textChanged();
  }
  ta.addEventListener("input", edited);

  function incoming(text, l, who) {
    if (l && l !== langId) setLang(l, false);
    if (text === ta.value) { by = who || by; syncStatus(); return; }
    if (dirty) {                   // don't pull the rug out from under someone mid-typing
      remote = { text, who };
      conflictBox.replaceChildren(
        el("div", { textContent: `${who || "Someone"} changed the code while you were typing. Which version should everyone keep?` }),
        el("div", { className: "row" },
          el("button", { type: "button", textContent: "Keep mine", onclick: () => { hideConflict(); push(); } }),
          el("button", { type: "button", className: "primary", textContent: `Use ${who ? who + "'s" : "theirs"}`, onclick: () => {
            clearTimeout(timer); dirty = false; const r = remote; hideConflict(); setText(r.text); by = r.who; syncStatus();
          } })));
      conflictBox.classList.remove("hidden");
      syncStatus();
      return;
    }
    setText(text);
    by = who || by;
    syncStatus();
    if (typeof tab !== "undefined" && tab !== "code" && who && who !== me()) { missed++; badge(); }
  }
  function hideConflict() { remote = null; conflictBox.classList.add("hidden"); syncStatus(); }

  const badgeEl = document.getElementById("codeCount");
  function badge() { if (badgeEl) { badgeEl.textContent = missed ? "new" : ""; badgeEl.classList.toggle("hidden", !missed); } }

  // ======================================================================
  // syntax colouring: a small hand-written lexer per language family
  // ======================================================================
  const words = s => new Set(s.split(" "));
  const CONTROL = words("if else elif for while do switch case default break continue return try catch except finally throw raise import export from as yield await with pass goto assert match");
  const C_KW = "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while";
  const KW = {
    javascript: words("await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async get set from as"),
    python: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self print"),
    java: words("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while var record String"),
    c: words(C_KW + " #include #define #ifdef #ifndef #endif #if #else #elif #pragma #undef"),
    cpp: words(C_KW + " #include #define #ifdef #ifndef #endif #if #else #pragma alignas bool catch class constexpr delete explicit friend mutable namespace new noexcept nullptr operator private protected public template this throw try typename using virtual override final std string vector auto"),
    csharp: words("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await get set record Console"),
    go: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var string int float64 bool error byte rune"),
    rust: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while i32 i64 u32 u64 usize f64 bool str String Vec Option Some Result Ok Err"),
    ruby: words("alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield puts require attr_accessor"),
    php: words("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty extends final finally fn for foreach function global goto if implements include instanceof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while yield"),
    sql: words("select from where and or not insert into values update set delete create table drop alter add primary key foreign references join left right inner outer full on as group by order having limit offset distinct union all is like in between exists case when then else end count sum avg min max index view default unique check asc desc integer int text varchar real boolean date"),
    bash: words("if then else elif fi for while until do done case esac in function return local export echo exit read set unset shift source cd break continue printf test"),
    css: words("@media @import @keyframes @font-face @supports !important"),
  };
  const LITERALS = words("true false null undefined NaN Infinity None True False nil TRUE FALSE NULL nullptr");
  const LEXERS = {};
  function lexer(l) {
    if (LEXERS[l]) return LEXERS[l];
    const R = String.raw;
    const slashC = ["javascript", "java", "c", "cpp", "csharp", "go", "rust", "php"].includes(l);
    const com = [];
    if (slashC || l === "css" || l === "sql") com.push(R`\/\*[\s\S]*?(?:\*\/|$)`);
    if (slashC) com.push(R`\/\/.*`);
    if (["python", "ruby", "bash", "php"].includes(l)) com.push(R`#(?![!\[{]).*|^#!.*`);
    if (l === "sql") com.push(R`--.*`);
    const str = [];
    if (l === "python") str.push(R`[rbfuRBFU]{0,2}"""[\s\S]*?(?:"""|$)`, R`[rbfuRBFU]{0,2}'''[\s\S]*?(?:'''|$)`);
    str.push(R`"(?:\\.|[^"\\\n])*"?`);
    str.push(l === "rust" ? R`'(?:\\.|[^'\\\n])'` : R`'(?:\\.|[^'\\\n])*'?`);
    if (["javascript", "go", "bash"].includes(l)) str.push(R`\x60(?:\\[\s\S]|[^\x60\\])*\x60?`);
    const re = l === "javascript" ? R`\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\/\\\n])+\/[dgimsuy]*` : R`(?!)`;
    const num = l === "css" ? R`#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:%|[a-z]+)?|\.\d+(?:%|[a-z]+)?`
                            : R`\b(?:0[xX][\da-fA-F_]+|0[bBoO][\d_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[a-zA-Z]*\b`;
    const word = l === "css" ? R`@?-?[A-Za-z_][\w-]*|!important` : l === "php" || l === "bash" ? R`\$?[A-Za-z_]\w*` : R`[#@]?[A-Za-z_$][\w$]*\??`;
    return LEXERS[l] = new RegExp(`(${com.join("|") || "(?!)"})|(${str.join("|")})|(${re})|(${num})|(${word})`, "gm");
  }
  function lexCode(text, l, base, toks) {
    const rx = lexer(l), kw = KW[l] || new Set();
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(text))) {
      if (!m[0]) { rx.lastIndex++; continue; }
      const s = base + m.index, e = s + m[0].length;
      if (m[1]) toks.push([s, e, "tk-c"]);
      else if (m[2]) toks.push([s, e, "tk-s"]);
      else if (m[3]) {                       // a JS regex only where a value can start
        const before = text.slice(0, m.index).replace(/\s+$/, "");
        if (!before || /[(,=:[!&|?{};+\-*%<>~^]$|\b(?:return|typeof|case|of|in)$/.test(before)) toks.push([s, e, "tk-r"]);
        else { rx.lastIndex = m.index + 1; }
      }
      else if (m[4]) toks.push([s, e, "tk-n"]);
      else {
        const w = m[0], low = w.toLowerCase();
        const after = text.slice(m.index + w.length, m.index + w.length + 40);
        let cls = "";
        if (kw.has(w) || (l === "sql" && kw.has(low)) || (w[0] === "@" && l !== "css")) cls = l !== "css" && l !== "sql" && CONTROL.has(w) ? "tk-ctl" : "tk-k";
        else if (LITERALS.has(w)) cls = "tk-l";
        else if (l === "css") cls = /^\s*:(?!:)[^;{}]*(?:;|}|$)/.test(after) && !/^\s*:[\w-]+\s*[,{]/.test(after) ? "tk-p" : (w[0] === "@" ? "tk-k" : "");
        else if (w[0] === "$") cls = "tk-p";
        else if (/^\s*\(/.test(after)) cls = "tk-f";
        else if (/^[A-Z][a-z0-9_]/.test(w)) cls = "tk-t";
        else if (kw.has(w.replace(/^#/, "#"))) cls = "tk-k";
        if (cls) toks.push([s, e, cls]);
      }
    }
  }
  function lexHTML(text, toks) {
    const rx = /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][\w:-]*)([^>]*)>?|&[#\w]+;/g;
    let m;
    while ((m = rx.exec(text))) {
      const s = m.index;
      if (m[0].startsWith("<!--")) { toks.push([s, s + m[0].length, "tk-c"]); continue; }
      if (m[0][0] === "&") { toks.push([s, s + m[0].length, "tk-n"]); continue; }
      const name = m[1], open = m[0][1] !== "/";
      const nameEnd = s + (open ? 1 : 2) + name.length;
      toks.push([s, nameEnd, "tk-tag"]);
      const attrs = m[2] || "", aBase = nameEnd;
      const arx = /([^\s=\/>]+)(?:(\s*=\s*)("[^"]*"?|'[^']*'?|[^\s>]+))?/g;
      let a;
      while ((a = arx.exec(attrs))) {
        const as = aBase + a.index;
        toks.push([as, as + a[1].length, "tk-attr"]);
        if (a[3]) { const vs = as + a[1].length + a[2].length; toks.push([vs, vs + a[3].length, "tk-s"]); }
      }
      if (m[0].endsWith(">")) toks.push([s + m[0].length - 1, s + m[0].length, "tk-tag"]);
      const tag = name.toLowerCase();
      if (open && (tag === "script" || tag === "style") && !attrs.trim().endsWith("/")) {
        const from = s + m[0].length, close = text.toLowerCase().indexOf("</" + tag, from);
        const to = close < 0 ? text.length : close;
        lexCode(text.slice(from, to), tag === "script" ? "javascript" : "css", from, toks);
        rx.lastIndex = to;
      }
    }
  }
  function tokenize(text, l) {
    const toks = [];
    if (text.length > 400000 || l === "text") return toks;
    if (l === "html") lexHTML(text, toks); else lexCode(text, l, 0, toks);
    toks.sort((a, b) => a[0] - b[0]);
    return toks;
  }

  // Brackets: pairs for matching, colour by depth, and problems when they don't line up.
  function brackets(text, toks, l) {
    const pairs = new Map(), errs = [], colored = [];
    if (l === "text" || text.length > 400000) return { pairs, errs, colored };
    const lintable = !["html", "bash", "text"].includes(l);
    const skip = toks.filter(t => t[2] === "tk-c" || t[2] === "tk-s" || t[2] === "tk-r" || t[2] === "tk-attr");
    const stack = [];
    let ti = 0, line = 1;
    for (let i = 0; i < text.length; i++) {
      while (ti < skip.length && skip[ti][1] <= i) ti++;
      if (ti < skip.length && skip[ti][0] <= i) {
        const end = skip[ti][1];
        for (let j = i; j < end; j++) if (text.charCodeAt(j) === 10) line++;
        i = end - 1; continue;
      }
      const ch = text[i];
      if (ch === "\n") { line++; continue; }
      const o = "([{".indexOf(ch);
      if (o >= 0) { colored.push([i, i + 1, "br" + (stack.length % 3)]); stack.push([i, line, ch]); continue; }
      const c = ")]}".indexOf(ch);
      if (c < 0) continue;
      const top = stack.pop();
      if (!top) { errs.push({ pos: i, line, msg: `Extra '${ch}' with nothing to close.` }); continue; }
      if ("([{".indexOf(top[2]) !== c) {
        errs.push({ pos: i, line, msg: `'${ch}' doesn't match the '${top[2]}' opened on line ${top[1]}.` });
        stack.push(top); continue;
      }
      colored.push([i, i + 1, "br" + (stack.length % 3)]);
      pairs.set(i, top[0]); pairs.set(top[0], i);
    }
    for (const [pos, ln, ch] of stack) errs.push({ pos, line: ln, msg: `'${ch}' is never closed.` });
    return { pairs, errs: lintable ? errs.slice(0, 50) : [], colored };
  }

  // Outline: functions and classes, for the Explorer and the breadcrumbs.
  const CSTYLE = /^\s*(?:public|private|protected|static|\s)+[\w<>\[\],\s]+\s+(\w+)\s*\([^;]*$/;   // Java/C-style methods
  const PY_OUTLINE = [[/^\s*class\s+(\w+)/, "c"], [/^\s*(?:async\s+)?def\s+(\w+)/, "f"]];
  const OUTLINE = [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)/, "f"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/, "f"],
    [/^\s*(?:export\s+)?(?:abstract\s+)?(?:public\s+|private\s+)?(?:class|interface|struct|enum|trait|module|record)\s+([\w$]+)/, "c"],
    [/^\s*(?:async\s+)?def\s+(\w+)/, "f"], [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, "f"], [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/, "f"],
    [/^\s*impl(?:<[^>]*>)?\s+([\w:<>]+)/, "c"], [CSTYLE, "f"],
    [/^\s*function\s+(\w+)/, "f"], [/^\s*([\w-]+)\s*\(\)\s*\{/, "f"],
  ];
  let symbols = [], symbolAtCaret = "";
  function outline() {
    symbols = [];
    if (langId === "css") ta.value.split("\n").forEach((t, i) => { const m = t.match(/^\s*([^{}\/@][^{}]*?)\s*\{/); if (m) symbols.push({ name: m[1].slice(0, 60), kind: "v", line: i + 1 }); });
    else if (langId === "html") ta.value.split("\n").forEach((t, i) => { const m = t.match(/<(h[1-6]|title)\b[^>]*>([^<]{1,60})/i) || t.match(/<(\w+)[^>]*\sid=["']([^"']+)/); if (m) symbols.push({ name: `${m[1]}: ${m[2]}`, kind: "v", line: i + 1 }); });
    else if (langId !== "text" && langId !== "sql") ta.value.split("\n").forEach((t, i) => {
      const rules = langId === "python" ? PY_OUTLINE : OUTLINE.filter(([rx]) => rx !== CSTYLE || ["java", "c", "cpp", "csharp"].includes(langId));
      for (const [rx, kind] of rules) { const m = t.match(rx); if (m && !/^(if|for|while|switch|return|catch|else)$/.test(m[1])) { symbols.push({ name: m[1], kind, line: i + 1 }); break; } }
    });
    symbols = symbols.slice(0, 300);
    outlineBox.replaceChildren(...(symbols.length ? symbols.map(s => el("div", { className: "item", title: `Line ${s.line}`, onclick: () => revealLine(s.line) },
      el("span", { className: "sym " + s.kind, textContent: s.kind === "f" ? "ƒ" : s.kind === "c" ? "◆" : "#" }),
      el("span", { className: "nm", textContent: s.name }), el("span", { className: "dim", textContent: String(s.line) })))
      : [el("div", { className: "empty-note", textContent: "No functions or classes found." })]));
  }

  // ======================================================================
  // rendering: colours, marks (matching brackets, find hits, squiggles),
  // line numbers, current line, minimap
  // ======================================================================
  let toks = [], pairs = new Map(), lint = [], runProblems = [], tokFor = null, lineCount = 1, rafId = 0, gutKey = "";
  const find = { hits: [], cur: -1, matchCase: false };
  const schedule = () => { if (!rafId) rafId = requestAnimationFrame(render); };
  function textChanged() { tokFor = null; if (!findBox.classList.contains("hidden")) doFind(false); schedule(); }

  function analyse() {
    const key = langId + "\u0000" + ta.value;
    if (key === tokFor) return;
    tokFor = key;
    const text = ta.value;
    lineCount = 1; for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineCount++;
    const base = tokenize(text, langId);
    const b = brackets(text, base, langId);
    pairs = b.pairs; lint = b.errs;
    toks = base.concat(b.colored).sort((x, y) => x[0] - y[0]);
    updateProblems(); outline();
    if (searchBox.value && prefs.view === "search") renderSearch();
  }
  function lineStart(text, n) { let p = 0; for (let i = 1; i < n && p >= 0; i++) p = text.indexOf("\n", p) + 1 || -1; return p < 0 ? text.length : p; }
  function lineOf(text, pos) { let n = 1; for (let i = text.indexOf("\n"); i >= 0 && i < pos; i = text.indexOf("\n", i + 1)) n++; return n; }

  function paint(text, toks, marks) {
    const cuts = [...new Set(marks.flatMap(m => [m[0], m[1]]))].sort((a, b) => a - b);
    let ci = 0, html = "";
    const piece = (s, e, cls) => {
      if (s >= e) return;
      let c = cls;
      for (const m of marks) { if (m[0] > s) break; if (m[1] >= e) c += " " + m[2]; }
      const t = esc(text.slice(s, e));
      c = c.trim();
      html += c ? `<span class="${c}">${t}</span>` : t;
    };
    const seg = (s, e, cls) => {
      while (ci < cuts.length && cuts[ci] <= s) ci++;
      let a = s;
      for (let j = ci; j < cuts.length && cuts[j] < e; j++) { piece(a, cuts[j], cls); a = cuts[j]; }
      piece(a, e, cls);
    };
    let pos = 0;
    for (const [s, e, cls] of toks) { if (s < pos) continue; seg(pos, s, ""); seg(s, e, cls); pos = e; }
    seg(pos, text.length, "");
    return html + "\n";
  }

  function render() {
    rafId = 0;
    analyse();
    const text = ta.value, marks = [];
    if (document.activeElement === ta && ta.selectionStart === ta.selectionEnd) {
      const p = ta.selectionStart;
      for (const q of [p - 1, p]) if (pairs.has(q)) { const r = pairs.get(q); marks.push([q, q + 1, "mb"], [r, r + 1, "mb"]); break; }
    }
    for (const e of lint) marks.push([e.pos, e.pos + 1, "sq"]);
    for (const r of runProblems) if (r.line > 0 && r.line <= lineCount) {
      const a = lineStart(text, r.line), nl = text.indexOf("\n", a), b = nl < 0 ? text.length : nl;
      const s = a + (text.slice(a, b).match(/^\s*/)[0].length);
      if (b > s) marks.push([s, b, "sq"]);
    }
    find.hits.forEach(([a, b], i) => marks.push([a, b, i === find.cur ? "fm cur" : "fm"]));
    marks.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    const html = paint(text, toks, marks);
    hl.innerHTML = html;
    if (prefs.mini && lineCount <= 4000) miniPre.innerHTML = html;
    caretUpdate(); gutterUpdate(); syncScroll();
  }

  function gutterUpdate() {
    const cur = caretLine;
    const errs = new Set([...lint.map(e => e.line), ...runProblems.map(r => r.line)]);
    const key = `${lineCount}|${cur}|${[...errs].join(",")}`;
    if (key === gutKey) return;
    gutKey = key;
    let h = "";
    for (let i = 1; i <= lineCount; i++) h += `<div class="ln${i === cur ? " on" : ""}${errs.has(i) ? " err" : ""}">${i}</div>`;
    gutIn.innerHTML = h;
    gut.style.minWidth = `calc(${Math.max(String(lineCount).length, 2)}ch + 28px)`;
  }

  let caretLine = 1;
  function caretUpdate() {
    const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    caretLine = lineOf(v, a);
    const col = a - (v.lastIndexOf("\n", a - 1) + 1) + 1;
    curLine.style.top = `${4 + (caretLine - 1) * LH}px`;
    curLine.classList.toggle("hidden", a !== b);
    sbPos.textContent = `Ln ${caretLine}, Col ${col}` + (b > a ? ` (${b - a} selected)` : "");
    let sym = "";
    for (const s of symbols) { if (s.line <= caretLine) sym = s.name; else break; }
    if (sym !== symbolAtCaret) { symbolAtCaret = sym; updateCrumbs(); }
  }

  const MS = 0.15;
  let miniShift = 0;
  function syncScroll() {
    layer.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    gutIn.style.transform = `translateY(${-ta.scrollTop}px)`;
    if (!prefs.mini || mini.offsetParent === null) return;
    const scaled = (lineCount * LH + 8) * MS, mapH = mini.clientHeight;
    const maxScroll = Math.max(1, ta.scrollHeight - ta.clientHeight);
    miniShift = scaled > mapH ? (ta.scrollTop / maxScroll) * (scaled - mapH) : 0;
    miniPre.style.transform = `translateY(${-miniShift}px) scale(${MS})`;
    miniView.style.top = `${ta.scrollTop * MS - miniShift}px`;
    miniView.style.height = `${Math.max(10, ta.clientHeight * MS)}px`;
  }
  ta.addEventListener("scroll", syncScroll);
  mini.addEventListener("pointerdown", e => {
    e.preventDefault();
    const go = ev => {
      const y = ev.clientY - mini.getBoundingClientRect().top;
      ta.scrollTop = (y + miniShift) / MS - ta.clientHeight / 2;
    };
    go(e); mini.setPointerCapture(e.pointerId);
    mini.onpointermove = go; mini.onpointerup = () => { mini.onpointermove = null; };
  });
  for (const ev of ["keyup", "click", "focus", "blur"]) ta.addEventListener(ev, schedule);
  document.addEventListener("selectionchange", () => { if (document.activeElement === ta) schedule(); });

  function measure() {
    LH = Math.round(prefs.fs * 1.5);
    const c = document.createElement("canvas").getContext("2d");
    c.font = `${prefs.fs}px ${MONO}`;
    CW = c.measureText("MMMMMMMMMM").width / 10 || 8;
  }
  function reveal(pos, len = 0) {
    const v = ta.value, line = lineOf(v, pos), col = pos - (v.lastIndexOf("\n", pos - 1) + 1);
    const top = 4 + (line - 1) * LH;
    if (top < ta.scrollTop + LH || top + 2 * LH > ta.scrollTop + ta.clientHeight) ta.scrollTop = top - ta.clientHeight / 3;
    const x = 6 + col * CW, x2 = x + len * CW;
    if (x < ta.scrollLeft + 20 || x2 > ta.scrollLeft + ta.clientWidth - 40) ta.scrollLeft = Math.max(0, x - ta.clientWidth / 3);
  }
  function revealLine(n, col = 0, len = 0) {
    closePeek();
    const v = ta.value, a = Math.min(lineStart(v, Math.max(1, n)) + col, v.length);
    ta.focus(); ta.setSelectionRange(a, a + len); reveal(a, len); schedule();
  }

  // ======================================================================
  // editing commands
  // ======================================================================
  function insert(text) {
    ta.focus();
    if (!document.execCommand || !document.execCommand("insertText", false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  function lineBlock() {             // whole lines covered by the selection: [start, end) without the last \n
    const v = ta.value, a = ta.selectionStart;
    let b = ta.selectionEnd;
    if (b > a && v[b - 1] === "\n") b--;
    const s = v.lastIndexOf("\n", a - 1) + 1, nl = v.indexOf("\n", b), e = nl < 0 ? v.length : nl;
    return [s, e];
  }
  function replaceRange(s, e, text, selA, selB) {
    ta.focus(); ta.setSelectionRange(s, e); insert(text); ta.setSelectionRange(selA, selB);
  }
  const COMMENT = { javascript: "//", java: "//", c: "//", cpp: "//", csharp: "//", go: "//", rust: "//", php: "//", python: "#", ruby: "#", bash: "#", sql: "--" };
  function toggleComment() {
    const v = ta.value, [s, e] = lineBlock(), block = v.slice(s, e), rows = block.split("\n");
    const a = ta.selectionStart, b = ta.selectionEnd;
    let out;
    if (langId === "html" || langId === "css") {
      const [o, c] = langId === "html" ? ["<!-- ", " -->"] : ["/* ", " */"];
      const on = rows.every(r => !r.trim() || (r.trim().startsWith(o.trim()) && r.trim().endsWith(c.trim())));
      out = rows.map(r => !r.trim() ? r : on ? r.replace(o.trim() + " ", "").replace(o.trim(), "").replace(" " + c.trim(), "").replace(c.trim(), "")
                                              : r.replace(/^(\s*)/, `$1${o}`) + c).join("\n");
    } else {
      const tok = COMMENT[langId] || "//";
      const filled = rows.filter(r => r.trim());
      const on = filled.length && filled.every(r => r.trim().startsWith(tok));
      const ind = Math.min(...filled.map(r => r.match(/^\s*/)[0].length));
      out = rows.map(r => !r.trim() ? r : on ? r.replace(new RegExp(`^(\\s*)${tok.replace(/[/\-]/g, "\\$&")} ?`), "$1") : r.slice(0, ind) + tok + " " + r.slice(ind)).join("\n");
    }
    const d = out.length - block.length;
    replaceRange(s, e, out, a === b ? Math.max(s, a + (rows.length === 1 ? d : 0)) : s, a === b ? Math.max(s, a + (rows.length === 1 ? d : 0)) : s + out.length);
  }
  function moveLine(dir) {
    const v = ta.value, [s, e] = lineBlock(), a = ta.selectionStart, b = ta.selectionEnd, block = v.slice(s, e);
    if (dir < 0) {
      if (s === 0) return;
      const p = v.lastIndexOf("\n", s - 2) + 1, prev = v.slice(p, s - 1);
      replaceRange(p, e, block + "\n" + prev, a - prev.length - 1, b - prev.length - 1);
    } else {
      if (e >= v.length) return;
      const nl = v.indexOf("\n", e + 1), ne = nl < 0 ? v.length : nl, next = v.slice(e + 1, ne);
      replaceRange(s, ne, next + "\n" + block, a + next.length + 1, b + next.length + 1);
    }
  }
  function copyLine(dir) {
    const v = ta.value, [s, e] = lineBlock(), a = ta.selectionStart, b = ta.selectionEnd, block = v.slice(s, e);
    replaceRange(e, e, "\n" + block, dir > 0 ? a + block.length + 1 : a, dir > 0 ? b + block.length + 1 : b);
  }
  function deleteLine() {
    const v = ta.value, [s, e] = lineBlock();
    if (e < v.length) replaceRange(s, e + 1, "", s, s);
    else replaceRange(Math.max(0, s - 1), e, "", Math.max(0, s - 1), Math.max(0, s - 1));
  }
  function indentLines(dir) {
    const v = ta.value, [s, e] = lineBlock(), block = v.slice(s, e);
    const out = block.split("\n").map(l => dir < 0 ? l.replace(/^( {1,2}|\t)/, "") : "  " + l).join("\n");
    replaceRange(s, e, out, s, s + out.length);
  }
  function selectNext() {
    const v = ta.value;
    let a = ta.selectionStart, b = ta.selectionEnd;
    if (a === b) {                   // nothing selected: select the word at the cursor
      while (a > 0 && /[\w$]/.test(v[a - 1])) a--;
      while (b < v.length && /[\w$]/.test(v[b])) b++;
      if (a === b) return;
      ta.setSelectionRange(a, b); reveal(a, b - a); return;
    }
    const word = v.slice(a, b);
    let i = v.indexOf(word, b);
    if (i < 0) i = v.indexOf(word);
    if (i >= 0) { ta.setSelectionRange(i, i + word.length); reveal(i, word.length); schedule(); }
  }
  function zoom(d) { prefs.fs = d ? Math.min(28, Math.max(9, prefs.fs + d)) : 13.5; savePrefs(); layout(); flash(`Editor font: ${prefs.fs}px`, 1200); }

  // ---------- typing helpers: indent, auto-close brackets and quotes ----------
  const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
  let skipTab = false;             // Esc, then Tab, moves focus out instead of indenting
  ta.addEventListener("keydown", e => {
    const ctrl = e.ctrlKey || e.metaKey, k = e.key;
    // editor shortcuts
    if (ctrl && !e.shiftKey && !e.altKey && (k === "/" || e.code === "Slash")) { e.preventDefault(); return toggleComment(); }
    if (e.altKey && !ctrl && (k === "ArrowUp" || k === "ArrowDown")) { e.preventDefault(); return e.shiftKey ? copyLine(k === "ArrowDown" ? 1 : -1) : moveLine(k === "ArrowDown" ? 1 : -1); }
    if (ctrl && e.shiftKey && (k === "K" || k === "k")) { e.preventDefault(); return deleteLine(); }
    if (ctrl && !e.shiftKey && (k === "d" || k === "D")) { e.preventDefault(); return selectNext(); }
    if (ctrl && (k === "]" || k === "[")) { e.preventDefault(); return indentLines(k === "]" ? 1 : -1); }
    if (ctrl && (k === "=" || k === "+")) { e.preventDefault(); return zoom(1); }
    if (ctrl && k === "-") { e.preventDefault(); return zoom(-1); }
    if (ctrl && k === "0") { e.preventDefault(); return zoom(0); }
    if (ctrl && k === "Enter") { e.preventDefault(); return run(); }

    if (k === "Escape") { skipTab = true; return; }
    if (k === "Tab" && !ctrl && !e.altKey) {
      if (skipTab) { skipTab = false; return; }
      e.preventDefault();
      if (ta.selectionStart === ta.selectionEnd && !e.shiftKey) return insert("  ");
      return indentLines(e.shiftKey ? -1 : 1);
    }
    skipTab = false;
    if (ctrl || e.altKey || e.isComposing) return;
    const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd, next = v[a] || "", prev = v[a - 1] || "";
    if (k === "Enter" && !e.shiftKey && a === b) {
      const line = v.slice(v.lastIndexOf("\n", a - 1) + 1, a);
      let pad = line.match(/^[ \t]*/)[0];
      const opens = /[{(\[:]\s*$/.test(line) || (langId === "html" && /<([a-z][\w-]*)(?:\s[^>]*)?>\s*$/i.test(line) && !/<\/|\/>\s*$/.test(line));
      const closes = /^[\])}]/.test(v.slice(a)) || (langId === "html" && /^<\//.test(v.slice(a)));
      if (opens) pad += "  ";
      if (!pad) return;
      e.preventDefault();
      insert("\n" + pad);
      if (opens && closes) {                                          // put the closing bracket on its own line
        const at = ta.selectionStart;
        insert("\n" + pad.slice(0, -2));
        ta.setSelectionRange(at, at);
      }
      return;
    }
    if (langId === "text") return;
    if (k === "Backspace" && a === b && PAIRS[prev] && PAIRS[prev] === next) {   // delete an empty pair
      e.preventDefault(); ta.setSelectionRange(a - 1, a + 1); return insert("");
    }
    if ((k === ")" || k === "]" || k === "}" || k === '"' || k === "'" || k === "`") && a === b && next === k) {
      e.preventDefault(); ta.setSelectionRange(a + 1, a + 1); return schedule();   // type over the closer
    }
    if (PAIRS[k]) {
      const quote = k === '"' || k === "'" || k === "`";
      if (a !== b) {                 // wrap the selection
        e.preventDefault(); const sel = v.slice(a, b); insert(k + sel + PAIRS[k]); ta.setSelectionRange(a + 1, b + 1); return;
      }
      if (quote && (/[\w$\\]/.test(prev) || (k === "'" && langId === "html"))) return;
      if (next && !/[\s)\]};,:]/.test(next)) return;
      e.preventDefault(); insert(k + PAIRS[k]); ta.setSelectionRange(a + 1, a + 1);
    }
  });

  // ---------- find and replace ----------
  function openFind(withReplace) {
    closePeek();
    findBox.classList.remove("hidden");
    replRow.classList.toggle("hidden", !withReplace);
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes("\n")) findIn.value = sel;
    (withReplace && findIn.value ? replIn : findIn).focus();
    findIn.select();
    doFind(true);
  }
  function doFind(jump) {
    const q = findIn.value, v = ta.value;
    find.hits = [];
    if (q) {
      const T = find.matchCase ? v : v.toLowerCase(), Q = find.matchCase ? q : q.toLowerCase();
      for (let i = T.indexOf(Q); i >= 0 && find.hits.length < 5000; i = T.indexOf(Q, i + Q.length)) find.hits.push([i, i + q.length]);
    }
    if (!find.hits.length) find.cur = -1;
    else if (jump || find.cur < 0 || find.cur >= find.hits.length) {
      const from = ta.selectionStart, i = find.hits.findIndex(h => h[0] >= from);
      find.cur = i < 0 ? 0 : i;
    }
    findCount.textContent = find.hits.length ? `${find.cur + 1} of ${find.hits.length}${find.hits.length >= 5000 ? "+" : ""}` : q ? "No results" : "";
    if (jump && find.cur >= 0) reveal(find.hits[find.cur][0], q.length);
    schedule();
  }
  function step(d) {
    const n = find.hits.length;
    if (!n) return;
    find.cur = (find.cur + d + n) % n;
    const [a, b] = find.hits[find.cur];
    ta.setSelectionRange(a, b);
    reveal(a, b - a);
    findCount.textContent = `${find.cur + 1} of ${n}`;
    schedule();
  }
  function closeFind() {
    const h = find.hits[find.cur];
    findBox.classList.add("hidden");
    find.hits = []; find.cur = -1;
    ta.focus();
    if (h) ta.setSelectionRange(h[0], h[1]);
    schedule();
  }
  function replaceOne() {
    const h = find.hits[find.cur];
    if (!h) return;
    ta.setSelectionRange(h[0], h[1]); insert(replIn.value);
    doFind(false); replIn.focus();
    if (find.hits.length) { const i = find.hits.findIndex(x => x[0] >= h[0] + replIn.value.length); find.cur = i < 0 ? 0 : i; step(0); }
  }
  function replaceAll() {
    if (!find.hits.length) return;
    const v = ta.value, n = find.hits.length;
    let out = "", p = 0;
    for (const [a, b] of find.hits) { out += v.slice(p, a) + replIn.value; p = b; }
    out += v.slice(p);
    ta.focus(); ta.setSelectionRange(0, v.length); insert(out);
    doFind(false); replIn.focus();
    flash(`Replaced ${n} occurrence${n === 1 ? "" : "s"}.`);
  }
  findIn.addEventListener("input", () => doFind(true));
  for (const inp of [findIn, replIn]) inp.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
    else if (e.key === "Enter" && inp === replIn) { e.preventDefault(); (e.ctrlKey || e.metaKey) && e.altKey ? replaceAll() : replaceOne(); }
    else if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === "F3") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  });

  // ---------- snippet preview (a read-only tab) ----------
  let peeked = null;
  function peek(sn, line) {
    peeked = sn;
    peekName.textContent = sn.title;
    peekTab.classList.remove("hidden");
    const l = LANGS.find(x => x[0] === sn.lang) || LANGS[LANGS.length - 1];
    const mine = typeof S !== "undefined" && S && sn.owner === S.id;
    peekHead.replaceChildren(el("b", { textContent: sn.title }),
      el("span", { textContent: `${l[1].replace(" (runs here)", "")} · pinned by ${mine ? "you" : sn.ownerName} · read-only` }),
      el("span", { className: "grow" }),
      ib("↪ Open in shared editor", "Replace the shared file with this snippet (for everyone)", () => open(sn.text, sn.lang)),
      ib("Copy", "Copy this snippet", async ev => {
        try { await navigator.clipboard.writeText(sn.text); ev.target.textContent = "✓ Copied"; } catch { ev.target.textContent = "Couldn't copy"; }
      }),
      ...((mine || (typeof amOwner === "function" && amOwner())) ? [ib("Delete", "Delete for everyone", () => deleteSnippet(sn))] : []));
    const t = tokenize(sn.text, sn.lang), b = brackets(sn.text, t, sn.lang);
    const html = paint(sn.text, t.concat(b.colored).sort((x, y) => x[0] - y[0]), []);
    const pre = el("pre", { className: "hl" });
    pre.innerHTML = html.replace(/\n$/, "").split("\n").map((r, i) => `<span class="row${i + 1 === line ? " on" : ""}">${r || " "}</span>`).join("\n");
    peekBody.replaceChildren(pre);
    showPeek();
    if (line) setTimeout(() => { peekBody.scrollTop = Math.max(0, (line - 4) * LH); }, 0);
    renderSnippets();
  }
  function showPeek() {
    if (!peeked) return;
    peekView.classList.remove("hidden"); peekTab.classList.add("on"); mainTab.classList.remove("on");
  }
  function closePeek(forget) {
    peekView.classList.add("hidden"); peekTab.classList.remove("on"); mainTab.classList.add("on");
    if (forget) { peeked = null; peekTab.classList.add("hidden"); renderSnippets(); }
  }

  // ======================================================================
  // running (unchanged sandboxing: a Worker for JS, a sandboxed frame for HTML)
  // ======================================================================
  let worker = null, workerUrl = null, hardTimer = null, idleTimer = null, frame = null, running = false;

  function updateButtons() {
    const ok = RUNNABLE.has(langId) || (IN_TERMINAL.has(langId) && !!window.crewTerminal);
    runBtn.disabled = runBig.disabled = !ok;
    stopBtn.disabled = !running;
    runBtn.title = ok ? "Run on your computer (F5 or Ctrl+Enter)" : "Run works for JavaScript and HTML.";
    runBig.textContent = running ? "⟳  Run again" : "▶  Run " + fileName();
    runNote.textContent = ok ? `Runs ${fileName()} on your own computer, in a sandbox.`
      : `${label()[1]} can't run in the browser. Copy or download it and run it where you normally do.`;
  }
  function out(text, cls = "") {
    if (lines.firstChild?.className === "empty") lines.replaceChildren();
    const nearEnd = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 40;
    lines.append(el("div", { className: cls, textContent: text }));
    if (nearEnd) lines.scrollTop = lines.scrollHeight;
  }
  function clearOut() {
    lines.replaceChildren(el("div", { className: "empty", textContent: "Output from your program shows up here. Press F5 to run." }));
  }
  function explain(msg, line) {
    out((line > 0 ? `Line ${line}: ` : "") + msg, "error");
    const h = hintFor(msg);
    if (h) out("Hint: " + h, "hint");
    runProblems.push({ sev: "error", line: line > 0 ? line : 0, msg: msg + (h ? "  Hint: " + h : "") });
    updateProblems(); gutKey = ""; schedule();
  }
  function finish(text) {
    clearTimeout(hardTimer); clearTimeout(idleTimer);
    if (worker) { worker.terminate(); worker = null; }
    if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
    running = false; state.textContent = text || ""; updateButtons();
  }
  function stop(why) {
    if (frame) { window.removeEventListener("message", onFrame); frame.remove(); frame = null; }
    finish(why || "Stopped.");
  }

  // Runs inside the worker before your code. It's squashed onto one line (no
  // comments or reliance on newlines) so your line numbers stay correct.
  function boot() {
    const post = self.postMessage.bind(self);
    const show = v => {
      if (typeof v === "string") return v;
      if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
      if (typeof v === "bigint") return v + "n";
      if (v instanceof Error) return String(v);
      try { const s = JSON.stringify(v, (k, x) => typeof x === "bigint" ? x + "n" : x, 2); return s === undefined ? String(v) : s; }
      catch (e) { return String(v); }
    };
    ["log", "info", "debug", "warn", "error"].forEach(k => {
      console[k] = (...a) => post({ k: k === "warn" || k === "error" ? k : "log", text: a.map(show).join(" ") });
    });
    self.addEventListener("unhandledrejection", e => post({ k: "error", text: "Unhandled error: " + ((e.reason && e.reason.message) || e.reason) }));
    self.fetch = self.XMLHttpRequest = self.WebSocket = self.EventSource = self.importScripts = undefined;
  }
  const BOOT = "(" + boot.toString().replace(/\n\s*/g, " ") + ")();";

  function runJS(code) {
    workerUrl = URL.createObjectURL(new Blob([BOOT + code + "\n;self.postMessage({k:'done'});"], { type: "text/javascript" }));
    try { worker = new Worker(workerUrl); } catch (e) { out(String(e), "error"); return finish("Couldn't start."); }
    hardTimer = setTimeout(() => { out(`Stopped: it ran for more than ${RUN_MS / 1000} seconds. Is there a loop that never ends?`, "error"); finish("Stopped."); }, RUN_MS);
    worker.onmessage = e => {
      const m = e.data || {};
      if (m.k === "done") { state.textContent = "Finished. Waiting for any timers…"; clearTimeout(idleTimer); idleTimer = setTimeout(() => finish("Finished."), AFTER_MS); return; }
      out(m.text, m.k === "log" ? "" : m.k);
      if (m.k === "error") { const h = hintFor(m.text); if (h) out("Hint: " + h, "hint"); }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = setTimeout(() => finish("Finished."), AFTER_MS); }
    };
    worker.onerror = e => { e.preventDefault(); explain(e.message.replace(/^Uncaught /, ""), e.lineno); finish("Stopped by an error."); };
  }

  // The page shows in a frame with no access to CREW or the internet. The script
  // below is added to it so console.log and errors in the page show in Output.
  // (All on one line, so line numbers in errors match your code.)
  const FRAME_SHIM = [
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:"><script>`,
    `(function(){var p=function(k,t,l){parent.postMessage({crew:1,k:k,text:t,line:l},"*")};`,
    `var s=function(v){if(typeof v==="string")return v;try{var j=JSON.stringify(v,null,2);return j===undefined?String(v):j}catch(e){return String(v)}};`,
    `["log","info","debug","warn","error"].forEach(function(k){console[k]=function(){p(k==="warn"||k==="error"?k:"log",[].map.call(arguments,s).join(" "))}});`,
    `window.addEventListener("error",function(e){p("error",String(e.message).replace(/^Uncaught /,""),e.lineno)});`,
    `window.addEventListener("unhandledrejection",function(e){p("error","Unhandled error: "+((e.reason&&e.reason.message)||e.reason))})})();`,
    `<\/script>`].join("");
  function onFrame(e) {
    if (!frame || e.source !== frame.contentWindow || !e.data || e.data.crew !== 1) return;
    if (e.data.k === "error") explain(e.data.text, e.data.line);
    else out(e.data.text, e.data.k === "log" ? "" : e.data.k);
  }
  function runHTML(code) {
    frame = el("iframe", { title: "Result of your HTML page" });
    frame.setAttribute("sandbox", "allow-scripts");        // no same-origin: it can't reach CREW
    frame.srcdoc = FRAME_SHIM + code;
    window.addEventListener("message", onFrame);
    frameBox.replaceChildren(frame);
    showPanel("preview");
    running = false; state.textContent = "Page is shown in Preview."; updateButtons();
  }

  function run() {
    if (!RUNNABLE.has(langId) && !IN_TERMINAL.has(langId)) return flash(`${label()[1]} can't run in the browser. Download it and run it on your computer.`);
    if (by && by !== me() && confirmed !== ta.value &&
        !confirm(`${by} wrote the latest version of this code.\n\nIt will run in a sandbox on your computer: it can't use the internet or touch your files. Run it?`)) return;
    confirmed = ta.value;
    if (IN_TERMINAL.has(langId)) {             // like VS Code's "Run Python File": it runs in the terminal panel
      showPanel("terminal");
      setTimeout(() => { if (!window.crewTerminal?.runLine("run")) flash("The terminal is busy. Click in it and press Ctrl+C first."); }, 60);
      return;
    }
    stop("");
    runProblems = []; updateProblems(); gutKey = ""; schedule();
    clearOut(); lines.replaceChildren();
    out(`Running ${fileName()}…`, "hint");
    if (langId === "html") return runHTML(ta.value);
    showPanel("output");
    running = true; state.textContent = "Running…"; updateButtons();
    runJS(ta.value);
  }

  function updateProblems() {
    const all = [...lint.map(e => ({ sev: "error", line: e.line, msg: e.msg, src: "brackets" })),
                 ...runProblems.map(r => ({ ...r, src: "run" }))];
    probList.replaceChildren(...(all.length ? all.map(p => el("div", { className: "prob", onclick: () => p.line && revealLine(p.line) },
      el("span", { className: p.sev === "error" ? "perr" : "pwarn", textContent: p.sev === "error" ? "⊗" : "⚠" }),
      el("span", { textContent: p.msg }), el("span", { className: "dim", textContent: `${p.src}${p.line ? ` [Ln ${p.line}]` : ""}` })))
      : [el("div", { className: "empty", textContent: "No problems found in the code." })]));
    const ne = all.filter(p => p.sev === "error").length;
    sbProb.textContent = `⊗ ${ne}  ⚠ ${all.length - ne}`;
    probCount.textContent = all.length || "";
    probCount.classList.toggle("hidden", !all.length);
  }

  // ======================================================================
  // file actions
  // ======================================================================
  async function copyAll() {
    try { await navigator.clipboard.writeText(ta.value); flash("Copied all the code."); }
    catch { ta.focus(); ta.select(); flash("Press Ctrl+C to copy."); }
  }
  function download() {
    const a = el("a", { href: URL.createObjectURL(new Blob([ta.value], { type: "text/plain" })), download: fileName() });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function sendToChat() {
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const code = (sel.trim() ? sel : ta.value).replace(/\s+$/, "");
    if (!code.trim()) return flash("There's no code to send yet.");
    const text = "```" + langId + "\n" + code + "\n```";
    if (text.length > 3900) return flash("That's too long for chat. Pin it as a snippet instead.");
    try { await send({ type: "chat", text: typeof crewE2E !== "undefined" ? await crewE2E.encryptText(text, "chat") : text }); flash(`Sent ${sel.trim() ? "the selected code" : "the code"} to chat.`); }
    catch (e) { flash("Not sent: " + e.message); }
  }
  async function shareSnippet() {
    if (!ta.value.trim()) return flash("There's no code to pin yet.");
    const first = (ta.value.split("\n").find(l => l.trim()) || "").replace(/^\s*(\/\/|#|--|<!--)\s*/, "").slice(0, 50);
    const title = prompt("Name this snippet:", first);
    if (title === null) return;
    try { await send({ type: "snippet_add", title, lang: langId, text: ta.value }); flash("Pinned. It's in the Explorer under Pinned snippets."); }
    catch (e) { flash("Not pinned: " + e.message); }
  }
  async function deleteSnippet(sn) {
    if (!confirm(`Delete "${sn.title}" for everyone?`)) return;
    try { await send({ type: "snippet_delete", id: sn.id }); if (peeked && peeked.id === sn.id) closePeek(true); } catch (x) { flash(x.message); }
  }
  function loadExample(k) {
    const ex = EXAMPLES[k];
    if (!ex || !ex[1]) return;
    if (ta.value.trim() && ta.value !== ex[2] && !confirm("This replaces the shared code for everyone in the group. Continue?")) return;
    closePeek(); setLang(ex[1], false); setText(ex[2]); push(); ta.focus();
  }
  function toggleFull() {
    document.body.classList.toggle("ide-full");
    fullBtn.classList.toggle("on", document.body.classList.contains("ide-full"));
    fit(); schedule();
  }

  // ---------- pinned snippets in the Explorer ----------
  function renderSnippets() {
    secSnips.firstChild.textContent = `Pinned snippets${snippets.length ? ` (${snippets.length})` : ""}`;
    if (!snippets.length) return snipBox.replaceChildren(el("div", { className: "empty-note", textContent: "Nothing pinned yet. Use the pin button above the editor to keep a copy of the code." }));
    snipBox.replaceChildren(...snippets.slice().sort((a, b) => b.ts - a.ts).map(sn => {
      const mine = typeof S !== "undefined" && S && sn.owner === S.id;
      const acts = el("span", { className: "acts" },
        ib("↪", "Open in the shared editor", ev => { ev.stopPropagation(); open(sn.text, sn.lang); }),
        ibi(ICON.copy, "Copy", async ev => { ev.stopPropagation(); try { await navigator.clipboard.writeText(sn.text); flash("Copied the snippet."); } catch { flash("Couldn't copy."); } }));
      if (mine || (typeof amOwner === "function" && amOwner())) acts.append(ibi(ICON.trash, "Delete for everyone", ev => { ev.stopPropagation(); deleteSnippet(sn); }));
      const time = new Date(sn.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return el("div", { className: "item" + (peeked && peeked.id === sn.id ? " on" : ""), title: `${sn.title}\nby ${mine ? "you" : sn.ownerName} at ${time}`, onclick: () => peek(sn) },
        langTag(sn.lang), el("span", { className: "nm", textContent: sn.title }), acts);
    }));
  }

  // Put code in the shared editor (used by snippets and chat code blocks).
  function open(text, l) {
    if (ta.value.trim() && ta.value !== text && !confirm("This replaces the shared code for everyone in the group. Continue?")) return;
    const target = LANGS.some(x => x[0] === l) ? l : (l ? "text" : langId);
    closePeek(); setLang(target, false); setText(text); push();
    document.querySelector('.tabs button[data-tab="code"]')?.click();
    ta.focus();
  }

  // ======================================================================
  // command palette (Ctrl+Shift+P / F1), quick open (Ctrl+P), go to line (Ctrl+G)
  // ======================================================================
  const COMMANDS = [
    ["Run: Start", "F5", () => run()], ["Run: Stop", "Shift+F5", () => { out("Stopped.", "warn"); stop("Stopped."); }],
    ["Find", "Ctrl+F", () => openFind(false)], ["Replace", "Ctrl+H", () => openFind(true)],
    ["Go to Line…", "Ctrl+G", () => palette("goto")], ["Go to File or Snippet…", "Ctrl+P", () => palette("quick")],
    ["Toggle Line Comment", "Ctrl+/", () => toggleComment()], ["Move Line Up", "Alt+↑", () => moveLine(-1)], ["Move Line Down", "Alt+↓", () => moveLine(1)],
    ["Copy Line Down", "Shift+Alt+↓", () => copyLine(1)], ["Copy Line Up", "Shift+Alt+↑", () => copyLine(-1)], ["Delete Line", "Ctrl+Shift+K", () => deleteLine()],
    ["Indent Line", "Ctrl+]", () => indentLines(1)], ["Outdent Line", "Ctrl+[", () => indentLines(-1)], ["Select Next Occurrence", "Ctrl+D", () => selectNext()],
    ["Change Language Mode", "", () => palette("lang")], ["Open Example…", "", () => palette("example")],
    ["Pin Code as Snippet", "", () => shareSnippet()], ["Send Code to Chat", "", () => sendToChat()],
    ["Copy All Code", "", () => copyAll()], ["Download File", "Ctrl+S", () => download()],
    ["View: Toggle Side Bar", "Ctrl+B", () => { prefs.side = !prefs.side; savePrefs(); layout(); }],
    ["View: Toggle Panel", "Ctrl+J", () => { prefs.panel = !prefs.panel; savePrefs(); layout(); }],
    ["View: Show Explorer", "Ctrl+Shift+E", () => showView("explorer")], ["View: Show Search", "Ctrl+Shift+F", () => showView("search")],
    ["View: Show Problems", "Ctrl+Shift+M", () => showPanel("problems")], ["View: Show Output", "", () => showPanel("output")],
    ["View: Toggle Terminal", "Ctrl+`", () => toggleTerminal()], ["Terminal: Run Code in Terminal", "", () => { showPanel("terminal"); setTimeout(() => window.crewTerminal?.runLine("run"), 50); }],
    ["Terminal: Clear", "", () => { showPanel("terminal"); window.crewTerminal?.clear(); }],
    ["View: Toggle Minimap", "", () => { prefs.mini = !prefs.mini; savePrefs(); layout(); }],
    ["View: Toggle Full-Window Editor", "", () => toggleFull()],
    ["View: Toggle Light/Dark Editor Theme", "", () => { prefs.light = !prefs.light; savePrefs(); layout(); }],
    ["View: Bigger Editor Font", "Ctrl+=", () => zoom(1)], ["View: Smaller Editor Font", "Ctrl+-", () => zoom(-1)], ["View: Reset Editor Font", "Ctrl+0", () => zoom(0)],
    ["Output: Clear", "", () => clearOut()], ["Go to Group Chat", "", () => document.querySelector('.tabs button[data-tab="chat"]')?.click()],
    ["Open Claude Code", "", () => document.getElementById("claudeTab")?.click(), () => !document.getElementById("claudeTab")?.classList.contains("hidden")],
    ["Help: How This Works", "", () => showView("run")],
  ];
  let palMode = "cmd", palItems = [], palSel = 0, palReturn = null;

  function fuzzy(text, q) {        // subsequence match: [score, matched indexes] or null
    if (!q) return [0, []];
    const t = text.toLowerCase(), idx = [];
    let j = 0, score = 0, last = -2;
    for (let i = 0; i < t.length && j < q.length; i++) if (t[i] === q[j]) {
      score += (i === last + 1 ? 5 : 1) + (i === 0 || /[\s:./_-]/.test(t[i - 1]) ? 4 : 0);
      idx.push(i); last = i; j++;
    }
    return j === q.length ? [score - text.length * 0.01, idx] : null;
  }
  function marked(text, idx) {
    if (!idx.length) return [text];
    const outN = [], set = new Set(idx);
    let buf = "", on = false;
    for (let i = 0; i <= text.length; i++) {
      const m = set.has(i);
      if (i === text.length || m !== on) { if (buf) outN.push(on ? el("mark", { textContent: buf }) : buf); buf = ""; on = m; }
      if (i < text.length) buf += text[i];
    }
    return outN;
  }
  function palette(mode) {
    palReturn = document.activeElement;
    palMode = mode;
    palBox.classList.remove("hidden");
    palIn.value = mode === "cmd" ? ">" : mode === "goto" ? ":" : "";
    palIn.placeholder = { quick: "Search the shared file, examples and snippets (type > for commands, : for a line)",
      lang: "Select language mode", example: "Open an example (replaces the shared file)", goto: "", cmd: "" }[mode] || "";
    palIn.focus();
    palRender();
  }
  function palClose(back = true) {
    palBox.classList.add("hidden");
    if (back) (palReturn && palReturn.isConnected ? palReturn : ta).focus();
  }
  function palRender() {
    let v = palIn.value, mode = palMode;
    if (mode === "cmd" || mode === "quick" || mode === "goto") mode = v.startsWith(">") ? "cmd" : v.startsWith(":") ? "goto" : "quick";
    const q = v.replace(/^[>:]\s*/, "").toLowerCase();
    let items = [];
    if (mode === "cmd") items = COMMANDS.filter(c => !c[3] || c[3]()).map(c => ({ label: c[0], key: c[1], run: c[2] }));
    else if (mode === "goto") {
      const n = parseInt(q, 10);
      items = [{ label: n >= 1 ? `Go to line ${Math.min(n, lineCount)}` : `Type a line number between 1 and ${lineCount}`, run: n >= 1 ? () => revealLine(Math.min(n, lineCount)) : null }];
    } else if (mode === "lang") items = LANGS.map(l => ({ label: l[1].replace(" (runs here)", ""), det: (RUNNABLE.has(l[0]) ? "runs here · " : "") + "." + l[2], tag: l[0], on: l[0] === langId, run: () => setLang(l[0], true) }));
    else if (mode === "example") items = Object.entries(EXAMPLES).filter(([, x]) => x[1]).map(([k, x]) => ({ label: x[0], tag: x[1], run: () => loadExample(k) }));
    else items = [{ label: fileName(), det: "shared file · everyone edits it live", tag: langId, run: () => { closePeek(); } },
      ...snippets.map(sn => ({ label: sn.title, det: "pinned snippet · " + (sn.ownerName || ""), tag: sn.lang, run: () => peek(sn) })),
      ...Object.entries(EXAMPLES).filter(([, x]) => x[1]).map(([k, x]) => ({ label: x[0], det: "example", tag: x[1], run: () => loadExample(k) })),
      ...symbols.map(s => ({ label: s.name, det: `symbol · line ${s.line}`, run: () => revealLine(s.line) }))];
    if (mode !== "goto") items = items.map(it => ({ ...it, m: fuzzy(it.label, q) })).filter(it => it.m)
      .sort((a, b) => q ? b.m[0] - a.m[0] : 0);
    palItems = items.slice(0, 120);
    palSel = Math.max(0, palItems.findIndex(it => it.on));
    palList.replaceChildren(...(palItems.length ? palItems.map((it, i) => {
      const row = el("div", { className: "opt" + (i === palSel ? " on" : "") },
        it.tag ? langTag(it.tag) : "", el("span", {}, ...marked(it.label, it.m ? it.m[1] : [])),
        it.det ? el("span", { className: "det", textContent: it.det }) : "", it.key ? el("span", { className: "k" }, kbd(it.key)) : "");
      row.addEventListener("mousedown", e => { e.preventDefault(); palPick(i); });
      return row;
    }) : [el("div", { className: "hint", textContent: "No matching results." })]));
  }
  function palPick(i) {
    const it = palItems[i];
    if (!it || !it.run) return;
    const nextMode = ["Change Language Mode", "Open Example…", "Go to Line…", "Go to File or Snippet…"].includes(it.label);
    palClose(!nextMode);
    it.run();
  }
  palIn.addEventListener("input", palRender);
  palIn.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); return palClose(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!palItems.length) return;
      palSel = (palSel + (e.key === "ArrowDown" ? 1 : -1) + palItems.length) % palItems.length;
      [...palList.children].forEach((c, i) => c.classList.toggle("on", i === palSel));
      palList.children[palSel]?.scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") { e.preventDefault(); palPick(palSel); }
  });
  palIn.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== palIn) palBox.classList.add("hidden"); }, 120));

  // ---------- workbench shortcuts (only while the Code tab is showing) ----------
  document.addEventListener("keydown", e => {
    if (pane.classList.contains("hidden") || !ide.isConnected) return;
    const t = e.target;
    if (t !== document.body && !pane.contains(t)) return;
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let fn = null;
    if (k === "F1" || (ctrl && e.shiftKey && k === "p")) fn = () => palette("cmd");
    else if (ctrl && !e.shiftKey && k === "p") fn = () => palette("quick");
    else if (ctrl && !e.shiftKey && k === "g") fn = () => palette("goto");
    else if (ctrl && !e.shiftKey && k === "f") fn = () => openFind(false);
    else if (ctrl && !e.shiftKey && k === "h") fn = () => openFind(true);
    else if (ctrl && !e.shiftKey && k === "b") fn = () => { prefs.side = !prefs.side; savePrefs(); layout(); };
    else if (ctrl && !e.shiftKey && k === "j") fn = () => { prefs.panel = !prefs.panel; savePrefs(); layout(); };
    else if (ctrl && !e.shiftKey && (k === "`" || e.code === "Backquote")) fn = () => toggleTerminal();
    else if (ctrl && e.shiftKey && k === "e") fn = () => showView("explorer");
    else if (ctrl && e.shiftKey && k === "f") fn = () => showView("search");
    else if (ctrl && e.shiftKey && k === "d") fn = () => showView("run");
    else if (ctrl && e.shiftKey && k === "m") fn = () => showPanel("problems");
    else if (ctrl && !e.shiftKey && k === "s") fn = () => { push(); flash("Saved: everyone in the group already has your changes. (Use the download button to keep a copy.)"); };
    else if (k === "F5" && !ctrl) fn = () => e.shiftKey ? (out("Stopped.", "warn"), stop("Stopped.")) : run();
    else if (k === "F3" && !findBox.classList.contains("hidden")) fn = () => step(e.shiftKey ? -1 : 1);
    else if (k === "Escape" && document.body.classList.contains("ide-full") && t === ta && findBox.classList.contains("hidden")) fn = null;
    if (fn) { e.preventDefault(); e.stopPropagation(); fn(); }
  }, true);

  // ---------- resizing ----------
  function drag(sash, onMove) {
    sash.addEventListener("pointerdown", e => {
      e.preventDefault(); sash.setPointerCapture(e.pointerId); sash.classList.add("dragging");
      sash.onpointermove = ev => onMove(ev);
      sash.onpointerup = () => { sash.onpointermove = null; sash.classList.remove("dragging"); savePrefs(); };
    });
  }
  drag(sashSide, ev => { prefs.sideW = Math.round(Math.min(520, Math.max(160, ev.clientX - ide.getBoundingClientRect().left - 44))); layout(); });
  drag(sashPanel, ev => { const r = main.getBoundingClientRect(); prefs.panelH = Math.round(Math.min(r.height - 140, Math.max(80, r.bottom - ev.clientY))); layout(); });

  function fit() {                 // the workbench fills the window below CREW's header
    if (pane.classList.contains("hidden")) return;
    if (document.body.classList.contains("ide-full")) { ide.style.height = ""; return; }
    const top = ide.getBoundingClientRect().top + scrollY;
    const bar = document.getElementById("crewStatusbar");          // CREW's own bottom bar, if shown
    const barH = bar && getComputedStyle(bar).display !== "none" ? bar.offsetHeight : 0;
    ide.style.height = `${Math.max(480, innerHeight - top - barH - 14)}px`;
    syncScroll();
  }
  addEventListener("resize", () => { fit(); schedule(); });
  new MutationObserver(() => { if (!pane.classList.contains("hidden")) { fit(); schedule(); } }).observe(pane, { attributes: true, attributeFilter: ["class"] });
  const appEl = document.getElementById("app");
  function syncWindow() {          // the Code tab takes over the window while it's the open tab
    const on = !pane.classList.contains("hidden") && !appEl.classList.contains("hidden");
    const b = document.body.classList;
    b.toggle("code-open", on);
    b.toggle("code-light", on && ide.classList.contains("light"));
    b.toggle("code-dark", on && !ide.classList.contains("light"));
    if (on) { fit(); schedule(); if (panelView === "terminal" && prefs.panel) mountTerminal(); }
  }
  for (const node of [pane, appEl, ide]) new MutationObserver(syncWindow).observe(node, { attributes: true, attributeFilter: ["class"] });
  syncWindow();

  function layout() {
    ide.classList.toggle("noside", !prefs.side);
    ide.classList.toggle("nopanel", !prefs.panel);
    ide.classList.toggle("nomini", !prefs.mini);
    ide.classList.toggle("light", !!prefs.light);
    ide.style.setProperty("--side-w", prefs.sideW + "px");
    ide.style.setProperty("--panel-h", prefs.panelH + "px");
    ide.style.setProperty("--fs", prefs.fs + "px");
    measure();
    ide.style.setProperty("--lh", LH + "px");
    for (const [id, b] of Object.entries(actButtons)) b.classList.toggle("on", prefs.side && prefs.view === id);
    for (const [id, v] of Object.entries(views)) v.classList.toggle("hidden", id !== prefs.view);
    sashSide.style.left = `${44 + prefs.sideW - 2}px`;
    gutKey = ""; fit(); schedule();
  }

  // ======================================================================
  // hooks into the main page
  // ======================================================================
  function people() {
    const list = typeof peers !== "undefined" && Array.isArray(peers) ? peers : [];
    const on = list.filter(p => p.online).length;
    sbPeople.replaceChildren(svg(ICON.users), String(on));
    sbPeople.title = list.map(p => p.name + (p.online ? "" : " (reconnecting)")).join("\n") || "People in this group";
  }
  const origHandle = handle;
  handle = function (m) {
    if (m.type === "codeshare") {            // full state, sent on every (re)connect
      snippets = m.snippets || []; renderSnippets();
      incoming(m.code || "", m.lang, m.by);
      updateCrumbs();
      if (typeof tab !== "undefined" && tab !== "code") { missed = 0; badge(); }
      return;
    }
    if (m.type === "code") return incoming(m.text, m.lang, m.byName);
    if (m.type === "snippets") { snippets = m.snippets || []; if (peeked && !snippets.some(s => s.id === peeked.id)) closePeek(true); renderSnippets(); return; }
    const r = origHandle(m);
    if (m.type === "peers" || m.type === "welcome") people();
    return r;
  };

  window.crewCode = { open, seen() { missed = 0; badge(); },
    get: () => ({ text: ta.value, lang: langId, selection: ta.value.slice(ta.selectionStart, ta.selectionEnd) }) };
  setLang("javascript", false);
  showPanel("output"); clearOut(); updateProblems(); renderSnippets(); renderSearch(); syncStatus(); people(); layout();
})();
