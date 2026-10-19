#!/usr/bin/env python3
"""Build compact local catalog files from AT-HYG and OpenNGC snapshots.

The generated files are intentionally kept outside the application image where
appropriate: ``stars-m10.npy`` and ``catalog.sqlite3`` belong in ``data/``;
``deep-sky.json`` is a compact display catalogue copied with the static shell.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import re
import sqlite3
import unicodedata
from datetime import date
from pathlib import Path

import numpy as np


STAR_DTYPE = np.dtype([
    ("id", "<i4"),
    ("ra", "<f4"),       # ICRS hours, epoch J2000
    ("dec", "<f4"),      # ICRS degrees, epoch J2000
    ("pm_ra", "<f4"),    # mas/year, already multiplied by cos(dec)
    ("pm_dec", "<f4"),   # mas/year
    ("mag", "<f4"),
    ("ci", "<f4"),
    ("hip", "<i4"),
    ("tyc1", "<u2"),
    ("tyc2", "<u2"),
    ("tyc3", "u1"),
])

GREEK = {
    "Alp": ("Alpha", "α"), "Bet": ("Beta", "β"), "Gam": ("Gamma", "γ"),
    "Del": ("Delta", "δ"), "Eps": ("Epsilon", "ε"), "Zet": ("Zeta", "ζ"),
    "Eta": ("Eta", "η"), "The": ("Theta", "θ"), "Iot": ("Iota", "ι"),
    "Kap": ("Kappa", "κ"), "Lam": ("Lambda", "λ"), "Mu": ("Mu", "μ"),
    "Nu": ("Nu", "ν"), "Xi": ("Xi", "ξ"), "Omi": ("Omicron", "ο"),
    "Pi": ("Pi", "π"), "Rho": ("Rho", "ρ"), "Sig": ("Sigma", "σ"),
    "Tau": ("Tau", "τ"), "Ups": ("Upsilon", "υ"), "Phi": ("Phi", "φ"),
    "Chi": ("Chi", "χ"), "Psi": ("Psi", "ψ"), "Ome": ("Omega", "ω"),
}


def text(value: str | None) -> str:
    return (value or "").strip()


def integer(value: str | None) -> int:
    try:
        return int(float(text(value)))
    except (TypeError, ValueError):
        return 0


def number(value: str | None, default: float = math.nan) -> float:
    try:
        return float(text(value))
    except (TypeError, ValueError):
        return default


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    return "".join(ch for ch in value if ch.isalnum() or ch in "αβγδεζηθικλμνξοπρστυφχψω")


def tycho_parts(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"(\d+)-(\d+)-(\d+)", text(value))
    return tuple(map(int, match.groups())) if match else (0, 0, 0)


def star_aliases(row: dict[str, str]) -> list[str]:
    aliases: list[str] = []
    for prefix, key in (("TYC", "tyc"), ("HIP", "hip"), ("HD", "hd"), ("HR", "hr"), ("GJ", "gl")):
        value = text(row.get(key))
        if value:
            aliases.append(f"{prefix} {value}")
    proper, bayer, flam, con = (text(row.get(key)) for key in ("proper", "bayer", "flam", "con"))
    if proper:
        aliases.append(proper)
    if bayer:
        aliases.extend((f"{bayer} {con}", f"{bayer}{con}"))
        root = bayer[:3].title()
        suffix = bayer[3:]
        if root in GREEK:
            english, symbol = GREEK[root]
            aliases.extend((f"{english}{suffix} {con}", f"{symbol}{suffix} {con}"))
    if flam:
        aliases.extend((f"{flam} {con}", f"{flam}{con}"))
    return list(dict.fromkeys(alias for alias in aliases if alias.strip()))


def build_stars(source: Path, output_npy: Path, connection: sqlite3.Connection) -> int:
    connection.executescript("""
        DROP TABLE IF EXISTS stars;
        CREATE TABLE stars (
            id INTEGER PRIMARY KEY,
            tyc TEXT, hip INTEGER, hd INTEGER, hr INTEGER, gl TEXT,
            bayer TEXT, flam TEXT, con TEXT, proper TEXT,
            ra REAL NOT NULL, dec REAL NOT NULL, pm_ra REAL, pm_dec REAL,
            mag REAL NOT NULL, ci REAL, spect TEXT,
            aliases TEXT NOT NULL, search_text TEXT NOT NULL
        );
    """)
    records: list[tuple] = []
    numeric: list[tuple] = []
    opener = gzip.open if source.suffix == ".gz" else open
    with opener(source, "rt", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            star_id = integer(row.get("id"))
            ra, dec, mag = number(row.get("ra")), number(row.get("dec")), number(row.get("mag"))
            if not star_id or not all(math.isfinite(v) for v in (ra, dec, mag)) or star_id == 1:
                continue
            tyc = text(row.get("tyc"))
            hip, hd, hr = (integer(row.get(key)) for key in ("hip", "hd", "hr"))
            pm_ra, pm_dec, ci = (number(row.get(key)) for key in ("pm_ra", "pm_dec", "ci"))
            aliases = star_aliases(row)
            search_value = " ".join(normalize(alias) for alias in aliases)
            records.append((
                star_id, tyc, hip or None, hd or None, hr or None, text(row.get("gl")),
                text(row.get("bayer")), text(row.get("flam")), text(row.get("con")), text(row.get("proper")),
                ra, dec, pm_ra if math.isfinite(pm_ra) else None, pm_dec if math.isfinite(pm_dec) else None,
                mag, ci if math.isfinite(ci) else None, text(row.get("spect")),
                " · ".join(aliases), search_value,
            ))
            t1, t2, t3 = tycho_parts(tyc)
            numeric.append((
                star_id, ra, dec,
                pm_ra if math.isfinite(pm_ra) else 0.0,
                pm_dec if math.isfinite(pm_dec) else 0.0,
                mag, ci if math.isfinite(ci) else math.nan,
                hip, t1, t2, t3,
            ))
            if len(records) >= 10_000:
                connection.executemany("INSERT INTO stars VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", records)
                records.clear()
    if records:
        connection.executemany("INSERT INTO stars VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", records)
    connection.executescript("""
        CREATE INDEX stars_tyc_idx ON stars(tyc);
        CREATE INDEX stars_hip_idx ON stars(hip);
        CREATE INDEX stars_hd_idx ON stars(hd);
        CREATE INDEX stars_hr_idx ON stars(hr);
        CREATE INDEX stars_proper_idx ON stars(proper COLLATE NOCASE);
    """)
    array = np.asarray(numeric, dtype=STAR_DTYPE)
    output_npy.parent.mkdir(parents=True, exist_ok=True)
    np.save(output_npy, array, allow_pickle=False)
    return len(array)


def hms_to_hours(value: str) -> float:
    hour, minute, second = value.split(":")
    return int(hour) + int(minute) / 60.0 + float(second) / 3600.0


def dms_to_degrees(value: str) -> float:
    sign = -1 if value.startswith("-") else 1
    degree, minute, second = value.lstrip("+-").split(":")
    return sign * (int(degree) + int(minute) / 60.0 + float(second) / 3600.0)


def pretty_catalog(value: str) -> str:
    match = re.fullmatch(r"(NGC|IC)0*(\d+)(.*)", value, re.IGNORECASE)
    return f"{match.group(1).upper()} {int(match.group(2))}{match.group(3)}" if match else value


def build_deep_sky(source: Path, output_json: Path, connection: sqlite3.Connection) -> int:
    connection.executescript("""
        DROP TABLE IF EXISTS deep_sky;
        CREATE TABLE deep_sky (
            id TEXT PRIMARY KEY, catalog TEXT NOT NULL, type TEXT NOT NULL,
            ra REAL NOT NULL, dec REAL NOT NULL, mag REAL,
            constellation TEXT, major REAL, minor REAL, position_angle REAL,
            messier INTEGER, aliases TEXT NOT NULL, search_text TEXT NOT NULL
        );
    """)
    objects: list[dict] = []
    sql_rows: list[tuple] = []
    with source.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle, delimiter=";"):
            object_type = text(row.get("Type"))
            if object_type in {"NonEx", "Dup"} or not text(row.get("RA")) or not text(row.get("Dec")):
                continue
            raw_name = text(row.get("Name"))
            catalog = pretty_catalog(raw_name)
            object_id = "dso:" + normalize(catalog)
            ra, dec = hms_to_hours(text(row.get("RA"))), dms_to_degrees(text(row.get("Dec")))
            magnitude = number(row.get("V-Mag"))
            if not math.isfinite(magnitude):
                magnitude = number(row.get("B-Mag"))
            messier = integer(row.get("M"))
            aliases = [catalog]
            if messier:
                aliases.append(f"M{messier}")
            for prefix, key in (("NGC", "NGC"), ("IC", "IC")):
                value = text(row.get(key))
                if value:
                    aliases.append(f"{prefix} {value}")
            common = [item.strip() for item in text(row.get("Common names")).split(",") if item.strip()]
            aliases.extend(common)
            aliases = list(dict.fromkeys(aliases))
            major, minor, position_angle = (number(row.get(key)) for key in ("MajAx", "MinAx", "PosAng"))
            item = {
                "id": object_id,
                "catalog": catalog,
                "type": object_type,
                "ra_hours": round(ra, 8),
                "dec_degrees": round(dec, 8),
                "magnitude": round(magnitude, 2) if math.isfinite(magnitude) else None,
                "constellation": text(row.get("Const")),
                "major_arcmin": round(major, 2) if math.isfinite(major) else None,
                "minor_arcmin": round(minor, 2) if math.isfinite(minor) else None,
                "position_angle": round(position_angle, 1) if math.isfinite(position_angle) else None,
                "messier": messier or None,
                "aliases": " · ".join(aliases[1:]),
            }
            objects.append(item)
            search_parts = aliases + [text(row.get("Identifiers"))]
            sql_rows.append((
                object_id, catalog, object_type, ra, dec,
                magnitude if math.isfinite(magnitude) else None, text(row.get("Const")),
                major if math.isfinite(major) else None, minor if math.isfinite(minor) else None,
                position_angle if math.isfinite(position_angle) else None, messier or None,
                " · ".join(aliases[1:]), " ".join(normalize(value) for value in search_parts if value),
            ))
    connection.executemany("INSERT INTO deep_sky VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", sql_rows)
    connection.executescript("""
        CREATE INDEX deep_sky_catalog_idx ON deep_sky(catalog COLLATE NOCASE);
        CREATE INDEX deep_sky_messier_idx ON deep_sky(messier);
    """)
    payload = {
        "source": "OpenNGC",
        "source_version": "v20260501",
        "license": "CC BY-SA 4.0",
        "generated": date.today().isoformat(),
        "objects": objects,
    }
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return len(objects)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--athyg", required=True, type=Path)
    parser.add_argument("--openngc", required=True, type=Path)
    parser.add_argument("--data-dir", default=Path(__file__).resolve().parents[1] / "data", type=Path)
    parser.add_argument("--static-dir", default=Path(__file__).resolve().parents[1] / "static", type=Path)
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    database = args.data_dir / "catalog.sqlite3"
    if database.exists():
        database.unlink()
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA journal_mode=OFF")
        connection.execute("PRAGMA synchronous=OFF")
        star_count = build_stars(args.athyg, args.data_dir / "stars-m10.npy", connection)
        dso_count = build_deep_sky(args.openngc, args.static_dir / "deep-sky.json", connection)
        connection.commit()
        connection.execute("VACUUM")
    finally:
        connection.close()
    print(f"built {star_count:,} stars and {dso_count:,} deep-sky objects")
    print(f"wrote {args.data_dir / 'stars-m10.npy'}")
    print(f"wrote {database}")
    print(f"wrote {args.static_dir / 'deep-sky.json'}")


if __name__ == "__main__":
    main()
