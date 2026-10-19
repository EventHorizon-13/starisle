#!/usr/bin/env python3
"""Restore approved, pre-rendered star-trail icons without graphics dependencies.

To change the artwork, see docs/ICONS.md. This never draws the legacy icon.
"""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "icons"

def main():
    manifest = json.loads((SOURCE / "SHA256.json").read_text())
    for name, expected in manifest.items():
        if hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() != expected:
            raise SystemExit(f"Icon checksum mismatch: {name}")
    for name in manifest:
        shutil.copyfile(SOURCE / name, ROOT / "static" / name)
        print(f"restored {name}")

if __name__ == "__main__":
    main()
