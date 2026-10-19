import unittest
import os
from pathlib import Path
from datetime import timedelta
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException

import app


class SkyChartChecks(unittest.TestCase):
    def test_milky_way_equator_samples_close_the_loop(self):
        self.assertEqual(len(app.MILKY_WAY_LONGITUDES), 181)
        self.assertAlmostEqual(float(app.MILKY_WAY_RA_HOURS[0]), 17.760, places=3)
        self.assertAlmostEqual(float(app.MILKY_WAY_DEC_DEGREES[0]), -28.936, places=3)
        self.assertAlmostEqual(float(app.MILKY_WAY_RA_HOURS[-1]), float(app.MILKY_WAY_RA_HOURS[0]), places=8)
        self.assertAlmostEqual(float(app.MILKY_WAY_DEC_DEGREES[-1]), float(app.MILKY_WAY_DEC_DEGREES[0]), places=8)

    def test_common_summer_triangle_names_are_primary_labels(self):
        self.assertEqual(app.STAR_NAMES[91262], "织女星")
        self.assertEqual(app.STAR_NAMES[97649], "牛郎星")
        self.assertEqual(app.STAR_NAMES[102098], "天津四")


class AstronomyRegressionChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.astro = app.AstronomyData()
        cls.location = (51.4779, 0.0, 46)
        cls.at = "2026-10-17T07:35:30Z"

    @classmethod
    def tearDownClass(cls):
        cls.astro.eph.close()
        for kernel in cls.astro.satellite_eph.values():
            kernel.close()

    def setUp(self):
        self.astro_patch = patch.object(app, "get_astro", return_value=self.astro)
        self.astro_patch.start()
        self.addCleanup(self.astro_patch.stop)

    def test_greenwich_moon_matches_independent_jpl_horizons(self):
        # Horizons DE441, Greenwich Observatory (0E, 51.4779N, 46 m), airless.
        # Exact 2026-Oct-17 07:35:30 UTC (retrieved 2026-Oct-08).
        sky = app.calculate_sky(*self.location, self.at)
        moon = sky["moon"]
        self.assertAlmostEqual(moon["azimuth"], 65.604071, delta=.005)
        self.assertAlmostEqual(moon["altitude"], -52.151063, delta=.005)
        self.assertAlmostEqual(moon["illumination"], 37.69919, delta=.05)
        self.assertAlmostEqual(moon["magnitude"], -9.409, delta=.03)
        self.assertEqual(app.moon_phase_name(moon["phase"]), "蛾眉月")

    def test_timeline_preview_matches_full_sky_for_each_solar_body(self):
        dates = [self.at, "2026-10-18T07:35:30Z"]
        preview = app.calculate_timeline_preview(*self.location, dates)
        for at, sample in zip(dates, preview["samples"]):
            sky = app.calculate_sky(*self.location, at)
            self.assertEqual(sample["sun_altitude"], sky["sun_altitude"])
            full = {item["id"]: item for item in sky["objects"]}
            for item in sample["objects"]:
                for key, value in item.items():
                    self.assertEqual(value, full[item["id"]][key], (at, item["id"], key))

    def test_48_hour_trail_contains_current_moon_and_both_days(self):
        at = app.parse_datetime(self.at)
        trail = app.calculate_trails(*self.location, (at - timedelta(hours=24)).isoformat(), 2880, 15, "moon", False)
        self.assertEqual(trail["span_minutes"], 2880)
        self.assertEqual(trail["count"], 193)
        self.assertEqual(trail["stars"], [])
        moon = app.calculate_sky(*self.location, self.at)["moon"]
        center = trail["target"]["points"][trail["count"] // 2]
        self.assertAlmostEqual(center[0], moon["azimuth"], delta=.01)
        self.assertAlmostEqual(center[1], moon["altitude"], delta=.01)
        transit = next(row for row in trail["events"]["transit"] if row["time"].startswith("2026-10-17"))
        self.assertGreater(transit["altitude"], 0)
        self.assertLess(transit["altitude"], 90)
        self.assertEqual(len(trail["events"]["transit"]), 2)

    def test_sidebar_and_trail_events_agree(self):
        events = app.calculate_events("moon", *self.location, "2026-10-17T00:00:00Z", "2026-10-18T00:00:00Z")
        trail = app.calculate_trails(*self.location, "2026-10-17T00:00:00Z", 1440, 15, "moon", False)
        for key in ("rise", "transit", "set"):
            self.assertEqual(events[key], trail["events"][key])
        self.assertTrue(events["rise"] and events["set"])
        self.assertLess(events["rise"][0]["time"], events["set"][0]["time"])

    def test_trails_clip_at_both_ephemeris_boundaries(self):
        for start, expected_start, expected_end in (
            (app.MIN_DATE - timedelta(hours=12), app.MIN_DATE, app.MIN_DATE + timedelta(hours=12)),
            (app.MAX_DATE - timedelta(hours=12), app.MAX_DATE - timedelta(hours=12), app.MAX_DATE - timedelta(seconds=1)),
        ):
            trail = app.calculate_trails(*self.location, start.isoformat(), 1440, 15, "moon", False)
            self.assertEqual(app.parse_datetime(trail["start"]), expected_start)
            self.assertEqual(app.parse_datetime(trail["end"]), expected_end)

    def test_events_reject_invalid_or_unbounded_time_windows(self):
        for end in ("2026-10-16T07:35:30Z", "2026-11-17T07:35:30Z"):
            with self.assertRaises(HTTPException) as context:
                app.calculate_events("moon", *self.location, self.at, end)
            self.assertEqual(context.exception.status_code, 422)

    def test_catalog_horizontal_coordinates_match_skyfield_in_both_hemispheres(self):
        dt = app.parse_datetime(self.at)
        t = self.astro.ts.from_datetime(dt)
        for lat, lon in ((51.4779, 0.0), (-33.9, 151.2), (0, -120), (89, 0)):
            for hip in (91262, 97649, 32349):
                star = app.star_target(self.astro, hip)
                row = self.astro.hip_catalog.loc[hip]
                alt, az = app.horizontal_coordinates(
                    np.asarray(row["ra_hours"]), np.asarray(row["dec_degrees"]),
                    row["ra_mas_per_year"], row["dec_mas_per_year"], lat, lon, dt, float(t.gast), t.M,
                )
                exact_alt, exact_az = app.angle_data(app.make_observer(self.astro, lat, lon, 0), star, t)
                self.assertAlmostEqual(float(alt), exact_alt, delta=.03)
                delta_az = (float(az) - exact_az + 180) % 360 - 180
                self.assertAlmostEqual(delta_az, 0, delta=.05)

    def test_calendar_uses_actual_new_moon_time_for_age_and_geometric_illumination(self):
        calendar = app.calculate_moon_calendar(2026, 10, 480)
        new_moon = next(event for event in calendar["events"] if event["type"] == 0)
        day = calendar["days"][16]
        noon = app.parse_datetime("2026-10-17T04:00:00Z")
        self.assertEqual(day["age_days"], round((noon - app.parse_datetime(new_moon["time"])).total_seconds() / 86400, 1))
        self.assertEqual(day["phase_name"], "蛾眉月")
        self.assertEqual(len(calendar["events"]), 4)
        self.assertTrue(all(event["local_date"].startswith("2026-10") for event in calendar["events"]))
        self.assertAlmostEqual(day["illumination"], 36.1, delta=.05)

    def test_principal_phase_names_do_not_cover_multi_day_crescents(self):
        for angle, name in ((0, "新月"), (75.24, "蛾眉月"), (90, "上弦月"), (105, "盈凸月"), (180, "满月"), (225, "亏凸月"), (270, "下弦月"), (310, "残月"), (359, "新月")):
            self.assertEqual(app.moon_phase_name(angle), name)

    @unittest.skipUnless(all((Path(os.getenv("DATA_DIR", "/data"))/item[3]).is_file()
        for item in app.SATELLITE_DEFS if item[3]), "Full natural-satellite ephemerides not installed")
    def test_all_configured_planetary_satellites_have_coordinates(self):
        result = app.calculate_satellite_positions(self.at)
        expected = {item[0] for item in app.SATELLITE_DEFS}
        self.assertEqual({item["id"] for item in result["satellites"]}, expected)
        saturn = [item for item in result["satellites"] if item["parent"] == "saturn"]
        self.assertEqual(len(saturn), 7)
        for item in saturn:
            self.assertTrue(np.isfinite(item["position"]).all())
            self.assertGreater(item["parent_distance_km"], 100_000)
            self.assertLess(item["parent_distance_km"], 4_000_000)


if __name__ == "__main__":
    unittest.main()
