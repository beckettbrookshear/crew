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

## What the computers can do together

| Tab | What it does |
|---|---|
| **Computers** (left) | Who is connected. Green means online, orange means reconnecting. |
| **Chat** | Message everyone, or pick one person for a private message. |
| **Shared notes** | One notepad that everyone edits live. |
| **Work together** | Split a computing job across every computer that turns on **Help with jobs**. |

### How "Work together" works

1. Write `work(input)`: the code each helper runs on one piece.
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
