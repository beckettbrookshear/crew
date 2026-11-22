# CREW

**C**ollaborative **R**esource **E**xchange **W**eb

Link up to 12 computers through a web page. Nothing to install except Python 3.

## Start it

On one computer (the "host"):

```
python3 server.py
```

It prints two addresses, for example:

```
On this computer:    http://localhost:8000
On other computers:  http://192.168.1.23:8000
```

On every computer, open the second address in a browser, type a name, and use the **same group code**.
Inside the app, **Copy invite link** gives a link that fills in the group code for others.

### Group passwords

The first person to join a group code decides whether it has a password: whatever they type in **Group password** becomes the password (leave it blank for an open group). Everyone after that must enter the same password. Tell people the password separately, since the invite link doesn't include it.

A group exists only while someone is in it. Once everyone has left, the group is deleted, and the next person to use that code sets a new password.

### Group owner and suspicious-activity alerts

The first person in a group is its **owner** (👑). If the owner leaves, the person who has been in the group longest takes over. Everyone sees a note saying who the owner is and that they get alerts.

The owner gets a pop-up and an entry in the **Alerts** tab when CREW spots common warning signs:

| Area | Flagged when someone… |
|---|---|
| Chat | posts a link to a program file (.exe, .apk, .ps1…), a bare public IP address or a shortened link; posts a `curl … \| sh` command; seems to ask for a password, code or card details; sends more than 8 messages in 10 seconds; privately messages 5+ people within a minute |
| Shared notes | deletes most of the notes at once (the owner can restore them); adds one of the risky links above |
| Work together | starts a job whose code contacts the internet, uses `eval`/`new Function`, contains scrambled text or looks like crypto-mining; starts more than 5 jobs in a minute; sends an answer for a piece it was never given (the answer is thrown away) |
| Joining | someone keeps entering a wrong password; a removed computer tries to come back |

From an alert the owner can **remove that person from the group** (that browser can't rejoin while the group is open), **cancel the job**, or **restore the deleted notes**. The Alerts tab also lets the owner **change or remove the group password**, which is worth doing after removing someone who knows it.

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
| **Chat** | Message everyone, or pick one person for a private message. |
| **Files** | Share files with everyone, or privately with one person. Drag files onto the tab or choose them. |
| **Shared notes** | One notepad that everyone edits live. |
| **Work together** | Split a computing job across every computer that turns on **Help with jobs**, and compare every computer's processor. |

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

The server hands out pieces to helpers, gives a dropped computer's pieces to someone else, and sends you the results.
There are two ready-made examples to try: counting primes and estimating π.

## Notes

* Max 12 computers per group (`MAX_PEERS` in `server.py`). Any number of groups can run at once.
* Helpers run code written by other group members. It runs in a browser Web Worker sandbox, but only turn on helping in groups you trust.
* The computers need to be on the same network, or the host's port must be reachable (port forwarding or a tunnel). If other computers can't connect, allow the port through the host's firewall.
* A computer that drops keeps its seat for 30 seconds, so refreshing the page doesn't kick you out.
* Use another port with `python3 server.py 9000`.
