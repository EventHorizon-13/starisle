"""Orbit cache, visibility and historical-date regression checks (no network)."""
import io
import json
import tempfile
import os
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import numpy as np
from skyfield.api import EarthSatellite, load, load_file, wgs84

from earth_satellites import SatelliteOrbits, SOURCES


# Public CelesTrak CSS record retrieved 2026-10-05. Used only as a test fixture.
CSS = {
    "OBJECT_NAME": "CSS (TIANHE)", "OBJECT_ID": "2021-035A", "EPOCH": "2026-10-04T13:21:19.026144",
    "MEAN_MOTION": 15.60294609, "ECCENTRICITY": 0.00018267, "INCLINATION": 41.4702,
    "RA_OF_ASC_NODE": 17.8118, "ARG_OF_PERICENTER": 329.3971, "MEAN_ANOMALY": 30.6761,
    "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U", "NORAD_CAT_ID": 48274,
    "ELEMENT_SET_NO": 999, "REV_AT_EPOCH": 31024, "BSTAR": 0.00020933378,
    "MEAN_MOTION_DOT": 0.0001731, "MEAN_MOTION_DDOT": 0,
}
AT = datetime(2026, 10, 4, 12, 20, tzinfo=timezone.utc)


class SatelliteChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ts = load.timescale()
        cls.eph = load_file(str(Path(os.getenv("DATA_DIR", "/data")) / "de440.bsp"))

    @classmethod
    def tearDownClass(cls):
        cls.eph.close()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = SatelliteOrbits(Path(self.directory.name), self.ts, self.eph)

    def download(self, rows):
        with patch("earth_satellites.build_opener") as factory:
            factory.return_value.open.side_effect = lambda *args, **kwargs: io.BytesIO(json.dumps(rows).encode())
            self.store.refresh()
            return factory.return_value.open.call_count

    def test_refresh_is_cached_and_failure_preserves_history(self):
        self.assertEqual(self.download([CSS]), len(SOURCES))
        self.assertEqual(self.download([CSS]), 0)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM elements").fetchone()[0], 1)
            db.execute("DELETE FROM downloads")
        with patch("earth_satellites.build_opener") as factory:
            factory.return_value.open.side_effect = OSError("offline")
            self.store.refresh()
        self.assertIsNotNone(self.store.nearest(48274, AT)[0])

    def test_upstream_rate_limit_or_outage_stops_refresh_round(self):
        for code in (429, 503):
            with self.subTest(code=code):
                with patch("earth_satellites.build_opener") as factory:
                    factory.return_value.open.side_effect = HTTPError("https://example.invalid", code, "retry later", {}, None)
                    self.store.refresh()
                    self.assertEqual(factory.return_value.open.call_count, 1)

    def test_nearest_historical_epoch_and_out_of_range(self):
        self.download([CSS, {**CSS, "EPOCH": "2026-09-04T13:21:19.026144"}])
        satellite, metadata = self.store.nearest(48274, AT - timedelta(days=30))
        self.assertIsNotNone(satellite)
        self.assertTrue(metadata["epoch"].startswith("2026-09-04"))
        satellite, metadata = self.store.nearest(48274, AT - timedelta(days=15))
        self.assertIsNone(satellite)
        self.assertIn("7 天", metadata["reason"])
        self.assertEqual(len(self.store.tracks([48274], AT - timedelta(days=15), 31.23, 121.47, 0)["objects"]), 0)

    def test_catalog_deduplicates_docked_modules(self):
        self.download([CSS, {**CSS, "OBJECT_NAME": "CSS (WENTIAN)", "NORAD_CAT_ID": 53239},
                       {**CSS, "OBJECT_NAME": "TIANZHOU DOCKED", "NORAD_CAT_ID": 69049},
                       {**CSS, "OBJECT_NAME": "UNRELATED SATELLITE", "NORAD_CAT_ID": 12345, "INCLINATION": 51}])
        catalog = self.store.catalog()["objects"]
        self.assertEqual(catalog[0]["name"], "中国空间站")
        self.assertNotIn(53239, [entry["norad"] for entry in catalog])
        self.assertNotIn(69049, [entry["norad"] for entry in catalog])
        self.assertIn(12345, [entry["norad"] for entry in catalog])

    def test_track_uses_observer_position_and_exact_center_second(self):
        self.download([CSS])
        at = AT + timedelta(seconds=37)
        track = self.store.tracks([48274], at, 31.23, 121.47, 12)["objects"][0]
        satellite = EarthSatellite.from_omm(self.ts, CSS)
        observer = wgs84.latlon(31.23, 121.47, elevation_m=12)
        t = self.ts.from_datetime(at)
        alt, az, distance = (satellite - observer).at(t).altaz()
        self.assertAlmostEqual(track["altitude"], alt.degrees, delta=.001)
        self.assertAlmostEqual(track["azimuth"], az.degrees, delta=.001)
        self.assertAlmostEqual(track["distance_km"], distance.km, delta=.1)
        self.assertEqual(len(track["points"]), 121)
        self.assertEqual(track["points"][60][:2], [track["azimuth"], track["altitude"]])
        self.assertEqual(track["sunlit"], bool(satellite.at(t).is_sunlit(self.eph)))
        changed = self.store.tracks([48274], at, 39.90, 116.40, 12)["objects"][0]
        self.assertGreater(abs(changed["altitude"] - track["altitude"]), 1)

    def test_missing_satellite_does_not_hide_available_one(self):
        self.download([CSS])
        data = self.store.tracks([48274, 999999], AT, 31.23, 121.47, 0)
        self.assertEqual([item["norad"] for item in data["objects"]], [48274])
        self.assertEqual([item["norad"] for item in data["unavailable"]], [999999])
        json.dumps(data, allow_nan=False)

    def test_visible_passes_are_dark_sunlit_and_above_ten_degrees(self):
        self.download([CSS])
        tested = 0
        for lat, lon in [(31.23, 121.47), (39.90, 116.40), (30.67, 104.06), (22.54, 114.06)]:
            data = self.store.passes(48274, AT, lat, lon, 0)
            satellite = EarthSatellite.from_omm(self.ts, CSS)
            observer = wgs84.latlon(lat, lon)
            for row in data["passes"]:
                tested += 1
                self.assertLessEqual(row["start"]["time"], row["peak"]["time"])
                self.assertLessEqual(row["peak"]["time"], row["end"]["time"])
                for point in row.values():
                    moment = datetime.fromisoformat(point["time"])
                    self.assertGreaterEqual(moment, AT)
                    self.assertLessEqual(moment, AT + timedelta(hours=48))
                    t = self.ts.from_datetime(moment)
                    alt, _, _ = (satellite - observer).at(t).altaz()
                    sun_alt, _, _ = (self.eph["earth"] + observer).at(t).observe(self.eph["sun"]).apparent().altaz()
                    self.assertGreaterEqual(alt.degrees, 9.999)
                    self.assertLess(sun_alt.degrees, -6)
                    self.assertTrue(satellite.at(t).is_sunlit(self.eph))
            if tested:
                break
        self.assertGreater(tested, 0, "fixture should include at least one visible pass")


if __name__ == "__main__":
    unittest.main()
