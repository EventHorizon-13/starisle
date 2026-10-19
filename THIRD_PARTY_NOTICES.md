# Third-party sources and notices

Application code is MIT. The following data and assets keep their own terms. Redistribution must retain this document, CATALOG_LICENSES.md and applicable license texts. Docker images include these files under `/app`.

| Asset | Source / credit | Terms and local changes |
|---|---|---|
| `static/deep-sky.json`, OpenNGC rows in generated `catalog.sqlite3` | Mattia Verga, [OpenNGC v20260501](https://github.com/mattiaverga/OpenNGC/tree/v20260501) | CC BY-SA 4.0. Fields selected, names normalized, invalid/duplicate objects filtered, search indices and JSON generated. |
| Generated `stars-m10.npy` and AT-HYG rows in `catalog.sqlite3` | David Nash, [AT-HYG v3.2](https://github.com/astronexus/ATHYG-Database), current upstream [Codeberg](https://codeberg.org/astronexus/athyg) | CC BY-SA 4.0. Magnitude-10 subset, fields selected, NumPy and SQLite converted. See `LICENSES/AT-HYG-ACKNOWLEDGMENTS.md` for underlying catalogues. |
| `static/moon-nasa-clementine.jpg` | [NASA/GSFC Clementine — The Moon](https://science.nasa.gov/image-detail/amf-gsfc_20171208_archive_e001982/), original [JPEG](https://images-assets.nasa.gov/image/GSFC_20171208_Archive_e001982/GSFC_20171208_Archive_e001982~orig.jpg) | Local rendering uses a resized/cropped Moon texture with a phase mask. Retain source credit and follow [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/). Not MIT. |
| `static/moon-nasa-lro.jpg` | [NASA Scientific Visualization Studio — Moon Mosaic, ID 5001](https://svs.gsfc.nasa.gov/5001/), original [JPEG](https://svs.gsfc.nasa.gov/vis/a000000/a005000/a005001/moon_mosaic_print.jpg) | Derived local image; NASA's Scientific Visualization Studio / LRO. Follow NASA media guidelines. Not MIT. |
| Planetary and natural-satellite `.bsp` files | [JPL Solar System Dynamics](https://ssd.jpl.nasa.gov/) / [NAIF generic kernels](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/) | Upstream scientific data. Downloaded separately, not application code. Cite JPL SSD, download date and kernel filename; retain kernel comments and upstream notices. |
| `hip_main.dat` | ESA Hipparcos catalogue, [CDS I/239](https://cdsarc.cds.unistra.fr/ftp/cats/I/239/) | Downloaded separately through Skyfield/CDS; cite ESA (1997), The Hipparcos and Tycho Catalogues, ESA SP-1200. No MIT claim. |
| Earth-orientation tables | [IERS](https://www.iers.org/), through Skyfield | Bundled Skyfield tables by default; optional online update. Retain source citation. |
| Artificial-satellite orbit cache | [CelesTrak GP/OMM](https://celestrak.org/NORAD/documentation/gp-data-formats.php) | Runtime download; production orbit history is not distributed. Respect [usage policy](https://celestrak.org/usage-policy.php), cached 6-hour requests, and stop a refresh round on 429/5xx. No blanket MIT/CC claim for these data. |
| `static/small-bodies.json` | [NASA/JPL SBDB API](https://ssd-api.jpl.nasa.gov/doc/sbdb.html) | Small selected orbital-element snapshot, approximated with a two-body model; retain source and epoch metadata. |
| `static/messier.json` | Messier/NGC identifiers and coordinates used by this project | OpenNGC-derived coordinates and catalogue fields; CC BY-SA 4.0. |

Python dependencies are installed from their own distributions, retaining package license files: FastAPI and Skyfield (MIT), Uvicorn, NumPy and pandas (BSD-3-Clause), and their transitive dependencies. Inspect installed package metadata for the exact distribution notices. The Python/Debian base image also retains its upstream notices. `LICENSES/CC-BY-SA-4.0.txt` contains the Creative Commons license text.

NASA names, agency logos and dataset names do not grant a right to imply endorsement. Scientific data availability does not make all third-party assets MIT licensed.
