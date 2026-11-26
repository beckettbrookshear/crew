# CREW

**C**ollaborative **R**esource **E**xchange **W**eb

A place for friends who are learning to code, or coding for fun, to work in the same code at the same time. Up to 12 computers join through a web page. Nothing to install except Python 3.

* **Edit one piece of code together**, live, with line numbers and automatic indenting.
* **Run it** with one click (JavaScript and HTML), with errors explained in plain English.
* **Pin snippets** so good code doesn't get lost, and **paste code in chat** as proper code blocks.
* Chat, send files, browse docs together, and (optionally) ask Claude for help.
* **Mail** each other like in Gmail, even people who are offline right now. Only the recipient can read it.

## Start it

On one computer (the "host"):

```
python3 server.py
```

It prints two addresses and a certificate fingerprint, for example:

```
On this computer:    https://localhost:8000
On other computers:  https://192.168.1.23:8000
Connections are encrypted (HTTPS).
  ...this SHA-256 fingerprint, then continue:
    A8:8C:02:CD:...:8D:41
```

On every computer, open the second address in a browser, type a name, and use the **same group code** and **group password**.
Inside the app, **Copy invite link** gives a link that fills in the group code for others.

**The first time, the browser warns that the connection isn't private.** That's because CREW made its own certificate instead of buying one. To check that you're really talking to your host and not an impostor, open the browser's certificate details (click the warning or the padlock area) and compare the **SHA-256 fingerprint** with the one the host printed. If they match, continue (Chrome: *Advanced → Proceed*; Firefox: *Advanced → Accept the Risk*). If they don't match, don't continue: someone may be intercepting the connection.

### Privacy and encryption

CREW is built so that other people on the network, and even the host computer, can't read your group's conversations:

| What | Protection |
|---|---|
| Everything between browsers and the host | **HTTPS** (TLS 1.2 or newer). People on the same Wi-Fi, the network owner or your internet provider see only scrambled traffic. Typing `http://` redirects to `https://`. |
| Chat (including private messages), shared notes, shared files and file names | **End-to-end encrypted** (AES-256-GCM) in each browser with a key that comes from the group password. The host computer only stores and passes along scrambled data. |
| Mail | **End-to-end encrypted to each recipient** (ECDH P-256 + AES-256-GCM) with a key that only the recipient's browser holds. Other group members can't read it either. See "Mail" below. |
| The group password | **Never sent anywhere.** The browser derives two values from it (PBKDF2, 600,000 rounds): one proves to the host that you know the password, the other unlocks the group key. The host can't turn the first into the second. |
| The page itself | Strict browser rules: it can't load or send anything to other websites, can't be embedded in other sites, and doesn't leak its address. Job code running on helpers is also blocked from contacting the internet. |
| Storage | Nothing is written to disk. Groups, messages and files live in the host's memory and disappear when everyone leaves or the server stops. The browser remembers a derived key (not the password) for the current tab only, so a reload doesn't ask again. The one exception is your **mail key**, which the browser keeps (in IndexedDB, for each group code) so you can read mail when you come back. |

What is **not** hidden, so you can decide what to share:

* **From the host computer:** names, who's online, the group code, when messages are sent and how big files are (not their contents or names), who mailed whom, when, how big each mail is and whether it's read, starred, archived or in Trash (not the subject, text or attachments), job code and results in **Work together**, the shared **Code** editor and pinned snippets, pages opened in **Browse** (the host fetches them), and everything in **Claude Code** (it runs on the host, and Claude Code sends that code to Anthropic as any Claude Code session does).
* **In the Terminal:** your files stay in your own browser, and programs run there, never on the host. The one exception is Python's `input()`: the lines you type into a *running Python program* pass through the host so the program can read them (over HTTPS, never stored).
* **From the network:** that computers are talking to the host, when, and roughly how much. Not what they say.
* **A host who changes CREW's code** could send everyone a modified page that captures the password. End-to-end encryption protects against a host (or anyone who breaks into it) reading what it stores and relays, not against a host that deliberately rewrites the app. Only use a host you trust.
* **A weak password can be guessed** by someone who has the host's data. Use a long passphrase of several words.

