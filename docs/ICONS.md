# StarIsle icons

The original glass star-trail artwork is MIT licensed, like the application.
`assets/icons/source.svg` is the editable vector source; `icon.svg` is the
VectorCraft CLI export. PNG exports were prepared with VectorCraft 0.11.0 and
PhotoCraft 0.9.0 (Lanczos resize). No external image service is needed at runtime.

The approved artwork is shared with the self-hosted local sky chart.
StarIsle keeps its own application name and branding text.

Run `python scripts/generate_icons.py` to restore the approved SVG and PNG files
from `assets/icons/` into `static/`. The script checks SHA256 before writing and
never regenerates the previous artwork. To redesign, edit `source.svg`, export
SVG and PNG at 32, 152, 167, 180, 192 and 512 pixels with your vector/image editor,
update `assets/icons/SHA256.json`, restore files, then update icon query versions
in all three pages, the web manifest and service worker, and bump its cache name.
