from __future__ import annotations

import logging
import asyncio
import math
import os
import json
import re
import sqlite3
import unicodedata
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.gzip import GZipMiddleware
from skyfield.api import Loader, Star, wgs84
from skyfield.data import hipparcos
from skyfield.magnitudelib import planetary_magnitude
from skyfield import almanac
from earth_satellites import SatelliteOrbits


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("star-chart")

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
OFFLINE = os.getenv("OFFLINE", "false").lower() in {"1", "true", "yes"}
IERS_UPDATE = os.getenv("IERS_UPDATE", "false").lower() in {"1", "true", "yes"}
EPHEMERIS_URL = os.getenv(
    "EPHEMERIS_URL",
    "https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440.bsp",
)
MIN_DATE = datetime(1550, 1, 1, tzinfo=timezone.utc)
MAX_DATE = datetime(2650, 1, 26, tzinfo=timezone.utc)
STAR_LIMIT = float(os.getenv("STAR_LIMIT", "6.2"))
DEEP_STAR_LIMIT = float(os.getenv("DEEP_STAR_LIMIT", "10.0"))
TRAIL_STAR_MAG = float(os.getenv("TRAIL_STAR_MAG", "4.5"))
# skyfield 的 planetary_magnitude 支持到海王星；太阳用常数，月球用近似公式。
MAGNITUDE_BODIES = frozenset({"mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune"})
SUN_MAGNITUDE = -26.74

MESSIER_TYPE_NAMES = {
    "*": "恒星", "Nova": "新星", "GPair": "星系对", "GTrpl": "三重星系",
    "GGroup": "星系群", "DrkN": "暗星云",
    "G": "星系", "GCl": "球状星团", "OCl": "疏散星团", "PN": "行星状星云",
    "SNR": "超新星遗迹", "HII": "电离氢区", "Neb": "星云", "EmN": "发射星云",
    "RfN": "反射星云", "Cl+N": "星团与星云", "*Ass": "星协", "**": "双星",
    "Other": "星群",
}

GREEK_BAYER = {
    "Alp": "α", "Bet": "β", "Gam": "γ", "Del": "δ", "Eps": "ε", "Zet": "ζ",
    "Eta": "η", "The": "θ", "Iot": "ι", "Kap": "κ", "Lam": "λ", "Mu": "μ",
    "Nu": "ν", "Xi": "ξ", "Omi": "ο", "Pi": "π", "Rho": "ρ", "Sig": "σ",
    "Tau": "τ", "Ups": "υ", "Phi": "φ", "Chi": "χ", "Psi": "ψ", "Ome": "ω",
}
MESSIER_CHINESE_NAMES = {
    1: "蟹状星云", 6: "蝴蝶星团", 7: "托勒密星团", 8: "礁湖星云", 11: "野鸭星团",
    13: "武仙座大星团", 16: "鹰状星云", 17: "欧米伽星云", 20: "三裂星云",
    27: "哑铃星云", 31: "仙女座星系", 33: "三角座星系", 42: "猎户座大星云",
    43: "德梅兰星云", 44: "蜂巢星团", 45: "昴星团", 51: "涡状星系",
    57: "环状星云", 63: "向日葵星系", 64: "黑眼星系", 76: "小哑铃星云",
    81: "波德星系", 82: "雪茄星系", 83: "南风车星系", 87: "室女座 A 星系",
    97: "猫头鹰星云", 101: "风车星系", 102: "纺锤星系", 104: "草帽星系",
}


# 亮星用中文名显示；英文专名放在别名里，只在详情和搜索中使用。
# 其余恒星仍可用 Hipparcos 编号检索。
STAR_NAMES: dict[int, str] = {
    32349: "天狼星", 30438: "老人星", 69673: "大角星", 91262: "织女星",
    24608: "五车二", 24436: "参宿七", 37279: "南河三", 27989: "参宿四",
    7588: "水委一", 68702: "马腹一", 97649: "牛郎星", 60718: "十字架二",
    21421: "毕宿五", 80763: "心宿二", 65474: "角宿一", 37826: "北河三",
    113368: "北落师门", 102098: "天津四", 49669: "轩辕十四", 36850: "北河二",
    25336: "参宿五", 25428: "五车五", 26311: "参宿二", 26727: "参宿一",
    25930: "参宿三", 27366: "参宿六", 11767: "勾陈一（北极星）", 15863: "天船三",
    14576: "大陵五", 65378: "开阳", 65477: "辅", 54061: "天枢",
    53910: "天璇", 62956: "玉衡", 67301: "摇光", 72607: "帝",
    3179: "王良四", 746: "王良一", 6686: "王良二", 4427: "王良三", 8886: "阁道三",
    105199: "仙王座α", 107315: "危宿三", 113963: "室宿一", 113881: "室宿二",
    677: "壁宿二", 9884: "娄宿三", 78401: "房宿三", 85927: "尾宿八",
    90185: "箕宿三", 86032: "候", 82273: "三角形南一", 61084: "十字架三",
    62434: "十字架四", 44816: "船帆座λ", 72622: "氐宿一", 74785: "氐宿四",
    100453: "天鹅座γ", 95947: "辇道增七", 92855: "斗宿四",
    84345: "帝座", 109074: "危宿一", 106278: "虚宿一", 3419: "土司空",
    10826: "刍藁增二", 9640: "天大将军一", 35550: "天樽二", 28360: "五车一",
    5447: "天大将军二", 57632: "五帝座一", 58001: "天玑", 59774: "天权",
    50583: "轩辕十二", 54872: "太微右垣五", 54879: "太微右垣四",
    102488: "天鹅座ε", 104060: "天鹅座ξ",
    86228: "尾宿五",
    # Chinese designations checked against Stellarium 26.3 Chinese sky culture.
    71683: '南门二A',
    71681: '南门二B',
    70890: '比邻星',
    87937: '巴纳德星',
    39953: '天社一',
    41037: '海石一',
    33579: '弧矢七',
    100751: '孔雀十一',
    45238: '南船五',
}

STAR_ALIASES: dict[int, str] = {
    32349: "Sirius · Sirius A · 天狼星A", 30438: "Canopus", 69673: "Arcturus", 91262: "Vega · 织女一",
    24608: "Capella", 24436: "Rigel", 37279: "Procyon · Procyon A · 南河三A", 27989: "Betelgeuse",
    7588: "Achernar", 68702: "Hadar", 97649: "Altair · 河鼓二", 60718: "Acrux",
    21421: "Aldebaran", 80763: "Antares", 65474: "Spica", 37826: "Pollux",
    113368: "Fomalhaut", 102098: "Deneb", 49669: "Regulus", 36850: "Castor",
    25336: "Bellatrix", 25428: "Elnath", 26311: "Alnilam", 26727: "Alnitak",
    25930: "Mintaka", 27366: "Saiph", 11767: "Polaris", 15863: "Mirfak",
    14576: "Algol", 65378: "Mizar", 65477: "Alcor", 54061: "Dubhe",
    53910: "Merak", 58001: "Phecda", 59774: "Megrez", 62956: "Alioth",
    67301: "Alkaid", 72607: "Kochab", 3179: "Caph", 746: "Schedar",
    4427: "Ruchbah", 8886: "Segin", 105199: "Alderamin", 107315: "Enif",
    113963: "Markab", 113881: "Scheat", 677: "Alpheratz", 9884: "Hamal",
    78401: "Dschubba", 85927: "Shaula", 90185: "Kaus Australis",
    86032: "Rasalhague", 82273: "Atria", 61084: "Mimosa", 62434: "Gacrux",
    44816: "Suhail", 72622: "Zubenelgenubi", 74785: "Zubeneschamali",
    100453: "Sadr", 95947: "Albireo", 92855: "Nunki", 84345: "Rasalgethi",
    109074: "Sadalmelik", 106278: "Sadalsuud", 3419: "Diphda",
    10826: "Mira", 9640: "Almach", 35550: "Wasat", 28360: "Hassaleh",
    5447: "Mirach", 57632: "Denebola", 50583: "Algieba", 54872: "Zosma",
    54879: "Chertan", 102488: "Aljanah", 86228: "Sargas",
    # Chinese designations checked against Stellarium 26.3 Chinese sky culture.
    71683: 'Rigil Kentaurus · Alpha Centauri A · α Centauri A · 半人马座αA · 南门二 · 南门二甲',
    71681: 'Toliman · Alpha Centauri B · α Centauri B · 半人马座αB · 南门二 · 南门二乙',
    70890: 'Proxima Centauri · Alpha Centauri C · 半人马座αC · 南门二C',
    87937: "Barnard's Star · Barnard Star",
    39953: 'Regor · Gamma Velorum · 船帆座γ2',
    41037: 'Avior · 船底座ε',
    33579: 'Adhara · 大犬座ε',
    100751: 'Peacock · 孔雀座α',
    45238: 'Miaplacidus · 船底座β',
}

