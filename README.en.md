# StarIsle

A mobile-friendly, self-hosted sky chart with a Chinese interface, powered by Skyfield and JPL ephemerides. Includes a sky map, catalogue search, Solar System, Moon calendar, artificial-satellite tracks and visible passes.

[中文文档](README.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## Why StarIsle

StarIsle is for people who want to host a Chinese-language observing tool on their own server, NAS or LAN, and share it through a mobile browser. Its focus is the combination of:

- **Chinese object search** with supported Chinese star names, English aliases and catalogue identifiers, including explicit component names such as Alpha Centauri A/B. Name coverage is incomplete; this is not a complete Chinese sky-culture catalogue.
- **Everyday observing in one application**: sky positions and daily rise/set times, a Solar System view, and a Moon calendar with key phase times.
- **Space-station observing**: Chinese Space Station, ISS, Hubble and other public targets, with tracks and visible-pass predictions for the next 48 hours. Filtering considers solar altitude, illumination and elevation; orbit freshness, weather and obstructions still matter.
- **Operator-managed data and privacy**: Compose deployment, checksum-pinned basic/full initialization, and optional runtime download restrictions. Preferences stay in the browser; coordinates go to your own calculation server. No third-party analytics integration.
- **A mobile interface backed by server calculations**: touch controls and home-screen installation, with Skyfield/JPL computations on your server. Offline operation means no external downloads after preparation; the browser still needs access to that server.

### How it relates to similar projects

This compares project focus and deployment style, not exclusive feature ownership. Other projects may offer overlapping capabilities.

| Project | Official focus | StarIsle's focus |
|---|---|---|
| [Stellarium Web](https://stellarium-labs.com/stellarium-web/) | An online planetarium in the browser | A self-hosted application with Compose and data initialization, combining Chinese search, a Moon calendar and space-station passes. |
| [Stellarium Web Engine](https://github.com/Stellarium/stellarium-web-engine) | A JavaScript planetarium engine | A ready-to-deploy Python/Skyfield backend and mobile interface for users who want a complete application. |
| [VirtualSky](https://github.com/slowe/VirtualSky) | A customizable, embeddable browser planetarium | A standalone application combining sky, Solar System, Moon and satellite views, with documented local ephemeris, catalogue and orbit-cache maintenance. |

These distinctions describe official project positioning and this candidate's feature combination. They do not establish superior accuracy, catalogue size or rendering. Check the calculation limits in the Chinese README before relying on the application for precise observations.

## Quick start

Requires Docker and Docker Compose. From this project's directory:

```sh
cp .env.example .env
docker compose build
docker compose run --rm --no-deps starisle python scripts/init_data.py --profile basic
docker compose up -d
```

Open `http://localhost:18080`. The default binding is loopback. Set `BIND_ADDRESS=0.0.0.0` in `.env` for LAN access. Browser geolocation requires HTTPS; coordinates can also be entered manually.

For full magnitude-10 stars, indexed catalogue search and natural-satellite ephemerides:

```sh
docker compose stop starisle
docker compose run --rm --no-deps starisle python scripts/init_data.py --profile full
docker compose up -d
```

Basic data downloads are approximately 165 MiB. Full astronomy files total roughly 3 GiB; allow at least 5 GiB for source caches and catalogue construction. Downloads are size/SHA256 pinned and published atomically. Stop your instance before replacing catalogue files. See [data details](docs/DATA.md).

Once a public image has been published, set `STARISLE_IMAGE` to its actual Docker Hub name and version, omit the build step, and use `docker compose up -d --no-build`. No public image name is claimed in this prepared release.

## Offline operation and privacy

Set `OFFLINE=true` after data initialization to disable runtime downloads. `IERS_UPDATE=false` uses Skyfield's bundled time tables by default. Artificial-satellite forecasts require recent OMM data; historical coverage starts when your instance begins collecting it.

Location preferences stay in the browser, but coordinates are sent to your self-hosted server for calculations. There is no third-party analytics integration. The application has no user accounts; configure HTTPS and access controls as required for your deployment.

## Testing

```sh
DATA_DIR=./data OFFLINE=true python -m unittest discover -s tests -p 'test_*.py'
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [release preparation](docs/RELEASING.md) and the Chinese README for feature limitations and maintenance.

## License

Application code and original icons: MIT. OpenNGC/AT-HYG derived catalogues: CC BY-SA 4.0. Imagery, astronomy data and dependencies retain their respective terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
