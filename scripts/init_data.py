#!/usr/bin/env python3
"""Download checksum-pinned astronomy data; publish files only after validation."""
from __future__ import annotations
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'data-manifest.json'


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def valid(path: Path, asset: dict) -> bool:
    return path.is_file() and path.stat().st_size == asset['size'] and digest(path) == asset['sha256']


def download(asset: dict, directory: Path, replace: bool = False) -> Path:
    name = asset['name']
    if Path(name).name != name or name in {'.', '..'}:
        raise ValueError('Invalid asset filename')
    target = directory / name
    if valid(target, asset):
        print(f'OK {name} (cached)', flush=True)
        return target
    if target.exists() and not replace:
        raise ValueError(f'{name} does not match the pinned checksum; move it aside or use --replace')
    directory.mkdir(parents=True, exist_ok=True)
    request = Request(asset['url'], headers={'User-Agent': 'StarIsle/0.6.0 data-initializer'})
    partial = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix=name+'.', suffix='.partial', delete=False) as f:
            partial = Path(f.name)
            print(f'Download {name}: {asset["size"] / 1024**2:.1f} MiB', flush=True)
            h = hashlib.sha256(); total = 0; next_progress = 10
            with urlopen(request, timeout=60) as response:
                for block in iter(lambda: response.read(1024 * 1024), b''):
                    total += len(block)
                    if total > asset['size']:
                        raise ValueError(f'{name}: upstream size changed; refusing unverified data')
                    h.update(block); f.write(block)
                    percent = total * 100 // asset['size']
                    if percent >= next_progress:
                        print(f'  {name}: {percent}%', flush=True)
                        next_progress = (percent // 10 + 1) * 10
            if total != asset['size'] or h.hexdigest() != asset['sha256']:
                raise ValueError(f'{name}: SHA256/size mismatch; original file preserved')
            f.flush(); os.fsync(f.fileno())
        partial.replace(target); partial = None
        print(f'OK {name}', flush=True)
        return target
    finally:
        if partial is not None:
            partial.unlink(missing_ok=True)


def initialize(profile: str, directory: Path, replace: bool = False) -> None:
    assets = json.loads(MANIFEST.read_text())['assets']
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.initialize.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        selected = [a for a in assets if a['profile'] == 'basic' or profile == 'full']
        for asset in selected:
            destination = directory / 'downloads' if asset.get('catalog_source') else directory
            download(asset, destination, replace)
        if profile == 'full':
            # Build in an isolated directory. A failed build never removes an existing catalogue.
            with tempfile.TemporaryDirectory(dir=directory, prefix='.catalog-build-') as staging:
                target = Path(staging)
                subprocess.run([sys.executable, str(ROOT/'scripts/build_catalogs.py'),
                    '--athyg', str(directory/'downloads/athyg_32_reduced_m10.csv.gz'),
                    '--openngc', str(directory/'downloads/NGC.csv'),
                    '--data-dir', str(target), '--static-dir', str(target)], check=True)
                for name in ['catalog.sqlite3', 'stars-m10.npy', 'deep-sky.json']:
                    (target/name).replace(directory/name)
        (directory/'DATA-LICENSES.md').write_text((ROOT/'CATALOG_LICENSES.md').read_text())
        print(f'Ready: {profile} data in {directory}. Stop the application before replacing catalogues.', flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['basic', 'full'], default='basic')
    parser.add_argument('--data-dir', type=Path, default=Path(os.getenv('DATA_DIR', './data')))
    parser.add_argument('--replace', action='store_true', help='Replace mismatching files after successful download verification')
    args = parser.parse_args()
    try:
        initialize(args.profile, args.data_dir.resolve(), args.replace)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f'Initialization failed: {exc}\n')


if __name__ == '__main__':
    main()