# IAU J2000 银河坐标到赤道坐标的旋转矩阵。银河背景只取银道面中心线，
# 前端以柔边宽线绘制，不参与天体命中、标签避让或星点绘制。
GALACTIC_TO_EQUATORIAL = np.asarray([
    [-0.0548755604, 0.4941094279, -0.8676661490],
    [-0.8734370902, -0.4448296300, -0.1980763734],
    [-0.4838350155, 0.7469822445, 0.4559837762],
])
MILKY_WAY_LONGITUDES = np.arange(0.0, 360.1, 2.0)
_milky_way_radians = np.radians(MILKY_WAY_LONGITUDES)
_milky_way_galactic = np.stack((
    np.cos(_milky_way_radians),
    np.sin(_milky_way_radians),
    np.zeros_like(_milky_way_radians),
))
_milky_way_equatorial = GALACTIC_TO_EQUATORIAL @ _milky_way_galactic
MILKY_WAY_RA_HOURS = np.degrees(np.arctan2(_milky_way_equatorial[1], _milky_way_equatorial[0])) % 360.0 / 15.0
MILKY_WAY_DEC_DEGREES = np.degrees(np.arcsin(np.clip(_milky_way_equatorial[2], -1.0, 1.0)))

BODY_DEFS = [
    ("sun", "太阳", "sun", "恒星"),
    ("moon", "月球", "moon", "卫星"),
    ("mercury", "水星", "mercury", "行星"),
    ("venus", "金星", "venus", "行星"),
    ("mars", "火星", "mars barycenter", "行星"),
    ("jupiter", "木星", "jupiter barycenter", "行星"),
    ("saturn", "土星", "saturn barycenter", "行星"),
    ("uranus", "天王星", "uranus barycenter", "行星"),
    ("neptune", "海王星", "neptune barycenter", "行星"),
    ("pluto", "冥王星", "pluto barycenter", "矮行星"),
]

# Planetary satellites are supplied by JPL SPK files stored alongside DE440.
# The Moon is already present in DE440; the other kernels are loaded only when
# their corresponding local files are available.
SATELLITE_DEFS = [
    ("moon", "月球", "earth", None, 301, 399),
    ("phobos", "火卫一", "mars", "mar099s.bsp", 401, 499),
    ("deimos", "火卫二", "mars", "mar099s.bsp", 402, 499),
    ("io", "木卫一 · 伊奥", "jupiter", "jup365.bsp", 501, 599),
    ("europa", "木卫二 · 欧罗巴", "jupiter", "jup365.bsp", 502, 599),
    ("ganymede", "木卫三 · 盖尼米得", "jupiter", "jup365.bsp", 503, 599),
    ("callisto", "木卫四 · 卡利斯托", "jupiter", "jup365.bsp", 504, 599),
    ("mimas", "土卫一 · 米玛斯", "saturn", "sat441l.bsp", 601, 699),
    ("enceladus", "土卫二 · 恩克拉多斯", "saturn", "sat441l.bsp", 602, 699),
    ("tethys", "土卫三 · 忒提斯", "saturn", "sat441l.bsp", 603, 699),
    ("dione", "土卫四 · 狄俄涅", "saturn", "sat441l.bsp", 604, 699),
    ("rhea", "土卫五 · 瑞亚", "saturn", "sat441l.bsp", 605, 699),
    ("titan", "土卫六 · 泰坦", "saturn", "sat441l.bsp", 606, 699),
    ("iapetus", "土卫八 · 伊阿珀托斯", "saturn", "sat441l.bsp", 608, 699),
    ("miranda", "天卫一 · 米兰达", "uranus", "ura182.bsp", 705, 799),
    ("ariel", "天卫二 · 艾莉尔", "uranus", "ura182.bsp", 701, 799),
    ("umbriel", "天卫三 · 翁布里尔", "uranus", "ura182.bsp", 702, 799),
    ("titania", "天卫四 · 泰坦妮亚", "uranus", "ura182.bsp", 703, 799),
    ("oberon", "天卫五 · 奥伯龙", "uranus", "ura182.bsp", 704, 799),
    ("triton", "海卫一 · 特里同", "neptune", "nep097.bsp", 801, 899),
    ("charon", "冥卫一 · 卡戎", "pluto", "plu060.bsp", 901, 999),
]
AU_KM = 149_597_870.7
PAST_FRACTION = 0.2