Your own certificate: if you have one (for example from your company or Let's Encrypt), use it with `python3 server.py --cert cert.pem --key key.pem`, and browsers won't warn. CREW's self-made certificate is kept in `~/.config/crew/` and remade if the host's network address changes, which means checking the new fingerprint. `--no-tls` turns HTTPS off; don't use it except for testing on the host itself.

### Group passwords

Every group has a password of at least 8 characters, because it's what encrypts the group. The first person to join a group code sets it; everyone after that must enter the same one. Tell people the password separately (in person, or another private channel), since the invite link doesn't include it.

The owner can change the password in the **Alerts** tab. Everyone already in the group keeps reading everything; only people joining later need the new password. A group can't be made open.

A group exists only while someone is in it. Once everyone has left, the group and its encryption key are deleted, and the next person to use that code sets a new password.

### Group owner and suspicious-activity alerts

The first person in a group is its **owner** (👑). If the owner leaves, the person who has been in the group longest takes over. Everyone sees a note saying who the owner is and that they get alerts.

The owner gets a pop-up and an entry in the **Alerts** tab when CREW spots common warning signs:

| Area | Flagged when someone… |
|---|---|
| Chat | posts a link to a program file (.exe, .apk, .ps1…), a bare public IP address or a shortened link; posts a `curl … \| sh` command; seems to ask for a password, code or card details; sends more than 8 messages in 10 seconds; privately messages 5+ people within a minute |
| Shared notes | deletes most of the notes at once (the owner can restore them); adds one of the risky links above |
| Work together | starts a job whose code contacts the internet, uses `eval`/`new Function`, contains scrambled text or looks like crypto-mining; starts more than 5 jobs in a minute; sends an answer for a piece it was never given (the answer is thrown away); gives a different answer than the other computers on a double-checked job |
| Mail | sends more than 10 mails in a minute; keeps sending mail to 5+ people at once |
| Joining | someone keeps entering a wrong password; a removed computer tries to come back |

Because chat, notes and files are end-to-end encrypted, CREW can't read them to look for risky links or requests for passwords. For those it only checks **how** people behave (message floods, mass private messages, wiping the notes), not **what** they write.

From an alert the owner can **remove that person from the group** (that browser can't rejoin while the group exists), **cancel the job**, or **restore the deleted notes**. The Alerts tab also lets the owner **change the group password**, which is worth doing after removing someone who knows it.

These are simple pattern checks: expect some false alarms, and don't rely on them to catch everything.

### Personal preferences

Click **⚙** in the header (or press **Ctrl+,**) to set up CREW your way. Preferences are saved only in your own browser.

* **Appearance:** themes (Linux Light, Linux Dark, follow system, Terminal Green, Terminal Amber, Solarized Light/Dark, High Contrast), accent color, Linux-desktop or plain-web window style, rounded or square corners, font and text size
* **Layout:** compact/normal/roomy spacing, computer list left/right/hidden, full width, status bar, which tab opens first
* **Chat:** bubbles or IRC-style lines (`[12:01] <ann> hi`), timestamps, 24-hour clock, seconds, join/leave notices, sound and desktop notifications
* **General:** confirm before leaving, keyboard shortcuts (**Alt+1…9** switch tabs, **Alt+M** jump to chat), and export/import/reset

## What the computers can do together

| Tab | What it does |
|---|---|
| **Computers** (left) | Who is connected. Green means online, orange means reconnecting. Under each name: cores, memory and speed score. Hover for full details. |
| **Code** (opens first) | A shared code editor laid out like a desktop IDE, with Run, Problems, a command palette and pinned snippets. See "Coding together" below. |
| **Terminal** | A practice terminal in your browser that runs Python and JavaScript with no internet. See "The Terminal" below. |
| **Chat** | Message everyone, or pick one person for a private message. Wrap code in three backticks (```) to post it as a code block with a Copy button. Enter sends; Shift+Enter starts a new line. |
| **Mail** | Gmail-style mail to people in the group, including people who are offline. Inbox, Sent, Starred, Archive, Trash, conversations, search and attachments. See "Mail" below. |
| **Files** | Share files with everyone, or privately with one person. Drag files onto the tab or choose them. |
| **Shared notes** | One notepad that everyone edits live. |
| **Work together** | Split a computing job across every computer that turns on **Help with jobs**, and compare every computer's processor. |
| **Browse** | A built-in web browser. Send the page you're on to the group chat, or let others follow along as you browse. |
| **Claude Code** (optional, everyone) | Code with Claude Code in a chat panel like the one in VS Code. Each person signs in with their own Claude account and gets their own folder on the host computer. The Code tab also gets an **Ask Claude** chat about the shared editor's code. |

### Coding together

The **Code** tab is the main place to work. It's laid out like a desktop code editor:

| Part | What's there |
|---|---|
| **Activity bar** (far left) | Switch the side bar between **Explorer**, **Search** and **Run**; jump to Chat or Claude Code; ⚙ opens every command. |
| **Explorer** | The shared file, an **Outline** of its functions and classes (click to jump), **Pinned snippets** (click to preview one in a read-only tab) and **Examples**. |
| **Editor** | Syntax colors for 14 languages, line numbers, current-line highlight, matching-bracket highlight, brackets colored by depth, a minimap, and red squiggles for brackets that don't match and for the line where a run failed. |
| **Panel** (bottom) | **Problems** (click one to jump to it), **Output** from your program, and **Preview** for HTML pages. |
| **Status bar** | Whether your changes are live with the group, error count, line and column, language (click to change), and who's online. |

Handy keys (all listed under ⚙ or **Ctrl+Shift+P**):

| Keys | Does |
|---|---|
| **Ctrl+Shift+P** or **F1** | Command palette: type to find any command |
| **Ctrl+P** | Jump to the file, a snippet, an example or a function |
| **F5** / **Shift+F5** (or **Ctrl+Enter**) | Run / Stop |
| **Ctrl+F** / **Ctrl+H** | Find / Replace |
| **Ctrl+G** | Go to line |
| **Ctrl+/** | Comment or uncomment lines |
| **Alt+↑ / Alt+↓** | Move lines up or down (add **Shift** to copy them) |
| **Ctrl+Shift+K** | Delete line |
| **Ctrl+D** | Select the word, then the next place it appears |
| **Ctrl+B** / **Ctrl+J** | Hide or show the side bar / panel |
| **Ctrl+= / Ctrl+- / Ctrl+0** | Editor font bigger / smaller / reset |

Brackets and quotes close themselves as you type. The side bar and panel can be resized by dragging their edges, **⛶** fills the whole window, and the palette has a light editor theme. These layout choices are remembered in your browser.

* **One shared file.** Everyone sees changes as they're typed. Change the language from the status bar, or open an example from the Explorer if you're new (this replaces the shared code for everyone, so you're asked first). **Tab** indents, **Shift+Tab** un-indents, and Enter keeps the indent. If you're stuck in the box, press **Esc** and then **Tab** to move on.
* **If two people type at once**, the person who didn't type last isn't overwritten: they're asked whether to use the other version or keep their own. Only one version wins, so it works best when you take turns or split up the work.
* **Run** (or **Ctrl+Enter**) runs the code on your own computer only. JavaScript runs as a program with its output shown below the editor; HTML shows the page. The code can't use the internet, can't reach your files and is stopped after 10 seconds, so an endless loop can't freeze you. Press **Stop** to end it sooner. Errors show the line number, with a plain-English hint for common mistakes. If someone else wrote the latest version, you're asked before running it. This is a safety net, not a guarantee, so read code from people you don't trust.
* **Other languages** (Python, Java, C, and more) can be edited, shared, copied, downloaded and posted to chat, but not run here. Copy the code and run it the way you normally would.
* **💬** posts the selected code (or all of it) to chat as a code block. **📌** pins it as a snippet, which keeps it when the file changes. Anyone can preview, copy or open a snippet.
* The server saves the shared code and snippets only while the group exists. **Download** to keep a copy.

### The Terminal

The **Terminal** tab is a safe place to practise: a shell that lives in your browser and runs code **with no internet**.

* **Your own files.** A small virtual disk (2 MB) with a starter `hello.py`, `hello.js` and `README.txt`. It's saved in your browser only, and programs can't touch your computer's real files. `reset` restores the starter files.
* **Real shell commands:** `ls cd pwd mkdir touch cat cp mv rm tree echo head tail wc sort grep`, plus pipes (`cat notes.txt | grep todo | wc -l`), redirects (`>`, `>>`, `<`), quotes, `$VARIABLES`, `*` wildcards, `&&`, Tab to finish names and Up for earlier commands. Type `help` for the list.
* **Python** is the real CPython 3.14, run in your browser by [Pyodide](https://pyodide.org). `python hello.py` runs a file, `python -c "print(1+1)"` runs a line, and `python` on its own opens an interactive prompt (`exit()` or Ctrl+D leaves). `input()` works, you can feed a program with `python prog.py < input.txt` or `echo 5 | python prog.py`, files your programs write show up in `ls`, and Python's whole built-in library (`random`, `math`, `json`, `datetime`...) is there. Errors are shown cleanly with a plain-English hint.
* **JavaScript** runs with `node hello.js` or `node -e "console.log(1+1)"`. It's your browser's JavaScript, not Node.js: there's no `require` or `fs`, but `await input("question? ")` asks a question and top-level `await` works.
* **`run`** runs the code in the Code tab's editor (Python or JavaScript, by its language). `editor save name.py` copies the editor's code into a file, and `editor load name.py` opens a file in the Code tab.
* **Ctrl+C** stops a program (an endless loop can't freeze anything), **Ctrl+D** ends input, and a program that prints more than 1 MB is stopped.

**One-time setup for Python.** CREW serves Python itself, so nothing is fetched from the internet while people use it. The host runs this once, in the CREW folder, and needs no restart:

```
python3 setup_python.py
```

It downloads Pyodide (about 7 MB) from its official GitHub release, checks it is exactly the expected file (SHA-256), and unpacks five files into `vendor/pyodide/`. If the host has no internet, download the file it names on another computer, copy it next to `setup_python.py`, and run `python3 setup_python.py --from pyodide-core-314.0.8.tar.bz2`. Until then the Terminal works for everything except Python, and says so. JavaScript needs no setup.

**What "no internet" means here.** Programs run in a browser Web Worker, and the page's security policy only lets the browser connect back to this CREW server. In testing, Python's `urllib` and raw browser requests to other sites failed, and a Python socket couldn't send any data (a test listener on the same computer saw nothing). So `pip install`, `curl`, `git` and friends can't work, and only the built-in libraries are available (no numpy or other packages). Programs also can't reach each other or other computers on your network. Like any browser-based sandbox, treat this as strong protection and not as a guarantee: read code from people you don't trust before running it.

### Coding with Claude Code

The host turns it on by starting CREW with `--claude`:

```
python3 server.py --claude
```

**Everyone** in the group then gets a **Claude Code** tab (and the ✦ icon on the Code tab's activity bar opens it). Each person:

1. **Signs in with their own Claude account.** Paste either a **Claude login token**, made by running `claude setup-token` on your own computer (for Claude Pro or Max), or an **Anthropic API key** from console.anthropic.com. Your usage is billed to your own account. Tick *Remember it in this browser tab* to stay signed in through reloads; **Sign out** forgets it.
2. **Works in their own folder** on the host: `~/crew-workspace/<group>/<name>-<id>`. To keep the workspaces somewhere else, use `--claude /some/folder`. Files stay there after you leave, so you can come back to them from the same browser.
3. **Sees only their own conversation and approvals.** Nobody else sees what you ask or what Claude does for you.

* Type what you want ("explain this project", "fix the failing test", "add a dark mode"). Claude's replies, the files it reads, its edits (as red/green diffs) and the commands it runs all appear in the panel.
* Before Claude edits a file or runs a command that changes something, an approval card appears: **Allow**, **Always allow** that tool for this conversation, or **Deny**. Read-only commands such as `ls` or `cat` run without asking.
* **Mode** picks what Claude may do without asking: *Ask before edits and commands* (the default), *Auto-accept file edits*, or *Plan only* (no changes). There is no "skip all approvals" mode.
* **Model** picks Opus 5.5 (the default), Sonnet 5.5 or Haiku 5.5. Follow-up messages continue the same conversation; **New conversation** starts fresh. **Stop** interrupts Claude.
* Each run shows its time and cost, billed to the account you signed in with.

**Ask Claude in the Code tab.** With `--claude` on, everyone also gets an **✦ Ask Claude** chat beside the shared editor (below it on narrow screens), using the account you signed in with on the Claude Code tab. Each question carries the editor's code, plus your selection if you've selected some, so you can just ask "why doesn't this work?". Quick buttons ask Claude to **Explain** the code, find **Why it doesn't work**, **Add comments** or **Improve it**. Code in Claude's answers has **Put in editor** (replaces the shared code for everyone, after asking) and **Copy**. This chat is separate from the Claude Code tab: Claude gets no tools at all here (it can't read files, run commands or browse), and it runs in an empty folder, so it only sees what you send. Untick **Include the editor's code** to ask without it. **✕** hides the panel and **✦ Ask Claude** brings it back.

What you need, and what to know:

* Claude Code installed on the host (it doesn't need to be signed in there; everyone uses their own account). CREW looks for `claude` on the PATH, then in the copy that the VS Code extension ships with. Set `CREW_CLAUDE_BIN=/path/to/claude` to choose one.
* Sign-ins are sent over the encrypted connection, kept only in the host's memory (never on disk), used only for that person's runs, and forgotten when they sign out or leave. Each run gets its own empty Claude Code settings folder, so nobody can end up using the host's own Claude login.
* **This is not a security boundary between people.** Everyone's Claude runs **on the host computer, as the host's user**. Claude asks before editing files or running commands, and CREW blocks it from reading places like `~/.ssh`, `~/.claude` and `~/.config`. But with approval, someone's Claude can still run commands that reach other folders, and in principle read other people's sign-ins from the host's memory. A host who changes CREW's code could see sign-ins too. Only turn this on for a group of people who trust each other and the host, and use a password-protected group.
* Approvals reach CREW from the Claude Code process over this computer only, with a secret made at startup (see `claude_bridge.py`).

### Browsing together

Type an address or a search (searches use DuckDuckGo) in the **Browse** tab. Back, forward, reload and **Alt+←/→** work as usual.

* **Send to group** posts the page in the chat with an **Open in Browse** button.
* **Let others follow me** shares your browsing: anyone who picks **Follow *your name*** sees each page you open. Opening a page yourself stops following.
* The CREW host computer fetches each page (see `browse.py`), so websites see the host's internet address. Pictures and styles load directly from the site.
* Signing in, forms that send data, videos and big web apps (Google Docs, YouTube) don't work. Use **Open in your browser** for those. File downloads are refused.
* For safety, addresses on your own network (routers, printers, other computers, the CREW server) are blocked, and pages run sandboxed so they can't see CREW or your session.
* Pages shared to the group, or opened while others follow you, go through the same suspicious-link checks as chat.

### Mail

The **Mail** tab works like a small Gmail for your group:

* **Compose** opens a message window in the corner. Type a name in **To** and pick from the list (green dot = online now). Add files with 📎 or by dragging them in (2 MB in total; use the Files tab for bigger ones). **Ctrl+Enter** sends.
* **Inbox, Starred, Sent, All mail, Trash.** Replies are grouped into conversations. Open one to read it, then **Reply**, **Reply all** or **Forward**. Quoted text is folded behind **•••**.
* Select conversations with the checkboxes to **archive**, **delete**, or mark them **read/unread**. Anything in Trash can be deleted for good. Click ☆ to star.
* **Search** looks through subjects, text, names and attachment names. It runs in your browser, because only your browser can read your mail.
* Keyboard shortcuts as in Gmail: **c** compose, **/** search, **r** reply, **a** reply all, **f** forward, **e** archive, **#** delete, **u** back to the list.
* **Mail waits for people who are away.** You can write to anyone who has been in the group while it existed. They get the mail when they come back to the group **from the same browser**.

How it stays private:

* The first time you open a group, your browser makes its own **mail key** for that group code and keeps it. Only the public half is shared, on a "card" encrypted with the group key, so only group members (not the host) can add cards.
* Each mail is encrypted once, and its key is locked separately for each recipient and for your own Sent copy. The lock also uses the sender's key, so nobody can fake who a mail is from.
* Each mailbox has a **safety code** (🔑, shown next to names and in the left column). If you want to be sure, compare codes in person. Two mailboxes with the same name are told apart by their codes.
* Mail can be read **only in the browser that received it**. Another browser, a private window that has been closed, or clearing the site's data means a new, empty mailbox, and mail sent to the old one can't be opened. On a shared computer, click **Forget my mail key here** when you're done.
* Like everything else in CREW, mail lives in the host's memory only. It's gone when everyone leaves the group or the server stops. Limits (in `mail.py`): 60 MB of mail per group, 1,000 mails per mailbox, 40 recipients per mail.

### Sharing files

* Up to 25 MB per file and 250 MB per group (`MAX_FILE` and `MAX_GROUP_FILES` in `server.py`).
* Files are kept in the host computer's memory, not on disk. They disappear when the server stops or everyone leaves the group.
* A private file is visible only to the sender and the recipient. It is removed if the recipient leaves.
* Only the person who shared a file can delete it. If that person has left, anyone can.
* Files are always downloaded, never opened inside the app, so a shared web page or script can't run in CREW.

### Processor details

Each computer shares what its browser can report: number of cores, memory (Chrome and Edge only, rounded), operating system and CPU architecture, browser, and graphics chip. It also shares a **speed score** from a 1-second single-core test (higher is faster). The test runs once and is remembered; **Test speed again** re-runs it.
The **Processors in this group** table in **Work together** compares every computer and shows total cores and how many pieces the helpers can run at once.
Turn off **Share this computer's processor details** to hide them.

### How "Work together" works

1. Write `work(input)`: the code each helper runs on one piece.
   Each helper loads your code once per job and reuses it for later pieces, so variables declared outside `work` carry over between pieces on the same helper.
2. List the inputs as JSON, one item per piece, for example `[[0,100000],[100000,200000]]`.
3. Optionally write `combine(results, inputs)`, which runs on your computer once every piece is done.

The server hands out pieces to helpers, gives a dropped computer's pieces to someone else, and sends you the results. It also shares the work out sensibly:

* **Faster computers first.** When several helpers are free, the next piece goes to the one with the best speed score and the fewest pieces running.
* **Backup copies of slow pieces.** If a piece runs much longer than this job's pieces usually take (1.5× the typical time, at least 3 seconds), a free helper runs it too. The first answer back is used and the other computer is told to stop.
* **Double-check (optional).** Tick *Double-check every piece on two different computers* and each piece runs on two computers. If their answers differ, a third computer breaks the tie and the group owner gets an alert about the computer that disagreed. This needs at least 2 helpers, doubles the work, and only suits jobs that give the same answer every time (not random ones like the π example).
There are two ready-made examples to try: counting primes and estimating π.

## Notes

* Max 12 computers per group (`MAX_PEERS` in `server.py`). Any number of groups can run at once.
* Helpers run code written by other group members. It runs in a browser Web Worker sandbox, but only turn on helping in groups you trust.
* The computers need to be on the same network, or the host's port must be reachable (port forwarding or a tunnel). If other computers can't connect, allow the port through the host's firewall.
* A computer that drops keeps its seat for 30 seconds, so refreshing the page doesn't kick you out.
* Use another port with `python3 server.py 9000`.
