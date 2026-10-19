# Contributing

Discuss substantial changes in an issue first. Keep the mobile Chinese interface usable and preserve upstream data attribution.

Run `python -m unittest discover -s tests -p 'test_*.py'`. Astronomy regression tests need basic data; run with `DATA_DIR=./data OFFLINE=true` after initialization. Download-helper tests use mocked HTTP and require no astronomy data. Browser checks under `scripts/check_*.cjs` require Playwright and a running instance; set `STAR_CHART_URL` to your test URL.

Include reproducible steps, location/time inputs and expected behavior with astronomy bug reports. Do not submit private locations, secrets or live runtime databases. Code contributions are under MIT; derived data must preserve their upstream terms.