class AstronomyData:
    def __init__(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.loader = Loader(str(DATA_DIR), verbose=False)
        if OFFLINE:
            for filename in (Path(EPHEMERIS_URL).name, "hip_main.dat"):
                if not (DATA_DIR / filename).is_file():
                    raise RuntimeError(f"Missing {filename}; run scripts/init_data.py before offline startup")
        log.info("Loading JPL ephemeris from %s", EPHEMERIS_URL)
        self.eph = self.loader(EPHEMERIS_URL)
        try:
            self.ts = self.loader.timescale(builtin=OFFLINE or not IERS_UPDATE)
            log.info("Loaded Earth-orientation tables (update=%s)", IERS_UPDATE and not OFFLINE)
        except Exception as exc:  # works offline with the bundled tables
            log.warning("Could not update IERS tables; using bundled tables: %s", exc)
            self.ts = self.loader.timescale()
        log.info("Loading Hipparcos star catalogue")
        with self.loader.open(hipparcos.URL) as f:
            hip_catalog = hipparcos.load_dataframe(f)
        hip_catalog = hip_catalog[hip_catalog["ra_degrees"].notnull() & hip_catalog["dec_degrees"].notnull()]
        hip_catalog = hip_catalog[hip_catalog["magnitude"].notnull()].copy()
        for key in ("ra_mas_per_year", "dec_mas_per_year", "parallax_mas", "radial_km_per_s"):
            if key in hip_catalog.columns:
                hip_catalog[key] = hip_catalog[key].fillna(0.0)
        self.hip_catalog = hip_catalog
        catalog = hip_catalog[hip_catalog["magnitude"] <= STAR_LIMIT].copy()
        self.catalog = catalog.sort_values("magnitude")
        self.hip_ids = self.catalog.index.to_numpy(dtype=int)
        self.magnitudes = self.catalog["magnitude"].to_numpy(dtype=float)
        self.stars = Star.from_dataframe(self.catalog)
        self.messier_catalog = json.loads((STATIC_DIR / "messier.json").read_text(encoding="utf-8"))
        self.small_body_catalog = json.loads((STATIC_DIR / "small-bodies.json").read_text(encoding="utf-8"))
        deep_sky_path = DATA_DIR / "deep-sky.json"
        if not deep_sky_path.is_file():
            deep_sky_path = STATIC_DIR / "deep-sky.json"
        deep_sky_payload = json.loads(deep_sky_path.read_text(encoding="utf-8")) if deep_sky_path.is_file() else {"objects": []}
        self.deep_sky_catalog = deep_sky_payload["objects"]
        self.deep_sky_source = {
            key: deep_sky_payload.get(key) for key in ("source", "source_version", "license", "generated")
        }
        self.deep_sky_by_id = {item["id"]: item for item in self.deep_sky_catalog}
        self.deep_sky_ra = np.asarray([item["ra_hours"] for item in self.deep_sky_catalog], dtype=float)
        self.deep_sky_dec = np.asarray([item["dec_degrees"] for item in self.deep_sky_catalog], dtype=float)
        self.deep_sky_mag = np.asarray([
            item["magnitude"] if item.get("magnitude") is not None else np.nan
            for item in self.deep_sky_catalog
        ], dtype=float)
        self.deep_sky_size = np.asarray([
            item["major_arcmin"] if item.get("major_arcmin") is not None else 0.0
            for item in self.deep_sky_catalog
        ], dtype=float)
        self.catalog_db_path = DATA_DIR / "catalog.sqlite3"
        star_field_path = DATA_DIR / "stars-m10.npy"
        self.star_field = np.load(star_field_path, mmap_mode="r") if star_field_path.is_file() else None
        self.hip_metadata: dict[int, dict[str, Any]] = {}
        if self.catalog_db_path.is_file():
            with sqlite3.connect(self.catalog_db_path) as connection:
                connection.row_factory = sqlite3.Row
                for row in connection.execute(
                    "SELECT * FROM stars WHERE hip IS NOT NULL AND mag <= ?", (STAR_LIMIT + 0.3,)
                ):
                    self.hip_metadata[int(row["hip"])] = dict(row)
        self.messier_stars = Star(
            ra_hours=np.asarray([item["ra_hours"] for item in self.messier_catalog]),
            dec_degrees=np.asarray([item["dec_degrees"] for item in self.messier_catalog]),
        )
        self.messier_targets = {
            f"messier:{item['number']}": Star(ra_hours=item["ra_hours"], dec_degrees=item["dec_degrees"])
            for item in self.messier_catalog
        }
        self.bodies: dict[str, tuple[str, Any, str]] = {}
        for target_id, label, key, kind in BODY_DEFS:
            try:
                self.bodies[target_id] = (label, self.eph[key], kind)
            except KeyError:
                log.warning("Ephemeris does not include %s", key)
        self.satellite_eph: dict[str, Any] = {}
        for filename in sorted({item[3] for item in SATELLITE_DEFS if item[3]}):
            path = DATA_DIR / filename
            if not path.is_file():
                log.info("Optional satellite ephemeris is not installed: %s", path)
                continue
            try:
                self.satellite_eph[filename] = self.loader(str(path))
                log.info("Loaded satellite ephemeris %s", path)
            except Exception as exc:
                log.warning("Could not load satellite ephemeris %s: %s", path, exc)
        log.info(
            "Ready: %s bright stars, %s field stars, %s deep-sky objects, %s solar-system targets",
            len(self.hip_ids), len(self.star_field) if self.star_field is not None else 0,
            len(self.deep_sky_catalog), len(self.bodies),
        )


astro: AstronomyData | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global astro
    await run_in_threadpool(_initialize)
    updater = asyncio.create_task(update_satellite_orbits())
    try:
        yield
    finally:
        updater.cancel()
        try:
            await updater
        except asyncio.CancelledError:
            pass
        astro = None


def _initialize() -> None:
    global astro
    astro = AstronomyData()
    astro.artificial = SatelliteOrbits(DATA_DIR, astro.ts, astro.eph)


async def update_satellite_orbits() -> None:
    while True:
        if OFFLINE:
            await asyncio.sleep(3600)
            continue
        try:
            await run_in_threadpool(get_astro().artificial.refresh)
        except Exception:
            log.exception("Satellite orbit cache update failed")
        await asyncio.sleep(3600)


app = FastAPI(title="星屿 · StarIsle", version="0.6.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)


def get_astro() -> AstronomyData:
    if astro is None:
        raise HTTPException(status_code=503, detail="天文数据仍在载入，请稍候刷新。")
    return astro


def parse_datetime(value: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="时间格式无效。") from exc


def check_ephemeris_range(dt: datetime) -> None:
    if not MIN_DATE <= dt < MAX_DATE:
        raise HTTPException(
            status_code=422,
            detail="这一版使用 JPL DE440，太阳系天体查询范围为 1550-01-01 至 2650-01-25。",
        )


def make_observer(a: AstronomyData, lat: float, lon: float, elevation: float):
    return a.eph["earth"] + wgs84.latlon(lat, lon, elevation_m=elevation)


def angle_data(observer: Any, target: Any, t: Any) -> tuple[float, float]:
    alt, az, _ = observer.at(t).observe(target).apparent().altaz()
    return float(np.asarray(alt.degrees)), float(np.asarray(az.degrees) % 360.0)


def normalize_search(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(
        char for char in normalized
        if char.isalnum() or char in "αβγδεζηθικλμνξοπρστυφχψω"
    )


def catalog_connection(a: AstronomyData) -> sqlite3.Connection:
    if not a.catalog_db_path.is_file():
        raise HTTPException(status_code=503, detail="本地目录索引尚未安装。")
    connection = sqlite3.connect(f"file:{a.catalog_db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def bayer_label(bayer: str, constellation: str) -> str:
    if not bayer:
        return ""
    root, suffix = bayer[:3].title(), bayer[3:]
    return f"{GREEK_BAYER.get(root, bayer)}{suffix} {constellation}".strip()


def star_display_name(metadata: dict[str, Any] | sqlite3.Row | None, hip: int = 0) -> str:
    if hip in STAR_NAMES:
        return STAR_NAMES[hip]
    if metadata:
        if metadata["proper"]:
            return str(metadata["proper"])
        bayer = bayer_label(str(metadata["bayer"] or ""), str(metadata["con"] or ""))
        if bayer:
            return bayer
        if metadata["flam"]:
            return f"{metadata['flam']} {metadata['con']}".strip()
        if metadata["tyc"]:
            return f"TYC {metadata['tyc']}"
    return f"HIP {hip}" if hip else "目录恒星"


def star_alias_text(metadata: dict[str, Any] | sqlite3.Row | None, hip: int = 0) -> str:
    values: list[str] = []
    if metadata:
        for prefix, key in (("HIP", "hip"), ("HD", "hd"), ("HR", "hr"), ("TYC", "tyc"), ("GJ", "gl")):
            if metadata[key]:
                values.append(f"{prefix} {metadata[key]}")
        bayer = bayer_label(str(metadata["bayer"] or ""), str(metadata["con"] or ""))
        if bayer:
            values.append(bayer)
        if metadata["flam"]:
            values.append(f"{metadata['flam']} {metadata['con']}".strip())
        if metadata["proper"]:
            values.append(str(metadata["proper"]))
    elif hip:
        values.append(f"HIP {hip}")
    if hip in STAR_ALIASES:
        values.insert(0, STAR_ALIASES[hip])
    return " · ".join(dict.fromkeys(value for value in values if value))


def star_row_by_id(a: AstronomyData, star_id: int) -> sqlite3.Row:
    with catalog_connection(a) as connection:
        row = connection.execute("SELECT * FROM stars WHERE id = ?", (star_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="未找到这颗恒星。")
    return row


def star_from_metadata(row: sqlite3.Row) -> Star:
    return Star(
        ra_hours=float(row["ra"]), dec_degrees=float(row["dec"]),
        ra_mas_per_year=float(row["pm_ra"] or 0.0), dec_mas_per_year=float(row["pm_dec"] or 0.0),
    )


def star_target(a: AstronomyData, hip: int) -> Star:
    try:
        row = a.hip_catalog.loc[hip]
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="未找到这颗恒星。") from exc
    return Star.from_dataframe(row)


def target_by_id(a: AstronomyData, target_id: str) -> tuple[str, Any, str]:
    if target_id in a.bodies:
        return a.bodies[target_id]
    if target_id.startswith("messier:"):
        try:
            number = int(target_id.split(":", 1)[1])
            item = a.messier_catalog[number - 1]
            if item["number"] != number:
                raise IndexError
        except (ValueError, IndexError):
            raise HTTPException(status_code=404, detail="未找到这个梅西耶天体。")
        name = MESSIER_CHINESE_NAMES.get(number)
        label = f"M{number} · {name}" if name else f"M{number}"
        return label, a.messier_targets[target_id], MESSIER_TYPE_NAMES.get(item["type"], "深空天体")
    if target_id.startswith("dso:"):
        item = a.deep_sky_by_id.get(target_id)
        if item is None:
            raise HTTPException(status_code=404, detail="未找到这个深空天体。")
        label = item["catalog"]
        return label, Star(ra_hours=item["ra_hours"], dec_degrees=item["dec_degrees"]), MESSIER_TYPE_NAMES.get(item["type"], "深空天体")
    if target_id.startswith("hip:"):
        try:
            hip = int(target_id.split(":", 1)[1])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="恒星编号无效。") from exc
        metadata = a.hip_metadata.get(hip)
        if metadata is None and a.catalog_db_path.is_file():
            with catalog_connection(a) as connection:
                row = connection.execute("SELECT * FROM stars WHERE hip = ? ORDER BY mag LIMIT 1", (hip,)).fetchone()
                metadata = dict(row) if row else None
        name = star_display_name(metadata, hip)
        return name, star_target(a, hip), "恒星"
    if target_id.startswith("athyg:"):
        try:
            star_id = int(target_id.split(":", 1)[1])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="恒星编号无效。") from exc
        row = star_row_by_id(a, star_id)
        return star_display_name(row, int(row["hip"] or 0)), star_from_metadata(row), "恒星"
    raise HTTPException(status_code=404, detail="没有找到这个天体。")


def twilight_phase(sun_altitude: float) -> str:
    """按太阳高度角划分暮光阶段（0° 以下依次为民用、航海、天文暮光）。"""
    if sun_altitude > 0:
        return "白昼"
    if sun_altitude > -6:
        return "民用暮光"
    if sun_altitude > -12:
        return "航海暮光"
    if sun_altitude > -18:
        return "天文暮光"
    return "天文暮光已结束"


def moon_appearance(a: AstronomyData, observer: Any, t: Any) -> tuple[Any, Any, Any]:
    """Ecliptic phase for waxing/waning; Sun–Moon–observer angle for the lit disc."""
    phase = np.asarray(almanac.moon_phase(a.eph, t).degrees) % 360.0
    position = observer.at(t).observe(a.eph["moon"])
    phase_angle = np.asarray(position.phase_angle(a.eph["sun"]).degrees)
    illumination = (1.0 + np.cos(np.radians(phase_angle))) * 50.0
    magnitude = (-12.73 + 0.026 * phase_angle + 4e-9 * phase_angle ** 4
                 + 5.0 * np.log10(np.asarray(position.distance().km) / 384_400.0))
    return phase, illumination, magnitude


def calculate_sky(lat: float, lon: float, elevation: float, datetime_iso: str) -> dict[str, Any]:
    a = get_astro()
    dt = parse_datetime(datetime_iso)
    check_ephemeris_range(dt)
    t = a.ts.from_datetime(dt)
    observer = make_observer(a, lat, lon, elevation)
    objects: list[dict[str, Any]] = []
    sun_alt = -90.0

    for target_id, (label, body, kind) in a.bodies.items():
        try:
            alt, az = angle_data(observer, body, t)
        except Exception as exc:
            log.warning("Could not calculate %s: %s", target_id, exc)
            continue
        if target_id == "sun":
            sun_alt = alt
        item: dict[str, Any] = {
            "id": target_id,
            "name": label,
            "kind": kind,
            "altitude": round(alt, 3),
            "azimuth": round(az, 3),
            "above_horizon": alt > 0,
            "magnitude": None,
        }
        if target_id == "moon":
            phase, illumination, magnitude = moon_appearance(a, observer, t)
            item["phase"] = round(float(phase), 1)
            item["illumination"] = round(float(illumination), 1)
            item["magnitude"] = round(float(magnitude), 2)
        elif target_id == "sun":
            item["magnitude"] = SUN_MAGNITUDE
        elif target_id in MAGNITUDE_BODIES:
            try:
                item["magnitude"] = round(float(planetary_magnitude(observer.at(t).observe(body))), 2)
            except Exception as exc:
                log.warning("Could not compute magnitude of %s: %s", target_id, exc)
        objects.append(item)

    messier_apparent = observer.at(t).observe(a.messier_stars).apparent()
    messier_alts, messier_azs, _ = messier_apparent.altaz()
    messier_alt_values = np.asarray(messier_alts.degrees)
    messier_az_values = np.asarray(messier_azs.degrees) % 360.0
    messier_out: list[dict[str, Any]] = []
    for item, alt, az in zip(a.messier_catalog, messier_alt_values, messier_az_values):
        number = int(item["number"])
        common_name = MESSIER_CHINESE_NAMES.get(number, "")
        catalog_name = f"M{number}"
        references = [
            f"NGC {item['ngc']}" if item.get("ngc") else "",
            f"IC {item['ic']}" if item.get("ic") else "",
            item.get("common_names", ""),
        ]
        messier_out.append({
            "id": f"messier:{number}",
            "number": number,
            "catalog": catalog_name,
            "name": f"{catalog_name} · {common_name}" if common_name else catalog_name,
            "alias": " · ".join(value for value in references if value),
            "kind": MESSIER_TYPE_NAMES.get(item["type"], "深空天体"),
            "magnitude": item.get("magnitude"),
            "constellation": item.get("constellation", ""),
            "altitude": round(float(alt), 3),
            "azimuth": round(float(az), 3),
            "above_horizon": float(alt) > 0.0,
        })

    apparent = observer.at(t).observe(a.stars).apparent()
    alts, azs, _ = apparent.altaz()
    alt_values = np.asarray(alts.degrees)
    az_values = np.asarray(azs.degrees) % 360.0
    stars_out: list[dict[str, Any]] = []
    for hip, mag, alt, az in zip(a.hip_ids, a.magnitudes, alt_values, az_values):
        hip_num = int(hip)
        metadata = a.hip_metadata.get(hip_num)
        name = star_display_name(metadata, hip_num)
        stars_out.append({
            "id": f"hip:{hip_num}",
            "hip": hip_num,
            "name": name,
            "catalog": f"HIP {hip_num}",
            "alias": star_alias_text(metadata, hip_num),
            "named": hip_num in STAR_NAMES or bool(metadata and (metadata.get("proper") or metadata.get("bayer") or metadata.get("flam"))),
            "kind": "恒星",
            "magnitude": round(float(mag), 2),
            "altitude": round(float(alt), 3),
            "azimuth": round(float(az), 3),
            "above_horizon": float(alt) > 0.0,
        })

    milky_way_altitudes, milky_way_azimuths = horizontal_coordinates(
        MILKY_WAY_RA_HOURS,
        MILKY_WAY_DEC_DEGREES,
        0.0,
        0.0,
        lat,
        lon,
        dt,
        float(t.gast),
        np.asarray(t.M),
    )
    milky_way = [
        {
            "longitude": round(float(galactic_longitude), 1),
            "altitude": round(float(altitude), 3),
            "azimuth": round(float(azimuth), 3),
            "above_horizon": float(altitude) > 0.0,
        }
        for galactic_longitude, altitude, azimuth in zip(
            MILKY_WAY_LONGITUDES, milky_way_altitudes, milky_way_azimuths
        )
    ]

    moon = next((x for x in objects if x["id"] == "moon"), None)
    return {
        "requested_time": dt.isoformat(),
        "location": {"latitude": lat, "longitude": lon, "elevation_m": elevation},
        "sun_altitude": round(sun_alt, 3),
        "twilight": twilight_phase(sun_alt),
        "dark_sky": sun_alt < -18.0,
        "objects": objects,
        "stars": stars_out,
        "messier": messier_out,
        "milky_way": milky_way,
        "visible_star_count": sum(1 for s in stars_out if s["above_horizon"]),
        "visible_messier_count": sum(1 for item in messier_out if item["above_horizon"]),
        "moon": moon,
        "ephemeris": {"name": "JPL DE440", "range": "1550-01-01 — 2650-01-25"},
    }


class TimelinePreviewRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    elevation: float = Field(default=0, ge=-500, le=10000)
    times: list[str] = Field(min_length=1, max_length=193)


def calculate_timeline_preview(
    lat: float, lon: float, elevation: float, datetime_values: list[str]
) -> dict[str, Any]:
    """Return lightweight, exact Solar System positions for interactive timelines."""
    a = get_astro()
    datetimes = [parse_datetime(value) for value in datetime_values]
    for dt in datetimes:
        check_ephemeris_range(dt)
    times = a.ts.from_datetimes(datetimes)
    observer_at_times = make_observer(a, lat, lon, elevation).at(times)
    samples = [
        {"time": dt.isoformat(), "sun_altitude": -90.0, "objects": []}
        for dt in datetimes
    ]
    moon_phases, moon_illuminations, moon_magnitudes = moon_appearance(
        a, make_observer(a, lat, lon, elevation), times
    )

    for target_id, (label, body, kind) in a.bodies.items():
        astrometric = observer_at_times.observe(body)
        apparent = astrometric.apparent()
        altitudes, azimuths, _ = apparent.altaz()
        altitude_values = np.asarray(altitudes.degrees)
        azimuth_values = np.asarray(azimuths.degrees) % 360.0
        magnitudes = None
        if target_id in MAGNITUDE_BODIES:
            try:
                magnitudes = np.asarray(planetary_magnitude(astrometric))
            except Exception as exc:
                log.warning("Could not compute preview magnitude of %s: %s", target_id, exc)
        for index, (altitude, azimuth) in enumerate(zip(altitude_values, azimuth_values)):
            item: dict[str, Any] = {
                "id": target_id,
                "altitude": round(float(altitude), 3),
                "azimuth": round(float(azimuth), 3),
                "above_horizon": float(altitude) > 0.0,
                "magnitude": None,
            }
            if target_id == "moon":
                phase = float(moon_phases[index])
                item["phase"] = round(phase, 1)
                item["illumination"] = round(float(moon_illuminations[index]), 1)
                item["magnitude"] = round(float(moon_magnitudes[index]), 2)
            elif target_id == "sun":
                item["magnitude"] = SUN_MAGNITUDE
            elif magnitudes is not None:
                item["magnitude"] = round(float(magnitudes[index]), 2)
            samples[index]["objects"].append(item)
            if target_id == "sun":
                samples[index]["sun_altitude"] = item["altitude"]

    return {"samples": samples}


def horizontal_coordinates(
    ra_hours: np.ndarray,
    dec_degrees: np.ndarray,
    pm_ra: np.ndarray | float,
    pm_dec: np.ndarray | float,
    lat: float,
    lon: float,
    dt: datetime,
    gast_hours: float,
    rotation_matrix: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Fast catalogue projection; accuracy is ample for plotted star dots."""
    years = (dt - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)).total_seconds() / (365.25 * 86400.0)
    dec = np.asarray(dec_degrees, dtype=float) + np.asarray(pm_dec, dtype=float) * years / 3_600_000.0
    cos_dec_for_pm = np.maximum(np.cos(np.radians(dec)), 1e-6)
    ra = np.asarray(ra_hours, dtype=float) * 15.0 + np.asarray(pm_ra, dtype=float) * years / (3_600_000.0 * cos_dec_for_pm)
    dec_radians = np.radians(dec)
    ra_radians = np.radians(ra)
    if rotation_matrix is not None:
        equatorial = np.stack((
            np.cos(dec_radians) * np.cos(ra_radians),
            np.cos(dec_radians) * np.sin(ra_radians),
            np.sin(dec_radians),
        ))
        rotated = np.einsum("ij,j...->i...", rotation_matrix, equatorial)
        ra = np.degrees(np.arctan2(rotated[1], rotated[0])) % 360.0
        dec_radians = np.arcsin(np.clip(rotated[2], -1.0, 1.0))
    hour_angle = np.radians((gast_hours * 15.0 + lon - ra + 540.0) % 360.0 - 180.0)
    latitude = math.radians(lat)
    sin_dec, cos_dec = np.sin(dec_radians), np.cos(dec_radians)
    sin_lat, cos_lat = math.sin(latitude), math.cos(latitude)
    sin_alt = sin_dec * sin_lat + cos_dec * cos_lat * np.cos(hour_angle)
    altitude = np.degrees(np.arcsin(np.clip(sin_alt, -1.0, 1.0)))
    east = -cos_dec * np.sin(hour_angle)
    north = sin_dec * cos_lat - cos_dec * sin_lat * np.cos(hour_angle)
    azimuth = np.degrees(np.arctan2(east, north)) % 360.0
    return altitude, azimuth


def cone_mask(
    altitude: np.ndarray, azimuth: np.ndarray, center_alt: float, center_az: float, radius: float
) -> np.ndarray:
    altitude_radians = np.radians(altitude)
    center_alt_radians = math.radians(center_alt)
    cosine = (
        np.sin(altitude_radians) * math.sin(center_alt_radians)
        + np.cos(altitude_radians) * math.cos(center_alt_radians)
        * np.cos(np.radians(azimuth - center_az))
    )
    return cosine >= math.cos(math.radians(radius))


def star_metadata_for_ids(a: AstronomyData, ids: np.ndarray) -> dict[int, dict[str, Any]]:
    output: dict[int, dict[str, Any]] = {}
    values = [int(value) for value in ids]
    if not values or not a.catalog_db_path.is_file():
        return output
    with catalog_connection(a) as connection:
        named_hips = list(STAR_NAMES)
        hip_placeholders = ",".join("?" for _ in named_hips)
        for offset in range(0, len(values), 800):
            chunk = values[offset:offset + 800]
            placeholders = ",".join("?" for _ in chunk)
            query = (
                f"SELECT * FROM stars WHERE id IN ({placeholders}) AND "
                f"(proper <> '' OR bayer <> '' OR flam <> '' OR hip IN ({hip_placeholders}))"
            )
            for row in connection.execute(query, [*chunk, *named_hips]):
                output[int(row["id"])] = dict(row)
    return output


def calculate_field(
    lat: float,
    lon: float,
    datetime_iso: str,
    center_az: float,
    center_alt: float,
    radius: float,
    magnitude_limit: float,
    dso_magnitude_limit: float,
) -> dict[str, Any]:
    a = get_astro()
    dt = parse_datetime(datetime_iso)
    check_ephemeris_range(dt)
    t = a.ts.from_datetime(dt)
    stars_out: list[dict[str, Any]] = []
    star_total = 0
    if a.star_field is not None:
        stars = a.star_field
        limit = min(DEEP_STAR_LIMIT, max(STAR_LIMIT, magnitude_limit))
        altitudes, azimuths = horizontal_coordinates(
            stars["ra"], stars["dec"], stars["pm_ra"], stars["pm_dec"], lat, lon, dt, float(t.gast), np.asarray(t.M)
        )
        mask = (
            (stars["mag"] > STAR_LIMIT + 0.01) & (stars["mag"] <= limit)
            & (altitudes > 0.0) & cone_mask(altitudes, azimuths, center_alt, center_az, radius)
        )
        selected = np.flatnonzero(mask)
        star_total = int(len(selected))
        max_stars = 3500
        if len(selected) > max_stars:
            order = np.argsort(stars["mag"][selected], kind="stable")[:max_stars]
            selected = selected[order]
        metadata = star_metadata_for_ids(a, stars["id"][selected])
        for index in selected:
            row = stars[index]
            star_id, hip = int(row["id"]), int(row["hip"])
            meta = metadata.get(star_id)
            tyc = meta.get("tyc", "") if meta else f"{int(row['tyc1'])}-{int(row['tyc2'])}-{int(row['tyc3'])}"
            target_id = f"hip:{hip}" if hip else f"athyg:{star_id}"
            stars_out.append({
                "id": target_id,
                "athyg_id": star_id,
                "hip": hip or None,
                "catalog": f"HIP {hip}" if hip else f"TYC {tyc}",
                "name": star_display_name(meta, hip),
                "alias": star_alias_text(meta, hip),
                "named": bool(hip in STAR_NAMES or (meta and (meta.get("proper") or meta.get("bayer") or meta.get("flam")))),
                "kind": "恒星",
                "magnitude": round(float(row["mag"]), 2),
                "color_index": round(float(row["ci"]), 3) if np.isfinite(row["ci"]) else None,
                "altitude": round(float(altitudes[index]), 3),
                "azimuth": round(float(azimuths[index]), 3),
                "above_horizon": True,
            })

    dso_out: list[dict[str, Any]] = []
    dso_total = 0
    if len(a.deep_sky_catalog):
        dso_altitudes, dso_azimuths = horizontal_coordinates(
            a.deep_sky_ra, a.deep_sky_dec, 0.0, 0.0, lat, lon, dt, float(t.gast), np.asarray(t.M)
        )
        known_bright = np.isfinite(a.deep_sky_mag) & (a.deep_sky_mag <= dso_magnitude_limit)
        unknown_allowed = (dso_magnitude_limit >= 12.0) & (~np.isfinite(a.deep_sky_mag))
        large_object = a.deep_sky_size >= max(2.0, 12.0 - dso_magnitude_limit)
        non_messier = np.asarray([not item.get("messier") for item in a.deep_sky_catalog], dtype=bool)
        mask = (
            non_messier & (dso_altitudes > 0.0)
            & cone_mask(dso_altitudes, dso_azimuths, center_alt, center_az, radius)
            & (known_bright | unknown_allowed | large_object)
        )
        selected = np.flatnonzero(mask)
        dso_total = int(len(selected))
        max_dsos = 1800
        if len(selected) > max_dsos:
            rank = np.where(np.isfinite(a.deep_sky_mag[selected]), a.deep_sky_mag[selected], 30.0 - np.minimum(a.deep_sky_size[selected], 20.0))
            selected = selected[np.argsort(rank, kind="stable")[:max_dsos]]
        for index in selected:
            item = a.deep_sky_catalog[int(index)]
            dso_out.append({
                "id": item["id"], "catalog": item["catalog"], "name": item["catalog"],
                "alias": item.get("aliases", ""),
                "kind": MESSIER_TYPE_NAMES.get(item["type"], "深空天体"),
                "magnitude": item.get("magnitude"), "constellation": item.get("constellation", ""),
                "major_arcmin": item.get("major_arcmin"), "minor_arcmin": item.get("minor_arcmin"),
                "altitude": round(float(dso_altitudes[index]), 3),
                "azimuth": round(float(dso_azimuths[index]), 3), "above_horizon": True,
            })
    return {
        "requested_time": dt.isoformat(),
        "center": {"azimuth": center_az, "altitude": center_alt, "radius": radius},
        "magnitude_limit": min(DEEP_STAR_LIMIT, max(STAR_LIMIT, magnitude_limit)),
        "stars": stars_out, "deep_sky": dso_out,
        "star_count": star_total, "deep_sky_count": dso_total,
        "truncated": star_total > len(stars_out) or dso_total > len(dso_out),
    }


def serialize_catalog_star(a: AstronomyData, row: sqlite3.Row, lat: float, lon: float, dt: datetime, gast: float, rotation: np.ndarray) -> dict[str, Any]:
    hip = int(row["hip"] or 0)
    altitude, azimuth = horizontal_coordinates(
        np.asarray([row["ra"]]), np.asarray([row["dec"]]), float(row["pm_ra"] or 0.0),
        float(row["pm_dec"] or 0.0), lat, lon, dt, gast, rotation,
    )
    return {
        "id": f"hip:{hip}" if hip else f"athyg:{int(row['id'])}",
        "athyg_id": int(row["id"]), "hip": hip or None,
        "catalog": f"HIP {hip}" if hip else f"TYC {row['tyc']}",
        "name": star_display_name(row, hip), "alias": star_alias_text(row, hip),
        "named": bool(hip in STAR_NAMES or row["proper"] or row["bayer"] or row["flam"]),
        "kind": "恒星", "magnitude": round(float(row["mag"]), 2),
        "color_index": round(float(row["ci"]), 3) if row["ci"] is not None else None,
        "constellation": row["con"] or "",
        "altitude": round(float(altitude[0]), 3), "azimuth": round(float(azimuth[0]), 3),
        "above_horizon": bool(altitude[0] > 0.0),
    }


def serialize_catalog_dso(row: sqlite3.Row, lat: float, lon: float, dt: datetime, gast: float, rotation: np.ndarray) -> dict[str, Any]:
    altitude, azimuth = horizontal_coordinates(
        np.asarray([row["ra"]]), np.asarray([row["dec"]]), 0.0, 0.0, lat, lon, dt, gast, rotation,
    )
    target_id = f"messier:{int(row['messier'])}" if row["messier"] else row["id"]
    catalog = f"M{int(row['messier'])}" if row["messier"] else row["catalog"]
    return {
        "id": target_id, "catalog": catalog, "name": catalog,
        "alias": row["aliases"] or row["catalog"],
        "kind": MESSIER_TYPE_NAMES.get(row["type"], "深空天体"),
        "magnitude": round(float(row["mag"]), 2) if row["mag"] is not None else None,
        "constellation": row["constellation"] or "", "major_arcmin": row["major"], "minor_arcmin": row["minor"],
        "altitude": round(float(altitude[0]), 3), "azimuth": round(float(azimuth[0]), 3),
        "above_horizon": bool(altitude[0] > 0.0),
    }


def calculate_search(query: str, lat: float, lon: float, datetime_iso: str) -> dict[str, Any]:
    a = get_astro()
    dt = parse_datetime(datetime_iso)
    check_ephemeris_range(dt)
    t = a.ts.from_datetime(dt)
    normalized = normalize_search(query)
    if not normalized:
        return {"query": query, "results": []}
    results: list[dict[str, Any]] = []
    seen: set[str] = set()

    def append(item: dict[str, Any]) -> None:
        if item["id"] not in seen and len(results) < 16:
            seen.add(item["id"])
            results.append(item)

    observer = make_observer(a, lat, lon, 0.0)
    for target_id, (label, body, kind) in a.bodies.items():
        if normalized in normalize_search(label) or normalized in normalize_search(target_id):
            altitude, azimuth = angle_data(observer, body, t)
            append({
                "id": target_id, "name": label, "alias": target_id, "kind": kind,
                "magnitude": None, "altitude": round(altitude, 3), "azimuth": round(azimuth, 3),
                "above_horizon": altitude > 0.0,
            })

    matched_hips = [hip for hip, name in STAR_NAMES.items() if normalized in normalize_search(name) or normalized in normalize_search(STAR_ALIASES.get(hip, ""))]
    identifier = re.fullmatch(r"(hip|hd|hr)(\d+)", normalized)
    tycho_match = re.search(r"(?:tyc)?(\d+)[- ](\d+)[- ](\d+)", query.casefold())
    dso_identifier = re.fullmatch(r"(ngc|ic|m)(\d+[a-z]?)", normalized)
    exact_identifier = bool(identifier or tycho_match or dso_identifier)
    with catalog_connection(a) as connection:
        star_rows: list[sqlite3.Row] = []
        dso_rows: list[sqlite3.Row] = []
        for hip in matched_hips[:16]:
            row = connection.execute("SELECT * FROM stars WHERE hip = ? ORDER BY mag LIMIT 1", (hip,)).fetchone()
            if row:
                star_rows.append(row)
        if identifier:
            column, value = identifier.group(1), int(identifier.group(2))
            star_rows.extend(connection.execute(f"SELECT * FROM stars WHERE {column} = ? ORDER BY mag LIMIT 16", (value,)))
        if tycho_match:
            tyc = "-".join(tycho_match.groups())
            star_rows.extend(connection.execute("SELECT * FROM stars WHERE tyc = ? LIMIT 16", (tyc,)))
        if len(normalized) >= 2 and not exact_identifier:
            star_rows.extend(connection.execute(
                "SELECT * FROM stars WHERE search_text LIKE ? ORDER BY mag LIMIT 24", (f"%{normalized}%",)
            ))
        if dso_identifier:
            prefix, value = dso_identifier.groups()
            if prefix == "m" and value.isdigit():
                dso_rows.extend(connection.execute("SELECT * FROM deep_sky WHERE messier = ? LIMIT 8", (int(value),)))
            else:
                catalog = f"{prefix.upper()} {value}"
                dso_rows.extend(connection.execute("SELECT * FROM deep_sky WHERE catalog = ? COLLATE NOCASE LIMIT 8", (catalog,)))
        if len(normalized) >= 2 and not exact_identifier:
            dso_rows.extend(connection.execute(
                "SELECT * FROM deep_sky WHERE search_text LIKE ? ORDER BY COALESCE(mag, 99), catalog LIMIT 24",
                (f"%{normalized}%",),
            ))
        for row in star_rows:
            append(serialize_catalog_star(a, row, lat, lon, dt, float(t.gast), np.asarray(t.M)))
        for row in dso_rows:
            append(serialize_catalog_dso(row, lat, lon, dt, float(t.gast), np.asarray(t.M)))
    results.sort(key=lambda item: (
        0 if normalize_search(item.get("catalog", "")) == normalized or normalize_search(item["name"]) == normalized else 1,
        not item["above_horizon"], item["magnitude"] if item["magnitude"] is not None else 99,
    ))
    return {"query": query, "results": results[:12]}


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ready" if astro else "loading", "version": app.version,
        "bright_stars": len(astro.hip_ids) if astro else 0,
        "field_stars": len(astro.star_field) if astro and astro.star_field is not None else 0,
        "deep_sky": len(astro.deep_sky_catalog) if astro else 0,
    }


@app.get("/api/artificial-satellites/catalog")
async def artificial_catalog() -> dict[str, Any]:
    return await run_in_threadpool(get_astro().artificial.catalog)


@app.get("/api/artificial-satellites")
async def artificial_satellites(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    datetime_iso: str = Query(..., alias="datetime"),
    elevation: float = Query(0, ge=-500, le=10000),
    ids: str = Query("48274", max_length=100, pattern=r"^\d+(,\d+)*$"),
) -> dict[str, Any]:
    numbers = list(dict.fromkeys(int(number) for number in ids.split(",")))
    if len(numbers) > 8 or any(not 1 <= number <= 999999999 for number in numbers):
        raise HTTPException(status_code=422, detail="最多同时显示 8 个人造天体。")
    dt = parse_datetime(datetime_iso)
    check_ephemeris_range(dt)
    return await run_in_threadpool(get_astro().artificial.tracks, numbers, dt, lat, lon, elevation)


@app.get("/api/artificial-satellites/passes")
async def artificial_passes(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    datetime_iso: str = Query(..., alias="datetime"),
    norad: int = Query(48274, ge=1, le=999999999),
    elevation: float = Query(0, ge=-500, le=10000),
) -> dict[str, Any]:
    dt = parse_datetime(datetime_iso)
    check_ephemeris_range(dt)
    return await run_in_threadpool(get_astro().artificial.passes, norad, dt, lat, lon, elevation)


@app.get("/api/field")
async def field(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    datetime_iso: str = Query(..., alias="datetime"),
    center_az: float = Query(..., ge=0, le=360),
    center_alt: float = Query(..., ge=0, le=90),
    radius: float = Query(30, ge=2, le=100),
    magnitude: float = Query(8, ge=STAR_LIMIT, le=DEEP_STAR_LIMIT),
    dso_magnitude: float = Query(12, ge=5, le=25),
) -> dict[str, Any]:
    try:
        return await run_in_threadpool(
            calculate_field, lat, lon, datetime_iso, center_az, center_alt, radius, magnitude, dso_magnitude
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Field catalogue calculation failed")
        raise HTTPException(status_code=500, detail=f"视野目录计算失败：{exc}") from exc


@app.get("/api/search")
async def search(
    q: str = Query(..., min_length=1, max_length=80),
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    datetime_iso: str = Query(..., alias="datetime"),
) -> dict[str, Any]:
    try:
        return await run_in_threadpool(calculate_search, q, lat, lon, datetime_iso)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Catalogue search failed")
        raise HTTPException(status_code=500, detail=f"目录搜索失败：{exc}") from exc


@app.get("/api/sky")
async def sky(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    elevation: float = Query(0, ge=-500, le=10000),
    datetime_iso: str = Query(..., alias="datetime"),
) -> dict[str, Any]:
    try:
        return await run_in_threadpool(calculate_sky, lat, lon, elevation, datetime_iso)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Sky calculation failed")
        raise HTTPException(status_code=500, detail=f"天象计算失败：{exc}") from exc


@app.post("/api/timeline-preview")
async def timeline_preview(request: TimelinePreviewRequest) -> dict[str, Any]:
    try:
        return await run_in_threadpool(
            calculate_timeline_preview,
            request.lat,
            request.lon,
            request.elevation,
            request.times,
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Timeline preview calculation failed")
        raise HTTPException(status_code=500, detail=f"时间轴预览计算失败：{exc}") from exc


def pack_events(observer: Any, target: Any, times: Any, flags: Any | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for i, ti in enumerate(times):
        if flags is not None and not bool(flags[i]):
            continue
        alt, az = angle_data(observer, target, ti)
        utc = ti.utc_datetime().replace(tzinfo=timezone.utc)
        rows.append({
            "time": utc.isoformat(),
            "altitude": round(alt, 2),
            "azimuth": round(az, 2),
        })
    return rows


def calculate_events(target_id: str, lat: float, lon: float, elevation: float, start_iso: str, end_iso: str) -> dict[str, Any]:
    a = get_astro()
    start_dt, end_dt = parse_datetime(start_iso), parse_datetime(end_iso)
    if end_dt <= start_dt or end_dt - start_dt > timedelta(days=3):
        raise HTTPException(status_code=422, detail="升落查询的结束时间须晚于开始时间，范围不得超过 3 天。")
    check_ephemeris_range(start_dt)
    check_ephemeris_range(end_dt)
    t0, t1 = a.ts.from_datetime(start_dt), a.ts.from_datetime(end_dt)
    geographic_position = wgs84.latlon(lat, lon, elevation_m=elevation)
    observer = a.eph["earth"] + geographic_position
    label, target, kind = target_by_id(a, target_id)

    rise_t, rise_ok = almanac.find_risings(observer, target, t0, t1)
    set_t, set_ok = almanac.find_settings(observer, target, t0, t1)
    transit_t = almanac.find_transits(observer, target, t0, t1)
    return {
        "target": {"id": target_id, "name": label, "kind": kind},
        "rise": pack_events(observer, target, rise_t, rise_ok),
        "transit": pack_events(observer, target, transit_t),
        "set": pack_events(observer, target, set_t, set_ok),
    }


def calculate_trails(
    lat: float,
    lon: float,
    elevation: float,
    start_iso: str,
    span_minutes: float,
    step_minutes: float,
    target_id: str | None = None,
    include_stars: bool = True,
) -> dict[str, Any]:
    """亮星在给定时间窗内的方位/高度轨迹；指定 target 时同时给出它的轨迹与升落时刻。"""
    a = get_astro()
    start_dt = parse_datetime(start_iso)
    span = max(15.0, min(48 * 60.0, float(span_minutes)))
    end_dt = start_dt + timedelta(minutes=span)
    start_dt = max(start_dt, MIN_DATE)
    end_dt = min(end_dt, MAX_DATE - timedelta(seconds=1))
    if end_dt <= start_dt:
        raise HTTPException(status_code=422, detail="轨迹时间窗与 JPL DE440 可用范围没有交集。")
    check_ephemeris_range(start_dt)
    span = (end_dt - start_dt).total_seconds() / 60.0
    step = max(1.0, min(60.0, float(step_minutes)))
    # Even interval count includes the exact center of an unclipped ±time window.
    intervals = min(498, max(2, 2 * math.ceil(span / step / 2)))
    count = intervals + 1
    observer = make_observer(a, lat, lon, elevation)
    t = a.ts.linspace(a.ts.from_datetime(start_dt), a.ts.from_datetime(end_dt), count)

    tracks: list[dict[str, Any]] = []
    named = np.isin(a.hip_ids, np.fromiter(STAR_NAMES.keys(), dtype=int))
    mask = named & (a.magnitudes <= TRAIL_STAR_MAG)
    if include_stars and mask.any():
        subset = a.catalog[mask]
        star_body = Star.from_dataframe(subset)
        # 向量恒星星表与向量时间无法直接广播，逐时刻观测后再按星拼装。
        alt_cols: list[np.ndarray] = []
        az_cols: list[np.ndarray] = []
        for i in range(len(t)):
            alts_i, azs_i, _ = observer.at(t[i]).observe(star_body).apparent().altaz()
            alt_cols.append(np.asarray(alts_i.degrees))
            az_cols.append(np.asarray(azs_i.degrees) % 360.0)
        alt_arr = np.stack(alt_cols, axis=1)
        az_arr = np.stack(az_cols, axis=1)
        magnitudes = subset["magnitude"].to_numpy()
        for row, hip in enumerate(subset.index.to_numpy(dtype=int)):
            hip_num = int(hip)
            tracks.append({
                "id": f"hip:{hip_num}",
                "hip": hip_num,
                "name": STAR_NAMES.get(hip_num, f"HIP {hip_num}"),
                "magnitude": round(float(magnitudes[row]), 2),
                "points": [
                    [round(float(az), 2), round(float(alt), 2)]
                    for az, alt in zip(az_arr[row], alt_arr[row])
                ],
            })

    target_out: dict[str, Any] | None = None
    events: dict[str, Any] | None = None
    if target_id:
        label, target, kind = target_by_id(a, target_id)
        # 单个目标可直接对整段时间向量求值，避免逐时间点重复建立观测链。
        target_apparent = observer.at(t).observe(target).apparent()
        target_alts, target_azs, _ = target_apparent.altaz()
        target_alt_values = np.asarray(target_alts.degrees)
        target_az_values = np.asarray(target_azs.degrees) % 360.0
        points = [
            [round(float(az), 2), round(float(alt), 2)]
            for az, alt in zip(target_az_values, target_alt_values)
        ]
        target_out = {"id": target_id, "name": label, "kind": kind, "points": points}
        t0, t1 = a.ts.from_datetime(start_dt), a.ts.from_datetime(end_dt)
        rise_t, rise_ok = almanac.find_risings(observer, target, t0, t1)
        set_t, set_ok = almanac.find_settings(observer, target, t0, t1)
        transit_t = almanac.find_transits(observer, target, t0, t1)
        events = {
            "rise": pack_events(observer, target, rise_t, rise_ok),
            "transit": pack_events(observer, target, transit_t),
            "set": pack_events(observer, target, set_t, set_ok),
        }

    return {
        "start": start_dt.isoformat(),
        "end": end_dt.isoformat(),
        "span_minutes": round((end_dt - start_dt).total_seconds() / 60.0, 1),
        "step_minutes": round((end_dt - start_dt).total_seconds() / 60.0 / max(1, count - 1), 2),
        "count": count,
        "magnitude_limit": TRAIL_STAR_MAG,
        "stars": tracks,
        "target": target_out,
        "events": events,
    }


@app.get("/api/events")
async def events(
    target: str,
    start: str,
    end: str,
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    elevation: float = Query(0, ge=-500, le=10000),
) -> dict[str, Any]:
    try:
        return await run_in_threadpool(calculate_events, target, lat, lon, elevation, start, end)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Event search failed")
        raise HTTPException(status_code=500, detail=f"事件查询失败：{exc}") from exc


@app.get("/api/trails")
async def trails(
    start: str,
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    elevation: float = Query(0, ge=-500, le=10000),
    span: float = Query(360, ge=15, le=2880),
    step: float = Query(5, ge=1, le=60),
    target: str | None = None,
    stars: bool = True,
) -> dict[str, Any]:
    try:
        return await run_in_threadpool(calculate_trails, lat, lon, elevation, start, span, step, target, stars)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Trail calculation failed")
        raise HTTPException(status_code=500, detail=f"轨迹计算失败：{exc}") from exc


SOLAR_SYSTEM_TARGETS = [
    (target_id, label, key, kind)
    for target_id, label, key, kind in BODY_DEFS
    if target_id not in {"sun", "moon"}
]
SOLAR_SYSTEM_TARGETS.insert(2, ("earth", "地球", "earth", "行星"))
J2000_OBLIQUITY = np.radians(23.439291111)


def ecliptic_xyz(equatorial: np.ndarray) -> np.ndarray:
    """Convert ICRF equatorial AU coordinates to J2000 ecliptic coordinates."""
    cosine, sine = np.cos(J2000_OBLIQUITY), np.sin(J2000_OBLIQUITY)
    x = equatorial[0]
    y = equatorial[1] * cosine + equatorial[2] * sine
    z = -equatorial[1] * sine + equatorial[2] * cosine
    return np.asarray([x, y, z])


def small_body_xyz(item: dict[str, Any], julian_dates: np.ndarray) -> np.ndarray:
    """Approximate a small body's heliocentric J2000 ecliptic position from SBDB elements."""
    eccentricity = float(item["e"])
    semi_major_axis = float(item["a"])
    mean_anomaly = np.radians(
        (float(item["ma"]) + float(item["n"]) * (julian_dates - float(item["epoch"]))) % 360.0
    )
    eccentric_anomaly = np.where(eccentricity > 0.8, np.pi, mean_anomaly).astype(float)
    for _ in range(14):
        eccentric_anomaly -= (
            eccentric_anomaly - eccentricity * np.sin(eccentric_anomaly) - mean_anomaly
        ) / (1.0 - eccentricity * np.cos(eccentric_anomaly))

    orbit_x = semi_major_axis * (np.cos(eccentric_anomaly) - eccentricity)
    orbit_y = semi_major_axis * np.sqrt(1.0 - eccentricity ** 2) * np.sin(eccentric_anomaly)
    inclination = np.radians(float(item["i"]))
    ascending_node = np.radians(float(item["om"]))
    perihelion = np.radians(float(item["w"]))
    cos_node, sin_node = np.cos(ascending_node), np.sin(ascending_node)
    cos_peri, sin_peri = np.cos(perihelion), np.sin(perihelion)
    cos_inc, sin_inc = np.cos(inclination), np.sin(inclination)
    x = (cos_node * cos_peri - sin_node * sin_peri * cos_inc) * orbit_x
    x += (-cos_node * sin_peri - sin_node * cos_peri * cos_inc) * orbit_y
    y = (sin_node * cos_peri + cos_node * sin_peri * cos_inc) * orbit_x
    y += (-sin_node * sin_peri + cos_node * cos_peri * cos_inc) * orbit_y
    z = sin_peri * sin_inc * orbit_x + cos_peri * sin_inc * orbit_y
    return np.asarray([x, y, z])


def serialize_small_body(item: dict[str, Any], julian_dates: np.ndarray, earth: np.ndarray) -> dict[str, Any]:
    positions = small_body_xyz(item, julian_dates)
    earth_distances = np.linalg.norm(positions - earth, axis=0)
    payload = {
        "id": item["id"],
        "name": item["name"],
        "designation": item["designation"],
        "kind": item["kind"],
        "category": item["category"],
        "points": [
            [round(float(px), 6), round(float(py), 6), round(float(pz), 6)]
            for px, py, pz in zip(*positions)
        ],
        "earth_distances": [round(float(value), 6) for value in earth_distances],
    }
    for field in ("h", "diameter_km"):
        if field in item:
            payload[field] = item[field]
    return payload


def calculate_solar_system(
    focus_iso: str,
    years: int,
    past_fraction: float = PAST_FRACTION,
) -> dict[str, Any]:
    """Return heliocentric positions around a focus date, mostly into the future."""
    a = get_astro()
    focus_dt = parse_datetime(focus_iso)
    check_ephemeris_range(focus_dt)
    duration_days = 365.2422 * years
    start_dt = focus_dt - timedelta(days=duration_days * past_fraction)
    end_dt = focus_dt + timedelta(days=duration_days * (1 - past_fraction))
    check_ephemeris_range(start_dt)
    check_ephemeris_range(end_dt)

    step_days = 1 if years == 1 else 3 if years == 5 else 10
    count = min(1441, max(2, int(np.ceil(duration_days / step_days)) + 1))
    t = a.ts.linspace(a.ts.from_datetime(start_dt), a.ts.from_datetime(end_dt), count)
    sun_position = np.asarray(a.eph["sun"].at(t).position.au)
    earth_position = np.asarray(a.eph["earth"].at(t).position.au) - sun_position
    earth_ecliptic = ecliptic_xyz(earth_position)
    julian_dates = np.asarray(t.tdb)

    bodies: list[dict[str, Any]] = []
    for target_id, label, key, kind in SOLAR_SYSTEM_TARGETS:
        try:
            equatorial = np.asarray(a.eph[key].at(t).position.au) - sun_position
        except Exception as exc:
            log.warning("Could not calculate heliocentric position of %s: %s", target_id, exc)
            continue
        # ICRF 赤道坐标旋转至 J2000 黄道面，页面以黄道北极方向俯视。
        ecliptic = ecliptic_xyz(equatorial)
        earth_distances = np.linalg.norm(ecliptic - earth_ecliptic, axis=0)
        points = [
            [round(float(px), 6), round(float(py), 6), round(float(pz), 6)]
            for px, py, pz in zip(*ecliptic)
        ]
        bodies.append({
            "id": target_id,
            "name": label,
            "kind": kind,
            "points": points,
            "earth_distances": [round(float(value), 6) for value in earth_distances],
        })

    small_bodies = [
        serialize_small_body(item, julian_dates, earth_ecliptic)
        for item in a.small_body_catalog["bodies"]
    ]
    meteor_streams = [
        serialize_small_body(item, julian_dates, earth_ecliptic)
        for item in a.small_body_catalog["meteor_streams"]
    ]

    actual_step_days = duration_days / (count - 1)
    return {
        "start": start_dt.isoformat(),
        "focus": focus_dt.isoformat(),
        "end": end_dt.isoformat(),
        "past_fraction": past_fraction,
        "years": years,
        "step_days": round(actual_step_days, 6),
        "count": count,
        "frame": "日心 J2000 黄道坐标",
        "distance_unit": "AU",
        "bodies": bodies,
        "small_bodies": small_bodies,
        "meteor_streams": meteor_streams,
        "small_body_source": a.small_body_catalog["source"],
        "small_body_elements_retrieved": a.small_body_catalog["retrieved"],
        "satellite_count": sum(
            1 for _, _, _, filename, _, _ in SATELLITE_DEFS
            if filename is None or filename in a.satellite_eph
        ),
    }


def calculate_satellite_positions(at_iso: str) -> dict[str, Any]:
    """Return current positions of the Moon and major planetary satellites."""
    a = get_astro()
    dt = parse_datetime(at_iso)
    check_ephemeris_range(dt)
    t = a.ts.from_datetime(dt)
    sun = np.asarray(a.eph["sun"].at(t).position.au)
    earth = ecliptic_xyz(np.asarray(a.eph["earth"].at(t).position.au) - sun)
    heliocentric_parents: dict[str, np.ndarray] = {}
    for target_id, _, key, _ in SOLAR_SYSTEM_TARGETS:
        try:
            heliocentric_parents[target_id] = ecliptic_xyz(np.asarray(a.eph[key].at(t).position.au) - sun)
        except Exception:
            continue

    satellites: list[dict[str, Any]] = []
    for target_id, label, parent_id, filename, target_code, parent_code in SATELLITE_DEFS:
        parent_position = heliocentric_parents.get(parent_id)
        if parent_position is None:
            continue
        if filename is None:
            satellite_ephemeris = a.eph
        else:
            satellite_ephemeris = a.satellite_eph.get(filename)
            if satellite_ephemeris is None:
                continue
        try:
            target_state = satellite_ephemeris[target_code].at(t)
            parent_state = satellite_ephemeris[parent_code].at(t)
            relative_equatorial = np.asarray(target_state.position.au) - np.asarray(parent_state.position.au)
            velocity_equatorial = np.asarray(target_state.velocity.au_per_d) - np.asarray(parent_state.velocity.au_per_d)
            relative = ecliptic_xyz(relative_equatorial)
            relative_velocity = ecliptic_xyz(velocity_equatorial)
            position = parent_position + relative
            earth_distance = float(np.linalg.norm(position - earth))
            parent_distance = float(np.linalg.norm(relative) * AU_KM)
        except Exception as exc:
            log.warning("Could not calculate satellite %s: %s", target_id, exc)
            continue
        satellites.append({
            "id": target_id,
            "name": label,
            "kind": "卫星",
            "parent": parent_id,
            "position": [round(float(value), 8) for value in position],
            "relative": [round(float(value), 10) for value in relative],
            "relative_velocity": [round(float(value), 12) for value in relative_velocity],
            "earth_distance": round(earth_distance, 8),
            "parent_distance_km": round(parent_distance, 2),
        })
    return {"at": dt.isoformat(), "satellites": satellites}


MOON_PHASE_EVENT_NAMES = ["新月", "上弦", "满月", "下弦"]


def moon_phase_name(degrees: float) -> str:
    phase = float(degrees) % 360.0
    for angle, name in ((0, "新月"), (90, "上弦月"), (180, "满月"), (270, "下弦月")):
        if abs((phase - angle + 180.0) % 360.0 - 180.0) <= 2.0:
            return name
    if phase < 90:
        return "蛾眉月"
    if phase < 180:
        return "盈凸月"
    if phase < 270:
        return "亏凸月"
    return "残月"


def calculate_moon_calendar(year: int, month: int, utc_offset_minutes: int) -> dict[str, Any]:
    """Return daily local-noon Moon phases plus exact principal phase events for one local month."""
    a = get_astro()
    local_zone = timezone(timedelta(minutes=utc_offset_minutes))
    start_local = datetime(year, month, 1, tzinfo=local_zone)
    if month == 12:
        end_local = datetime(year + 1, 1, 1, tzinfo=local_zone)
    else:
        end_local = datetime(year, month + 1, 1, tzinfo=local_zone)
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)
    check_ephemeris_range(start_utc)
    check_ephemeris_range(end_utc - timedelta(seconds=1))

    day_count = (end_local.date() - start_local.date()).days
    local_noons = [start_local + timedelta(days=index, hours=12) for index in range(day_count)]
    times = a.ts.from_datetimes([value.astimezone(timezone.utc) for value in local_noons])
    phases = np.asarray(almanac.moon_phase(a.eph, times).degrees) % 360.0
    positions = a.eph["earth"].at(times).observe(a.eph["moon"])
    distances = np.asarray(positions.distance().km)
    illuminations = np.asarray(positions.fraction_illuminated(a.eph["sun"])) * 100.0
    # Moon age is elapsed time since the actual new Moon, not phase / mean speed.
    search_start = max(start_utc - timedelta(days=35), MIN_DATE)
    event_times, event_codes = almanac.find_discrete(
        a.ts.from_datetime(search_start), a.ts.from_datetime(end_utc - timedelta(seconds=1)),
        almanac.moon_phases(a.eph),
    )
    new_moons = np.asarray(event_times.tt)[np.asarray(event_codes) == 0]

    days: list[dict[str, Any]] = []
    for local_noon, ti, phase, distance, illumination in zip(local_noons, times, phases, distances, illuminations):
        previous_new_moons = new_moons[new_moons <= ti.tt]
        age = float(ti.tt - previous_new_moons[-1]) if len(previous_new_moons) else None
        days.append({
            "date": local_noon.date().isoformat(),
            "phase": round(float(phase), 2),
            "phase_name": moon_phase_name(float(phase)),
            "illumination": round(float(illumination), 1),
            "age_days": round(age, 1) if age is not None else None,
            "distance_km": round(float(distance)),
        })

    events = []
    for event_time, event_code in zip(event_times, event_codes):
        utc_time = event_time.utc_datetime().replace(tzinfo=timezone.utc)
        if not start_utc <= utc_time < end_utc:
            continue
        local_time = utc_time.astimezone(local_zone)
        events.append({
            "type": int(event_code),
            "name": MOON_PHASE_EVENT_NAMES[int(event_code)],
            "time": utc_time.isoformat(),
            "local_date": local_time.date().isoformat(),
        })

    return {
        "year": year,
        "month": month,
        "utc_offset_minutes": utc_offset_minutes,
        "days": days,
        "events": events,
    }


@app.get("/api/solar-system")
async def solar_system(
    focus: str | None = None,
    end: str | None = None,
    years: int = Query(1, ge=1, le=20),
) -> dict[str, Any]:
    anchor = focus or end
    if anchor is None:
        raise HTTPException(status_code=422, detail="请提供焦点日期。")
    try:
        # Keep the earlier `end=` API working for pages that are still open in a tab.
        past_fraction = PAST_FRACTION if focus else 1.0
        return await run_in_threadpool(calculate_solar_system, anchor, years, past_fraction)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Solar-system calculation failed")
        raise HTTPException(status_code=500, detail=f"太阳系位置计算失败：{exc}") from exc


@app.get("/api/solar-system/satellites")
async def solar_system_satellites(at: str) -> dict[str, Any]:
    try:
        return await run_in_threadpool(calculate_satellite_positions, at)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Satellite position calculation failed")
        raise HTTPException(status_code=500, detail=f"行星卫星位置计算失败：{exc}") from exc


@app.get("/api/moon-calendar")
async def moon_calendar(
    year: int = Query(..., ge=1550, le=2650),
    month: int = Query(..., ge=1, le=12),
    utc_offset: int = Query(0, ge=-840, le=840),
) -> dict[str, Any]:
    try:
        return await run_in_threadpool(calculate_moon_calendar, year, month, utc_offset)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Moon calendar calculation failed")
        raise HTTPException(status_code=500, detail=f"月相日历计算失败：{exc}") from exc


@app.get("/")
def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/solar-system")
def solar_system_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "solar-system.html")


@app.get("/licenses")
def licenses_page():
    return FileResponse(STATIC_DIR / "licenses.html")


@app.get("/moon-calendar")
def moon_calendar_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "moon-calendar.html")


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
