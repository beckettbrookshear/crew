#!/usr/bin/env python3
"""One-time setup: lets CREW's Terminal run Python with no internet.

Run this once on the host computer, in the CREW folder:

    python3 setup_python.py

It downloads Pyodide (Python for web browsers, about 7 MB) from its official
GitHub release, checks that the file is exactly the one this script expects,
and unpacks the five files CREW needs into vendor/pyodide/. After that CREW
serves Python itself, and nothing in the Terminal ever goes out to the internet.

No internet on the host? Download the file below on another computer, copy it
next to this script, and run:  python3 setup_python.py --from pyodide-core-314.0.8.tar.bz2

    python3 setup_python.py --force      download again even if it's installed
"""
import hashlib
import io
import os
import sys
import tarfile
import urllib.request

VERSION = "314.0.8"
FILE = f"pyodide-core-{VERSION}.tar.bz2"
URL = f"https://github.com/pyodide/pyodide/releases/download/{VERSION}/{FILE}"
SHA256 = "ff3e5f9d9bc8e98ff30b99515535fc24d375994f47a978c61975d653e162ca37"
NEEDED = ["pyodide.js", "pyodide.asm.mjs", "pyodide.asm.wasm",
          "python_stdlib.zip", "pyodide-lock.json"]

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, "vendor", "pyodide")


def main(argv):
    force = "--force" in argv
    src = argv[argv.index("--from") + 1] if "--from" in argv and argv.index("--from") + 1 < len(argv) else None
    if not force and all(os.path.isfile(os.path.join(DEST, n)) for n in NEEDED):
        print(f"Python (Pyodide {VERSION}) is already installed in {DEST}")
        return 0

    if src:
        print(f"Reading {src} ...")
        with open(src, "rb") as f:
            data = f.read()
    else:
        print(f"Downloading Pyodide {VERSION} (about 7 MB) from github.com ...")
        try:
            with urllib.request.urlopen(URL, timeout=60) as r:
                data = r.read()
        except OSError as e:
            print(f"Couldn't download it: {e}\n"
                  f"Download {URL} on another computer, copy it here, then run:\n"
                  f"  python3 setup_python.py --from {FILE}")
            return 1

    digest = hashlib.sha256(data).hexdigest()
    if digest != SHA256:
        print("That file is not the one expected, so nothing was installed.\n"
              f"  expected SHA-256 {SHA256}\n  got              {digest}")
        return 1

    os.makedirs(DEST, exist_ok=True)
    found = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:bz2") as tar:
        for member in tar:                    # only take the files we need, by name
            name = os.path.basename(member.name)
            if member.isfile() and name in NEEDED and name not in found:
                with open(os.path.join(DEST, name), "wb") as out:
                    out.write(tar.extractfile(member).read())
                found.add(name)
    missing = set(NEEDED) - found
    if missing:
        print("The download was missing: " + ", ".join(sorted(missing)))
        return 1
    with open(os.path.join(DEST, "VERSION"), "w") as f:
        f.write(VERSION + "\n")
    print(f"Done. Python is installed in {DEST}\n"
          "The Terminal tab can now run Python offline. No restart needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
