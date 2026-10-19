"""Local, historical OMM orbit cache and observer-relative satellite tracks."""
from __future__ import annotations

import json
import logging
import math
import sqlite3
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener
from urllib.error import HTTPError

import numpy as np
from skyfield.api import EarthSatellite, wgs84

log = logging.getLogger("star-chart.satellites")
UTC = timezone.utc
MAX_ORBIT_AGE_DAYS = 7
NAMES = {48274: "中国空间站", 25544: "国际空间站 ISS", 20580: "哈勃空间望远镜"}
SOURCES = {
    "stations": "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=JSON",
    "visual": "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=JSON",
    "hubble": "https://celestrak.org/NORAD/elements/gp.php?CATNR=20580&FORMAT=JSON",
}


def utc_datetime(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


class SatelliteOrbits:
    def __init__(self, directory: Path, ts, eph):
        self.path = directory / "satellite-orbits.sqlite3"
        self.ts, self.eph = ts, eph
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS elements (
                    norad INTEGER NOT NULL, epoch TEXT NOT NULL, name TEXT NOT NULL,
                    payload TEXT NOT NULL, fetched_at TEXT NOT NULL,
                    PRIMARY KEY (norad, epoch)
                );
                CREATE TABLE IF NOT EXISTS downloads (
                    source TEXT PRIMARY KEY, fetched_at TEXT NOT NULL
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def refresh(self):
        """Download at most once per six hours; retain every distinct orbit epoch."""
        now = datetime.now(UTC)
        # The host's shell proxy is not a service dependency. Downloads are public HTTPS.
        opener = build_opener(ProxyHandler({}))
        for source, url in SOURCES.items():
            with self.connect() as db:
                previous = db.execute("SELECT fetched_at FROM downloads WHERE source=?", (source,)).fetchone()
            if previous and now - utc_datetime(previous[0]) < timedelta(hours=6):
                continue
            try:
                request = Request(url, headers={"User-Agent": "StarIsle/0.6 (orbit cache)"})
                with opener.open(request, timeout=20) as response:
                    rows = json.loads(response.read(4_000_000))
                if not isinstance(rows, list) or not rows:
                    raise ValueError("empty orbit response")
                validated = []
                for row in rows:
                    satellite = EarthSatellite.from_omm(self.ts, row)
                    epoch = satellite.epoch.utc_datetime().isoformat()
                    validated.append((satellite.model.satnum, epoch, satellite.name,
                                      json.dumps(row), now.isoformat()))
                with self.connect() as db:
                    db.executemany("INSERT OR REPLACE INTO elements VALUES (?, ?, ?, ?, ?)", validated)
                    db.execute("INSERT OR REPLACE INTO downloads VALUES (?, ?)", (source, now.isoformat()))
                log.info("Cached %s public satellite orbits from %s", len(validated), source)
            except HTTPError as exc:
                log.warning("Satellite download failed (%s); retaining local cache: %s", source, exc)
                if exc.code == 429 or exc.code >= 500:
                    # Stop this refresh round: respect upstream rate limits and outages.
                    break
            except Exception as exc:
                log.warning("Satellite download failed (%s); retaining local cache: %s", source, exc)

    def catalog(self):
        with self.connect() as db:
            rows = db.execute("""
                SELECT norad, name, epoch, payload FROM elements e
                WHERE epoch=(SELECT MAX(epoch) FROM elements WHERE norad=e.norad)
            """).fetchall()
            downloads = [dict(row) for row in db.execute("SELECT * FROM downloads")]
        # Docked station modules/vehicles share the same orbit: expose one marker.
        def orbit_signature(row):
            fields = json.loads(row["payload"])
            return (row["epoch"], *(fields[key] for key in (
                "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE",
                "ARG_OF_PERICENTER", "MEAN_ANOMALY")))

        station_rows = [row for row in rows if row["norad"] in {48274, 25544}]
        station_orbits = {orbit_signature(row) for row in station_rows}
        entries = {number: {"norad": number, "name": name, "epoch": None} for number, name in NAMES.items()}
        for row in rows:
            number = row["norad"]
            if number not in NAMES and (orbit_signature(row) in station_orbits
                                       or number in {36086, 49044, 53239, 54216}):
                continue
            entries[number] = {"norad": number, "name": NAMES.get(number, row["name"]), "epoch": row["epoch"]}
        ordered = sorted(entries.values(), key=lambda x: (x["norad"] not in NAMES,
                         list(NAMES).index(x["norad"]) if x["norad"] in NAMES else x["name"]))
        return {"objects": ordered, "downloads": downloads, "source": "CelesTrak",
                "max_orbit_age_days": MAX_ORBIT_AGE_DAYS}

    def nearest(self, number: int, at: datetime):
        with self.connect() as db:
            row = db.execute("""
                SELECT * FROM elements WHERE norad=?
                ORDER BY ABS(julianday(epoch)-julianday(?)) LIMIT 1
            """, (number, at.isoformat())).fetchone()
        if row is None:
            return None, {"norad": number, "name": NAMES.get(number, f"NORAD {number}"),
                          "reason": "轨道数据尚未下载，请稍后重试"}
        satellite = EarthSatellite.from_omm(self.ts, json.loads(row["payload"]))
        age = abs((at - utc_datetime(row["epoch"])).total_seconds()) / 86400
        metadata = {"norad": number, "name": NAMES.get(number, satellite.name),
                    "epoch": row["epoch"], "orbit_age_days": round(age, 2),
                    "fetched_at": row["fetched_at"], "approximate": age > 2}
        if age > MAX_ORBIT_AGE_DAYS:
            return None, {**metadata, "reason": "该日期没有临近的轨道数据（需在轨道历元前后 7 天内）"}
        return satellite, metadata

    def geometry(self, satellite, observer, times):
        relative = (satellite - observer).at(times)
        alt, az, distance = relative.altaz()
        sunlit = np.asarray(satellite.at(times).is_sunlit(self.eph))
        sun_alt, _, _ = (self.eph["earth"] + observer).at(times).observe(self.eph["sun"]).apparent().altaz()
        altitude, azimuth = np.asarray(alt.degrees), np.asarray(az.degrees) % 360
        visible = (altitude > 0) & sunlit & (np.asarray(sun_alt.degrees) < -6)
        return altitude, azimuth, np.asarray(distance.km), sunlit, visible, np.asarray(sun_alt.degrees)

    def tracks(self, numbers: list[int], at: datetime, lat: float, lon: float, elevation: float):
        observer = wgs84.latlon(lat, lon, elevation_m=elevation)
        start, end = at - timedelta(minutes=10), at + timedelta(minutes=10)
        # 10-second steps, exact requested time at index 60.
        times = self.ts.linspace(self.ts.from_datetime(start), self.ts.from_datetime(end), 121)
        objects, unavailable = [], []
        for number in numbers:
            satellite, metadata = self.nearest(number, at)
            if satellite is None:
                unavailable.append(metadata)
                continue
            try:
                alt, az, distance, sunlit, visible, sun_alt = self.geometry(satellite, observer, times)
                valid = np.isfinite(alt) & np.isfinite(az) & np.isfinite(distance)
                if not valid[60]:
                    raise ValueError("orbit propagation failed")
                objects.append({**metadata, "id": f"sat:{number}", "kind": "人造天体",
                                "altitude": round(float(alt[60]), 3), "azimuth": round(float(az[60]), 3),
                                "distance_km": round(float(distance[60]), 1),
                                "above_horizon": bool(alt[60] > 0), "sunlit": bool(sunlit[60]),
                                "visible": bool(visible[60]), "sun_altitude": round(float(sun_alt[60]), 2),
                                "points": [[round(float(z), 3), round(float(h), 3), bool(lit), bool(vis)]
                                           if ok else None for h, z, lit, vis, ok in zip(alt, az, sunlit, visible, valid)]})
            except Exception as exc:
                log.warning("Satellite propagation failed (%s): %s", number, exc)
                unavailable.append({**metadata, "reason": "该时刻轨道无法计算"})
        return {"at": at.isoformat(), "start": start.isoformat(), "end": end.isoformat(),
                "step_seconds": 10, "objects": objects, "unavailable": unavailable,
                "location": {"lat": lat, "lon": lon, "elevation": elevation}}

    def passes(self, number: int, at: datetime, lat: float, lon: float, elevation: float):
        satellite, metadata = self.nearest(number, at)
        if satellite is None:
            return {"target": metadata, "passes": [], "unavailable": metadata["reason"]}
        observer = wgs84.latlon(lat, lon, elevation_m=elevation)
        end = min(at + timedelta(hours=48), utc_datetime(metadata["epoch"]) + timedelta(days=MAX_ORBIT_AGE_DAYS))
        start = at - timedelta(minutes=30)
        times, flags = satellite.find_events(observer, self.ts.from_datetime(start),
                                            self.ts.from_datetime(end), altitude_degrees=10)
        intervals, rise = [], start
        for ti, flag in zip(times, flags):
            moment = ti.utc_datetime()
            if flag == 0:
                rise = moment
            elif flag == 2:
                if rise is not None:
                    intervals.append((rise, moment))
                rise = None
        if rise is not None and rise < end:
            intervals.append((rise, end))
        passes = []
        for rise, setting in intervals:
            if setting <= at:
                continue
            first = max(rise, at)
            count = max(2, math.ceil((setting - first).total_seconds() / 10) + 1)
            sample_times = self.ts.linspace(self.ts.from_datetime(first), self.ts.from_datetime(setting), count)
            alt, az, _, sunlit, visible, _ = self.geometry(satellite, observer, sample_times)
            good = np.flatnonzero(visible & (alt >= 10) & np.isfinite(alt) & np.isfinite(az))
            # Split sunlight windows so a dark gap never appears as a continuous visible pass.
            for block in np.split(good, np.flatnonzero(np.diff(good) > 1) + 1):
                if len(block) < 2:
                    continue
                peak = int(block[np.argmax(alt[block])])
                pack = lambda i: {"time": sample_times[int(i)].utc_datetime().isoformat(),
                                  "azimuth": round(float(az[i]), 2), "altitude": round(float(alt[i]), 2)}
                passes.append({"start": pack(int(block[0])), "peak": pack(peak), "end": pack(int(block[-1]))})
        return {"target": metadata, "start": at.isoformat(), "end": end.isoformat(),
                "passes": passes[:8], "min_altitude": 10, "sun_altitude_limit": -6}
