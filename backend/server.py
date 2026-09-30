"""
Mantiphy — backend
Catalog (SQLite), RAW decoding (LibRaw via rawpy), previews/thumbnails cache,
metadata, presets, collections, export sink and optional AI masks.

Run:  python backend/server.py   (or ./run.sh)
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sqlite3
import struct
import sys
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request, UploadFile, File, Form
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

try:
    from backend import skylib, stacking, tiff16  # imported as a package submodule (e.g. `-m backend.test_denoise`)
except ImportError:
    import skylib  # run directly: `python backend/server.py` (run.sh) puts this dir on sys.path
    import stacking
    import tiff16

try:
    import rawpy
except ImportError:  # pragma: no cover
    rawpy = None

try:
    import exifread
except ImportError:  # pragma: no cover
    exifread = None

# ----------------------------------------------------------------------------
# Paths & config
# ----------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
DATA_DIR = Path(os.environ.get("MANTIPHY_DATA", Path.home() / ".local/share/mantiphy"))
CACHE_DIR = Path(os.environ.get("MANTIPHY_CACHE", Path.home() / ".cache/mantiphy"))
DB_PATH = DATA_DIR / "catalog.sqlite"

for d in (DATA_DIR, CACHE_DIR / "thumb", CACHE_DIR / "preview", CACHE_DIR / "preview16", CACHE_DIR / "full16", CACHE_DIR / "full", CACHE_DIR / "mask", CACHE_DIR / "heal", CACHE_DIR / "denoise", CACHE_DIR / "skies"):
    d.mkdir(parents=True, exist_ok=True)

RAW_EXT = {".cr2", ".cr3", ".arw", ".raf", ".nef", ".nrw", ".dng", ".orf", ".rw2", ".pef", ".srw", ".3fr", ".iiq", ".x3f"}
IMG_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".heic"}
ALL_EXT = RAW_EXT | IMG_EXT

THUMB_EDGE = 480
PREVIEW_EDGE = 2560
WRITE_SIDECARS = os.environ.get("MANTIPHY_SIDECARS", "1") == "1"

PORT = int(os.environ.get("MANTIPHY_PORT", "7878"))

app = FastAPI(title="Mantiphy")

# ----------------------------------------------------------------------------
# Local-only guard. Listening on 127.0.0.1 keeps other machines out, but not
# other web pages open in the user's browser:
#  - DNS rebinding: a hostile domain that resolves to 127.0.0.1 becomes
#    "same-origin" with the API — rejected by checking the Host header;
#  - cross-site requests: a page may POST multipart forms here without a CORS
#    preflight (e.g. to /api/export, which writes files) — rejected by checking
#    Origin and, when the browser sends it, Sec-Fetch-Site.
# ----------------------------------------------------------------------------
_ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}


@app.middleware("http")
async def _local_only(request: Request, call_next):
    if request.headers.get("host") not in _ALLOWED_HOSTS:
        return PlainTextResponse("Forbidden host", status_code=403)
    origin = request.headers.get("origin")
    if origin is not None and origin.split("://", 1)[-1] not in _ALLOWED_HOSTS:
        return PlainTextResponse("Forbidden origin", status_code=403)
    if request.headers.get("sec-fetch-site") in ("cross-site", "same-site"):
        return PlainTextResponse("Forbidden cross-site request", status_code=403)
    return await call_next(request)

_cpu = os.cpu_count() or 4
_decode_lock = threading.Semaphore(max(2, _cpu // 2))          # interactive decodes (thumb/preview/full requests)
_pool = ThreadPoolExecutor(max_workers=4)                       # light async work (sidecars…)
_warm_pool = ThreadPoolExecutor(max_workers=2 if _cpu >= 8 else 1)  # background cache warming — deliberately small so it never starves the UI
_tether_pool = ThreadPoolExecutor(max_workers=2)                # tethering stability waits (1-30s each) — never shares _pool, which sidecar writes depend on

# ----------------------------------------------------------------------------
# Database
# ----------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  folder TEXT NOT NULL,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  is_raw INTEGER NOT NULL DEFAULT 0,
  size INTEGER, mtime REAL,
  width INTEGER, height INTEGER,
  captured TEXT, camera TEXT, lens TEXT,
  iso INTEGER, shutter TEXT, aperture REAL, focal REAL,
  rating INTEGER DEFAULT 0,
  flag TEXT DEFAULT '',        -- '', 'pick', 'reject'
  label TEXT DEFAULT '',       -- '', red, yellow, green, blue, purple
  edits TEXT DEFAULT '{}',
  keywords TEXT DEFAULT '',
  updated REAL,
  copy_of TEXT,                -- id of the true original photo; NULL for non-copies
  copy_index INTEGER,          -- 1, 2, 3... per source photo; NULL for non-copies
  lat REAL, lon REAL           -- decimal degrees from EXIF GPS; NULL if the photo has no GPS
);
CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created REAL, filter TEXT
);
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INTEGER, image_id TEXT, added REAL,
  PRIMARY KEY (collection_id, image_id)
);
CREATE TABLE IF NOT EXISTS presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, grp TEXT DEFAULT 'User', settings TEXT NOT NULL, created REAL
);
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY, added REAL, watched INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS camera_profiles (
  camera TEXT PRIMARY KEY, matrix TEXT NOT NULL, created REAL
);
-- photos the user removed from the library (files still on disk): imports skip
-- them until they are restored, so a re-scan doesn't quietly bring them back
CREATE TABLE IF NOT EXISTS ignored (
  path TEXT PRIMARY KEY, folder TEXT NOT NULL, removed REAL
);
"""


def _migrate_schema(con: sqlite3.Connection):
    """One-time migration for catalogs created before virtual copies
    (and, later, Smart Collections) existed. SCHEMA's CREATE TABLE IF
    NOT EXISTS is a no-op against a table that already exists, so it
    never retroactively adds new columns or drops old constraints on
    its own — each check below is independent and self-guarded, so
    this function is safe to call unconditionally on every startup."""
    cols = {row["name"] for row in con.execute("PRAGMA table_info(images)")}
    if "copy_of" not in cols:
        con.execute("ALTER TABLE images RENAME TO images_old")
        con.execute("""CREATE TABLE images (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  folder TEXT NOT NULL,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  is_raw INTEGER NOT NULL DEFAULT 0,
  size INTEGER, mtime REAL,
  width INTEGER, height INTEGER,
  captured TEXT, camera TEXT, lens TEXT,
  iso INTEGER, shutter TEXT, aperture REAL, focal REAL,
  rating INTEGER DEFAULT 0,
  flag TEXT DEFAULT '',
  label TEXT DEFAULT '',
  edits TEXT DEFAULT '{}',
  keywords TEXT DEFAULT '',
  updated REAL,
  copy_of TEXT,
  copy_index INTEGER
)""")
        shared = "id,path,folder,filename,ext,is_raw,size,mtime,width,height,captured,camera,lens,iso,shutter,aperture,focal,rating,flag,label,edits,keywords,updated"
        con.execute(f"INSERT INTO images({shared},copy_of,copy_index) SELECT {shared},NULL,NULL FROM images_old")
        con.execute("DROP TABLE images_old")
        con.execute("DROP INDEX IF EXISTS idx_images_folder")
        con.execute("CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder)")
        con.commit()
    coll_cols = {row["name"] for row in con.execute("PRAGMA table_info(collections)")}
    if coll_cols and "filter" not in coll_cols:
        con.execute("ALTER TABLE collections ADD COLUMN filter TEXT")
        con.commit()
    img_cols = {row["name"] for row in con.execute("PRAGMA table_info(images)")}
    if "lat" not in img_cols:
        con.execute("ALTER TABLE images ADD COLUMN lat REAL")
        con.execute("ALTER TABLE images ADD COLUMN lon REAL")
        con.commit()
    folder_cols = {row["name"] for row in con.execute("PRAGMA table_info(folders)")}
    if folder_cols and "watched" not in folder_cols:
        con.execute("ALTER TABLE folders ADD COLUMN watched INTEGER DEFAULT 0")
        con.commit()


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


with db() as _c:
    _c.executescript(SCHEMA)
    _migrate_schema(_c)


def row_to_dict(r: sqlite3.Row) -> dict:
    d = dict(r)
    if "edits" in d:
        try:
            d["edits"] = json.loads(d["edits"] or "{}")
        except Exception:
            d["edits"] = {}
    return d


# ----------------------------------------------------------------------------
# Decoding
# ----------------------------------------------------------------------------
def image_id_for(path: Path) -> str:
    return hashlib.sha1(str(path.resolve()).encode()).hexdigest()[:16]


def _rawpy_decode(path: Path, half: bool) -> np.ndarray:
    if rawpy is None:
        raise RuntimeError("rawpy is not installed")
    with rawpy.imread(str(path)) as raw:
        rgb = raw.postprocess(
            use_camera_wb=True,
            half_size=half,
            no_auto_bright=True,
            output_bps=8,
            output_color=rawpy.ColorSpace.sRGB,
            demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD if not half else None,
            user_flip=None,
        )
    return rgb


def decode(path: Path, half: bool = False) -> Image.Image:
    """Return an 8-bit sRGB PIL image, orientation applied."""
    ext = path.suffix.lower()
    with _decode_lock:
        if ext in RAW_EXT:
            try:
                return Image.fromarray(_rawpy_decode(path, half))
            except Exception as e:  # fall back to embedded preview
                try:
                    with rawpy.imread(str(path)) as raw:
                        t = raw.extract_thumb()
                    if t.format == rawpy.ThumbFormat.JPEG:
                        return ImageOps.exif_transpose(Image.open(io.BytesIO(t.data)).convert("RGB"))
                    return Image.fromarray(t.data)
                except Exception:
                    raise RuntimeError(f"Cannot decode {path.name}: {e}")
        im = Image.open(path)
        im = ImageOps.exif_transpose(im)
        return im.convert("RGB")


def _rawpy_decode16(path: Path, half: bool) -> np.ndarray:
    """Same as _rawpy_decode() except output_bps=16 and a real
    highlight-reconstruction mode instead of the implicit Clip (0)
    default. highlight_mode=3 is a plain int, not a HighlightMode enum
    member — the installed rawpy's HighlightMode only defines Clip/
    Ignore/Blend/ReconstructDefault, but highlight_mode accepts
    Union[HighlightMode, int], and 3 is dcraw/LibRaw's standard
    "reconstruct in adjacent areas" level."""
    if rawpy is None:
        raise RuntimeError("rawpy is not installed")
    with rawpy.imread(str(path)) as raw:
        rgb = raw.postprocess(
            use_camera_wb=True,
            half_size=half,
            no_auto_bright=True,
            output_bps=16,
            highlight_mode=3,
            output_color=rawpy.ColorSpace.sRGB,
            demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD if not half else None,
            user_flip=None,
        )
    return rgb


def decode16(path: Path, half: bool = False) -> np.ndarray:
    """Return a uint16 RGBA ndarray (NOT a PIL Image — Pillow has no
    native multi-channel 16-bit image mode). This is a fully separate
    path from decode(): decode() itself is never touched, so HDR merge
    and Panorama (which both call decode() for 8-bit OpenCV processing)
    have zero risk of being affected by this function's existence.
    Non-RAW files and the embedded-thumbnail fallback both get no
    highlight-recovery benefit (already camera-baked 8-bit data) but
    are still scaled ×257 to the same uint16 range, so every caller of
    decode16() always gets a consistent uint16 RGBA array regardless of
    which path produced it."""
    ext = path.suffix.lower()
    with _decode_lock:
        if ext in RAW_EXT:
            try:
                arr16 = _rawpy_decode16(path, half)
            except Exception as e:  # fall back to embedded preview, same as decode()
                try:
                    with rawpy.imread(str(path)) as raw:
                        t = raw.extract_thumb()
                    if t.format == rawpy.ThumbFormat.JPEG:
                        im8 = ImageOps.exif_transpose(Image.open(io.BytesIO(t.data)).convert("RGB"))
                    else:
                        im8 = Image.fromarray(t.data).convert("RGB")
                    arr16 = np.asarray(im8).astype(np.uint16) * 257
                except Exception:
                    raise RuntimeError(f"Cannot decode {path.name}: {e}")
        else:
            im8 = Image.open(path)
            im8 = ImageOps.exif_transpose(im8)
            im8 = im8.convert("RGB")
            arr16 = np.asarray(im8).astype(np.uint16) * 257
    alpha = np.full(arr16.shape[:2] + (1,), 65535, dtype=np.uint16)
    return np.concatenate([arr16, alpha], axis=-1)


def raw_thumbnail(path: Path) -> Optional[Image.Image]:
    """Fast embedded JPEG thumbnail from RAW (LibRaw) — used for the grid."""
    if rawpy is None or path.suffix.lower() not in RAW_EXT:
        return None
    try:
        with rawpy.imread(str(path)) as raw:
            t = raw.extract_thumb()
        if t.format == rawpy.ThumbFormat.JPEG:
            return ImageOps.exif_transpose(Image.open(io.BytesIO(t.data)).convert("RGB"))
        return Image.fromarray(t.data)
    except Exception:
        return None


def fit(im: Image.Image, edge: int) -> Image.Image:
    w, h = im.size
    if max(w, h) <= edge:
        return im
    s = edge / max(w, h)
    return im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)


def fit16(arr: np.ndarray, edge: int) -> np.ndarray:
    """Like fit(), but for a uint16 RGBA ndarray — PIL has no native
    multi-channel 16-bit-per-channel image mode, so each channel is
    resized independently via PIL's single-channel 'I;16' mode (which
    Image.fromarray() infers automatically from a uint16 2D array —
    passing mode= explicitly is deprecated in current Pillow) and
    restacked."""
    h, w = arr.shape[:2]
    if max(w, h) <= edge:
        return arr
    s = edge / max(w, h)
    new_w, new_h = max(1, round(w * s)), max(1, round(h * s))
    channels = [np.asarray(Image.fromarray(arr[..., c]).resize((new_w, new_h), Image.LANCZOS))
                for c in range(arr.shape[2])]
    return np.stack(channels, axis=-1)


def cache_path(kind: str, iid: str, mtime: float) -> Path:
    return CACHE_DIR / kind / f"{iid}_{int(mtime)}.{'png' if kind == 'full' else 'jpg'}"


def _edit_sig(edits: Optional[str]) -> str:
    """Short hash of an edit recipe, empty for an unedited photo. Hashing the
    recipe rather than a timestamp means undoing back to an earlier state
    reuses the thumbnail already rendered for it."""
    if not edits or edits == "{}":
        return ""
    return hashlib.sha1(edits.encode()).hexdigest()[:12]


def edited_thumb(iid: str, edits: Optional[str]) -> Optional[Path]:
    sig = _edit_sig(edits)
    if not sig:
        return None
    cp = CACHE_DIR / "thumb_edit" / f"{iid}_{sig}.jpg"
    return cp if cp.exists() else None


def ensure_thumb(path: Path, iid: str, mtime: float) -> Path:
    cp = cache_path("thumb", iid, mtime)
    if cp.exists():
        return cp
    im = raw_thumbnail(path)
    if im is None:
        im = decode(path, half=True)
    fit(im, THUMB_EDGE).save(cp, "JPEG", quality=86, optimize=True)
    return cp


def ensure_preview(path: Path, iid: str, mtime: float) -> Path:
    cp = cache_path("preview", iid, mtime)
    if cp.exists():
        return cp
    im = decode(path, half=True)
    fit(im, PREVIEW_EDGE).save(cp, "JPEG", quality=94, subsampling=0)
    return cp


def ensure_preview16(path: Path, iid: str, mtime: float) -> Path:
    cp = CACHE_DIR / "preview16" / f"{iid}_{int(mtime)}.raw16"
    if cp.exists():
        return cp
    arr = fit16(decode16(path, half=True), PREVIEW_EDGE)
    h, w = arr.shape[:2]
    tmp = cp.with_suffix(cp.suffix + ".part")
    with open(tmp, "wb") as f:
        f.write(struct.pack("<II", w, h))
        f.write(arr.astype("<u2").tobytes())
    os.replace(tmp, cp)
    return cp


def ensure_full16(path: Path, iid: str, mtime: float) -> Path:
    """Full-resolution 16-bit source for 16-bit export (same raw16 layout as
    ensure_preview16: <u32 w><u32 h> then RGBA uint16). Only the newest one per
    photo is kept — at full size these are ~8 bytes per pixel."""
    cp = CACHE_DIR / "full16" / f"{iid}_{int(mtime)}.raw16"
    if cp.exists():
        return cp
    for old in (CACHE_DIR / "full16").glob(f"{iid}_*.raw16"):
        old.unlink(missing_ok=True)
    arr = decode16(path, half=False)
    h, w = arr.shape[:2]
    tmp = cp.with_suffix(cp.suffix + ".part")
    with open(tmp, "wb") as f:
        f.write(struct.pack("<II", w, h))
        f.write(arr.astype("<u2").tobytes())
    os.replace(tmp, cp)
    return cp


def ensure_full(path: Path, iid: str, mtime: float) -> Path:
    cp = cache_path("full", iid, mtime)
    if cp.exists():
        return cp
    im = decode(path, half=False)
    im.save(cp, "PNG", compress_level=1)
    return cp


# ----------------------------------------------------------------------------
# Metadata
# ----------------------------------------------------------------------------
def _exif_str(tags: dict, *keys) -> Optional[str]:
    for k in keys:
        if k in tags:
            return str(tags[k]).strip()
    return None


def _ratio(v: Optional[str]) -> Optional[float]:
    if not v:
        return None
    try:
        if "/" in v:
            a, b = v.split("/")
            return float(a) / float(b)
        return float(v)
    except Exception:
        return None


def _gps_decimal(tags: dict, ref_key: str, val_key: str) -> Optional[float]:
    """exifread stores GPS coords as [deg, min, sec] Ratio triplets,
    keyed 'GPS GPS<Latitude|Longitude>' (verified against a synthetic
    test image)."""
    if val_key not in tags or ref_key not in tags:
        return None
    try:
        d, m, s = (float(v) for v in tags[val_key].values)
        dec = d + m / 60 + s / 3600
        if str(tags[ref_key]).strip() in ("S", "W"):
            dec = -dec
        return dec
    except Exception:
        return None


def read_metadata(path: Path) -> dict:
    meta: dict[str, Any] = {}
    if exifread is not None:
        try:
            with open(path, "rb") as f:
                tags = exifread.process_file(f, details=False)
            meta["camera"] = " ".join(x for x in [_exif_str(tags, "Image Make"), _exif_str(tags, "Image Model")] if x) or None
            meta["lens"] = _exif_str(tags, "EXIF LensModel", "MakerNote LensType", "EXIF LensMake")
            meta["captured"] = _exif_str(tags, "EXIF DateTimeOriginal", "Image DateTime")
            iso = _exif_str(tags, "EXIF ISOSpeedRatings")
            meta["iso"] = int(iso.split(",")[0]) if iso and iso.split(",")[0].isdigit() else None
            meta["shutter"] = _exif_str(tags, "EXIF ExposureTime")
            meta["aperture"] = _ratio(_exif_str(tags, "EXIF FNumber"))
            meta["focal"] = _ratio(_exif_str(tags, "EXIF FocalLength"))
            w, h = _exif_str(tags, "EXIF ExifImageWidth"), _exif_str(tags, "EXIF ExifImageLength")
            if w and h and w.isdigit() and h.isdigit():
                meta["width"], meta["height"] = int(w), int(h)
            lat = _gps_decimal(tags, "GPS GPSLatitudeRef", "GPS GPSLatitude")
            lon = _gps_decimal(tags, "GPS GPSLongitudeRef", "GPS GPSLongitude")
            if lat == 0 and lon == 0:
                lat = lon = None
            meta["lat"], meta["lon"] = lat, lon
        except Exception:
            pass
    if rawpy is not None and path.suffix.lower() in RAW_EXT and ("width" not in meta):
        try:
            with rawpy.imread(str(path)) as raw:
                s = raw.sizes
                meta["width"], meta["height"] = s.width, s.height
        except Exception:
            pass
    if "width" not in meta and path.suffix.lower() in IMG_EXT:
        try:
            with Image.open(path) as im:
                meta["width"], meta["height"] = im.size
        except Exception:
            pass
    if meta.get("camera") and meta["camera"].split()[0] in meta["camera"].split()[1:]:
        # "NIKON CORPORATION NIKON Z 6_2" -> "NIKON Z 6_2"
        parts = meta["camera"].split()
        meta["camera"] = " ".join(parts[parts.index(parts[0], 1):])
    return meta


# ----------------------------------------------------------------------------
# Sidecars
# ----------------------------------------------------------------------------
def sidecar_path(path: Path, copy_index: Optional[int] = None) -> Path:
    if copy_index is not None:
        return path.with_suffix(f".Copy{copy_index}" + path.suffix + ".mantiphy.json")
    return path.with_suffix(path.suffix + ".mantiphy.json")


def legacy_sidecar_path(path: Path) -> Path:
    """Sidecars written before the app was renamed. Read-only, never written."""
    return path.with_suffix(path.suffix + ".argent.json")


def write_sidecar(row: dict):
    if not WRITE_SIDECARS:
        return
    try:
        p = sidecar_path(Path(row["path"]))
        payload = {"mantiphy": 1, "rating": row["rating"], "flag": row["flag"], "label": row["label"], "keywords": row["keywords"], "edits": row["edits"]}
        p.write_text(json.dumps(payload, indent=1))
    except Exception:
        pass


# Standard XMP/RDF/Dublin-Core namespace URIs — matched by URI, never by
# the literal prefix a given tool happened to declare in the file.
XMP_NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "xmp": "http://ns.adobe.com/xap/1.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
}
_XMP_LABELS = {"red", "yellow", "green", "blue", "purple"}


def xmp_sidecar_path(path: Path) -> Path:
    """darktable/exiftool convention: full original name + .xmp
    (e.g. photo.NEF -> photo.NEF.xmp). Also the path Mantiphy itself
    writes to, via write_xmp_sidecar() below — never the
    lightroom_xmp_sidecar_path() convention, which is ambiguous when a
    RAW and a JPEG of the same shot coexist in one folder."""
    return path.with_suffix(path.suffix + ".xmp")


def lightroom_xmp_sidecar_path(path: Path) -> Path:
    """Lightroom Classic convention: extension replaced by .xmp
    (e.g. photo.NEF -> photo.xmp). Tried second, after
    xmp_sidecar_path(), because it's inherently ambiguous when e.g.
    photo.NEF and photo.JPG coexist in the same folder — both would
    map to the same photo.xmp."""
    return path.with_suffix(".xmp")


def _register_existing_namespaces(p: Path):
    """Discover every xmlns prefix/URI already declared in an existing
    .xmp file and register them with ElementTree before parsing, so
    re-serialization preserves a foreign schema (e.g. Lightroom's
    crs: develop-history) under its ORIGINAL prefix — without this,
    ElementTree silently renames any prefix it doesn't already know
    about to ns0/ns1/etc. (verified directly: a Lightroom-style file
    with crs: attributes came back as ns3: without this step)."""
    for _, (prefix, uri) in ET.iterparse(p, events=["start-ns"]):
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            # ns0, ns1… are reserved by ElementTree, which regenerates
            # exactly that kind of prefix on output anyway.
            pass


_xmp_write_lock = threading.Lock()


def write_xmp_sidecar(row: dict):
    """Best-effort write of rating/label/keywords/reject-flag into the
    darktable-convention .xmp sidecar (xmp_sidecar_path()), merging into
    any existing file rather than overwriting it whole — a pre-existing
    .xmp may hold real develop-history data from another tool (most
    importantly Lightroom's own crs: schema) that must never be
    destroyed. Mirrors write_sidecar()'s own silent-failure convention:
    never raises, and is a no-op if WRITE_SIDECARS is False.

    Guarded by _xmp_write_lock: ET.register_namespace() mutates a
    process-global registry (confirmed in ElementTree's own source —
    "The registry is global"), and write_xmp_sidecar() runs on the
    shared _pool, so concurrent calls for different photos (e.g. a
    batch rating/flag change) could otherwise have one call's namespace
    registrations bleed into another's in-flight parse/write, corrupting
    the exact prefix-preservation this function exists to provide."""
    if not WRITE_SIDECARS:
        return
    try:
        with _xmp_write_lock:
            for prefix, uri in XMP_NS.items():
                ET.register_namespace(prefix, uri)
            ET.register_namespace("x", "adobe:ns:meta/")

            p = xmp_sidecar_path(Path(row["path"]))
            tree = desc = None
            all_descs = []
            if p.exists():
                try:
                    _register_existing_namespaces(p)
                    tree = ET.parse(p)
                    all_descs = tree.getroot().findall(f".//{{{XMP_NS['rdf']}}}Description")
                    desc = all_descs[0] if all_descs else None
                except Exception:
                    tree = desc = None
                    all_descs = []

            if desc is None and p.exists():
                # Unreadable, or no rdf:Description to merge into: leave
                # another tool's file untouched rather than replace it.
                print(f"XMP: {p.name} could not be merged into, left unchanged", file=sys.stderr)
                return
            if desc is None:
                root = ET.Element("{adobe:ns:meta/}xmpmeta")
                rdf = ET.SubElement(root, f"{{{XMP_NS['rdf']}}}RDF")
                desc = ET.SubElement(rdf, f"{{{XMP_NS['rdf']}}}Description")
                desc.set(f"{{{XMP_NS['rdf']}}}about", "")
                tree = ET.ElementTree(root)
                all_descs = [desc]

            rating_attr = f"{{{XMP_NS['xmp']}}}Rating"
            label_attr = f"{{{XMP_NS['xmp']}}}Label"
            subject_tag = f"{{{XMP_NS['dc']}}}subject"

            # Real-world XMP packets can split properties across several
            # sibling rdf:Description blocks (see read_xmp_sidecar()'s own
            # docstring) — clear any stale mapped value from every block
            # OTHER than the primary one before writing the current value
            # into the primary block, so a value never lingers duplicated
            # or orphaned in a sibling block.
            for other in all_descs[1:]:
                other.attrib.pop(rating_attr, None)
                other.attrib.pop(label_attr, None)
                existing = other.find(subject_tag)
                if existing is not None:
                    other.remove(existing)

            if row["flag"] == "reject":
                desc.set(rating_attr, "-1")
            elif row["rating"]:
                desc.set(rating_attr, str(row["rating"]))
            else:
                desc.attrib.pop(rating_attr, None)

            if row["label"] and row["label"].lower() in _XMP_LABELS:
                desc.set(label_attr, row["label"].capitalize())
            else:
                desc.attrib.pop(label_attr, None)

            existing_subject = desc.find(subject_tag)
            if existing_subject is not None:
                desc.remove(existing_subject)
            kws = [k.strip() for k in (row["keywords"] or "").split(",") if k.strip()]
            if kws:
                subject = ET.SubElement(desc, subject_tag)
                bag = ET.SubElement(subject, f"{{{XMP_NS['rdf']}}}Bag")
                for kw in kws:
                    li = ET.SubElement(bag, f"{{{XMP_NS['rdf']}}}li")
                    li.text = kw

            tmp = Path(str(p) + ".tmp")
            tree.write(tmp, xml_declaration=True, encoding="UTF-8")
            os.replace(tmp, p)
    except Exception:
        pass


def read_xmp_sidecar(path: Path) -> Optional[dict]:
    """Best-effort read of an external .xmp sidecar's rating, colour
    label, reject flag, and keywords. Never raises: any parse failure
    or absence of recognized tags returns None, matching read_sidecar's
    own try/except-continue safety net for a corrupt .mantiphy.json.

    Real-world XMP packets often split properties across several
    sibling rdf:Description elements (one per schema group), so every
    one is examined and the first non-empty value found for each field
    wins, rather than only looking at the first block."""
    try:
        root = ET.parse(path).getroot()
        descs = list(root.iterfind(f".//{{{XMP_NS['rdf']}}}Description"))
        if not descs:
            return None
        out: dict = {}
        for desc in descs:
            if "rating" not in out and "flag" not in out:
                rating_raw = desc.get(f"{{{XMP_NS['xmp']}}}Rating")
                if rating_raw is None:
                    el = desc.find(f"{{{XMP_NS['xmp']}}}Rating")
                    if el is not None:
                        rating_raw = (el.text or "").strip()
                if rating_raw is not None:
                    try:
                        r = int(round(float(rating_raw)))
                        if r == -1:
                            out["flag"] = "reject"
                            out["rating"] = 0
                        elif r > 0:
                            out["rating"] = r
                    except ValueError:
                        pass
            if "label" not in out:
                label_raw = desc.get(f"{{{XMP_NS['xmp']}}}Label")
                if label_raw is None:
                    el = desc.find(f"{{{XMP_NS['xmp']}}}Label")
                    if el is not None:
                        label_raw = (el.text or "").strip()
                if label_raw and label_raw.lower() in _XMP_LABELS:
                    out["label"] = label_raw.lower()
            if "keywords" not in out:
                subj = desc.find(f"{{{XMP_NS['dc']}}}subject")
                if subj is not None:
                    items = [li.text for li in subj.iter(f"{{{XMP_NS['rdf']}}}li") if li.text]
                    if items:
                        out["keywords"] = ", ".join(items)
        return out or None
    except Exception:
        return None


def read_sidecar(path: Path) -> Optional[dict]:
    for p in (sidecar_path(path), legacy_sidecar_path(path)):
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:
                continue
    for xmp in (xmp_sidecar_path(path), lightroom_xmp_sidecar_path(path)):
        if xmp.exists():
            result = read_xmp_sidecar(xmp)
            if result is not None:
                return result
    return None


# ----------------------------------------------------------------------------
# Import / scan
# ----------------------------------------------------------------------------
def register_image(p: Path, con: sqlite3.Connection) -> str:
    """Read metadata for a single file and (re)insert it into the catalog
    using the given connection. Returns its iid. Shared by scan_folder()
    (one file per row, same connection reused across the whole scan) and
    any single-file registration (e.g. an HDR merge result) that opens
    its own short-lived connection."""
    st = p.stat()
    iid = image_id_for(p)
    meta = read_metadata(p)
    sc = read_sidecar(p) or {}
    con.execute(
        """INSERT INTO images(id,path,folder,filename,ext,is_raw,size,mtime,width,height,captured,camera,lens,iso,shutter,aperture,focal,rating,flag,label,edits,keywords,updated,lat,lon)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,width=excluded.width,height=excluded.height,
           captured=excluded.captured,camera=excluded.camera,lens=excluded.lens,iso=excluded.iso,shutter=excluded.shutter,aperture=excluded.aperture,focal=excluded.focal,updated=excluded.updated,lat=excluded.lat,lon=excluded.lon""",
        (iid, str(p), str(p.parent), p.name, p.suffix.lower().lstrip("."), int(p.suffix.lower() in RAW_EXT), st.st_size, st.st_mtime,
         meta.get("width"), meta.get("height"), meta.get("captured"), meta.get("camera"), meta.get("lens"), meta.get("iso"),
         meta.get("shutter"), meta.get("aperture"), meta.get("focal"),
         sc.get("rating", 0), sc.get("flag", ""), sc.get("label", ""), json.dumps(sc.get("edits", {})), sc.get("keywords", ""), time.time(),
         meta.get("lat"), meta.get("lon")),
    )
    return iid


class CannotDeleteOriginal(Exception):
    pass


def create_virtual_copy(con: sqlite3.Connection, source_id: str) -> str:
    """Duplicate an existing catalog row as a new virtual copy: same
    path (no file I/O — this never touches disk), independent edits/
    rating/flag/label/keywords, a fresh id, and copy_of pointing at the
    TRUE original (never chains through an intermediate copy)."""
    src = con.execute("SELECT * FROM images WHERE id=?", (source_id,)).fetchone()
    if not src:
        raise HTTPException(404, "Unknown image")
    true_original = src["copy_of"] or src["id"]
    next_index = (con.execute("SELECT COALESCE(MAX(copy_index), 0) FROM images WHERE copy_of=?", (true_original,)).fetchone()[0] or 0) + 1
    new_id = image_id_for(Path(f"{src['path']}::copy{next_index}"))
    con.execute(
        """INSERT INTO images(id,path,folder,filename,ext,is_raw,size,mtime,width,height,captured,camera,lens,iso,shutter,aperture,focal,rating,flag,label,edits,keywords,updated,copy_of,copy_index,lat,lon)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (new_id, src["path"], src["folder"], src["filename"], src["ext"], src["is_raw"], src["size"], src["mtime"],
         src["width"], src["height"], src["captured"], src["camera"], src["lens"], src["iso"], src["shutter"], src["aperture"], src["focal"],
         src["rating"], src["flag"], src["label"], src["edits"], src["keywords"], time.time(), true_original, next_index,
         src["lat"], src["lon"]),
    )
    con.commit()
    return new_id


def delete_virtual_copy(con: sqlite3.Connection, iid: str):
    """Remove a virtual copy's catalog row (and its own sidecar, and
    any collection membership). Raises CannotDeleteOriginal if iid
    does not name a copy — an original photo's row is never touched
    here."""
    row = con.execute("SELECT * FROM images WHERE id=?", (iid,)).fetchone()
    if not row:
        raise HTTPException(404, "Unknown image")
    if row["copy_of"] is None:
        raise CannotDeleteOriginal(iid)
    try:
        sidecar_path(Path(row["path"]), row["copy_index"]).unlink(missing_ok=True)
    except Exception:
        pass
    con.execute("DELETE FROM images WHERE id=?", (iid,))
    con.execute("DELETE FROM collection_items WHERE image_id=?", (iid,))
    con.commit()


@app.post("/api/image/{iid}/copy")
def api_create_copy(iid: str):
    with db() as con:
        new_id = create_virtual_copy(con, iid)
    return {"iid": new_id}


@app.delete("/api/image/{iid}")
def api_delete_copy(iid: str):
    with db() as con:
        try:
            delete_virtual_copy(con, iid)
        except CannotDeleteOriginal:
            raise HTTPException(400, "Only virtual copies can be deleted individually — remove the containing folder to remove an original photo")
    return {"ok": True}


def _trash_dir() -> Path:
    xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(xdg) / "Trash"


def _same_fs(a: Path, b: Path) -> bool:
    return a.stat().st_dev == b.stat().st_dev


def _mount_top(p: Path) -> Path:
    d = p.resolve().parent
    while not os.path.ismount(d) and d != d.parent:
        d = d.parent
    return d


def _trash_for(p: Path) -> tuple[Path, Optional[Path]]:
    """Trash directory for p, and the directory its .trashinfo Path is
    relative to (None: absolute), per the freedesktop.org Trash spec.

    A file on another filesystem than the home trash (a NAS share, a second
    disk) goes to that filesystem's own $topdir/.Trash/$uid or
    $topdir/.Trash-$uid — the ones file managers use — instead of being
    copied whole into the home folder. When that filesystem has no usable
    trash and none can be created, the home trash is the fallback."""
    home = _trash_dir()
    home.mkdir(parents=True, exist_ok=True)
    try:
        if _same_fs(p, home):
            return home, None
        top, uid = _mount_top(p), os.getuid()
        shared = top / ".Trash"
        try:
            st = os.lstat(shared)
            import stat as _stat
            if _stat.S_ISDIR(st.st_mode) and st.st_mode & _stat.S_ISVTX:   # sticky, not a symlink
                own = shared / str(uid)
                own.mkdir(mode=0o700, exist_ok=True)
                return own, top
        except OSError:
            pass
        own = top / f".Trash-{uid}"
        own.mkdir(mode=0o700, exist_ok=True)
        if not own.is_symlink() and os.access(own, os.W_OK):
            return own, top
    except OSError:
        pass
    return home, None


def move_to_trash(p: Path) -> Path:
    """Move a file to the trash (freedesktop.org Trash spec: files/ plus a
    .trashinfo record), so "Delete from disk" can be undone from the file manager.
    Returns the file's new location."""
    trash, rel_to = _trash_for(p)
    (trash / "files").mkdir(parents=True, exist_ok=True)
    (trash / "info").mkdir(parents=True, exist_ok=True)
    name, n = p.name, 1
    while (trash / "files" / name).exists() or (trash / "info" / (name + ".trashinfo")).exists():
        n += 1
        name = f"{p.stem}.{n}{p.suffix}"
    from urllib.parse import quote
    orig = p.resolve()
    shown = orig.relative_to(rel_to) if rel_to is not None else orig
    (trash / "info" / (name + ".trashinfo")).write_text(
        "[Trash Info]\nPath=" + quote(str(shown)) + "\nDeletionDate=" + time.strftime("%Y-%m-%dT%H:%M:%S") + "\n")
    dest = trash / "files" / name
    shutil.move(str(p), str(dest))
    return dest


def remove_images(con: sqlite3.Connection, ids: list[str], from_disk: bool) -> dict:
    """Take photos out of the catalog; with from_disk, also send the files (and
    their Mantiphy/XMP sidecars) to the trash.

    A virtual copy never owns its file, so on disk it only loses its own sidecar.
    Trashing an original takes its virtual copies with it (they would point at
    nothing); removing an original from the catalog only keeps them, since the
    file is still there."""
    removed, trashed, errors = [], [], []
    for iid in ids:
        row = con.execute("SELECT * FROM images WHERE id=?", (iid,)).fetchone()
        if not row:
            continue
        path = Path(row["path"])
        if row["copy_of"] is not None:
            try:
                sidecar_path(path, row["copy_index"]).unlink(missing_ok=True)
            except Exception:
                pass
            victims = [iid]
        else:
            victims = [iid]
            if from_disk:
                victims += [r["id"] for r in con.execute("SELECT id FROM images WHERE copy_of=?", (iid,))]
                try:
                    # (not the Lightroom-style photo.xmp: a RAW and a JPEG of one shot share it)
                    for extra in (sidecar_path(path), xmp_sidecar_path(path)):
                        if extra.exists() and extra != path:
                            move_to_trash(extra)
                    for c in con.execute("SELECT copy_index FROM images WHERE copy_of=?", (iid,)):
                        sidecar_path(path, c["copy_index"]).unlink(missing_ok=True)
                    if path.exists():
                        move_to_trash(path)
                    trashed.append(str(path))
                except Exception as e:
                    errors.append(f"{path.name}: {e}")
                    continue
        if row["copy_of"] is None:
            if from_disk:
                con.execute("DELETE FROM ignored WHERE path=?", (str(path),))
            else:
                con.execute("INSERT OR REPLACE INTO ignored(path, folder, removed) VALUES(?,?,?)", (str(path), str(path.parent), time.time()))
        for v in victims:
            con.execute("DELETE FROM images WHERE id=?", (v,))
            con.execute("DELETE FROM collection_items WHERE image_id=?", (v,))
            removed.append(v)
    con.commit()
    return {"removed": removed, "trashed": trashed, "errors": errors}


@app.post("/api/images/remove")
def api_remove_images(payload: dict):
    ids = [str(i) for i in payload.get("ids") or []]
    if not ids:
        raise HTTPException(400, "ids required")
    with db() as con:
        return remove_images(con, ids, bool(payload.get("disk")))


def scan_folder(folder: Path, recursive: bool) -> dict:
    added = updated = 0
    it = folder.rglob("*") if recursive else folder.iterdir()
    files = [p for p in it if p.is_file() and p.suffix.lower() in ALL_EXT and not p.name.startswith(".")]
    with db() as con:
        ignored = {r["path"] for r in con.execute("SELECT path FROM ignored")}
        files = [p for p in files if str(p) not in ignored]
        con.execute("INSERT OR IGNORE INTO folders(path, added) VALUES(?,?)", (str(folder), time.time()))
        for p in sorted(files):
            st = p.stat()
            iid = image_id_for(p)
            ex = con.execute("SELECT mtime FROM images WHERE id=?", (iid,)).fetchone()
            if ex and abs((ex["mtime"] or 0) - st.st_mtime) < 1:
                continue
            register_image(p, con)
            if ex:
                updated += 1
            else:
                added += 1
    # warm caches in the background: all thumbnails first (fast, embedded JPEG), then previews
    def _warm_all(files=list(files)):
        meta = [(p, image_id_for(p), p.stat().st_mtime) for p in files]
        for p, iid, mt in meta:
            _safe(ensure_thumb, p, iid, mt)
        for p, iid, mt in meta:
            _safe(ensure_preview, p, iid, mt)
    _warm_pool.submit(_warm_all)
    return {"added": added, "updated": updated, "total": len(files)}


def _safe(fn, *a):
    try:
        fn(*a)
    except Exception as e:
        print("bg error:", e, file=sys.stderr)


# ----------------------------------------------------------------------------
# Tethering — watch a folder for new files and import them as they land
# ----------------------------------------------------------------------------
_STABILITY_INTERVAL = 1.0   # seconds between file-size checks
_STABILITY_TIMEOUT = 30.0   # give up on a file whose size never stops changing


def _wait_for_stable_file(path: Path) -> bool:
    """Poll a file's size until two consecutive checks match (fully
    written), or give up after _STABILITY_TIMEOUT seconds (an
    interrupted transfer). Returns False if the file vanished or never
    stabilized in time. An initial check before the loop lets an
    already-fully-written file skip the first sleep entirely — the
    common case for a small JPEG that finished writing before the
    inotify event was even delivered."""
    deadline = time.time() + _STABILITY_TIMEOUT
    try:
        last = path.stat().st_size
    except OSError:
        return False
    while time.time() < deadline:
        time.sleep(_STABILITY_INTERVAL)
        try:
            size = path.stat().st_size
        except OSError:
            return False
        if size == last:
            return True
        last = size
    return False


_tether_events: list[dict] = []
_tether_events_lock = threading.Lock()


def _handle_new_tether_file(path: Path):
    """Runs on _pool (via _safe) for every file-creation event a watched
    folder's observer reports. Ignores non-catalog extensions and dotfiles,
    waits for the file to finish writing, then imports it the same way
    a manual scan would (register_image()'s upsert makes a duplicate or
    repeated event harmless)."""
    if path.suffix.lower() not in ALL_EXT or path.name.startswith("."):
        return
    if not _wait_for_stable_file(path):
        return
    with db() as con:
        con.execute("DELETE FROM ignored WHERE path=?", (str(path),))  # a new file there is a new photo
        iid = register_image(path, con)
    with _tether_events_lock:
        _tether_events.append({"id": iid, "folder": str(path.parent), "ts": time.time()})


class _TetherHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory:
            _tether_pool.submit(_safe, _handle_new_tether_file, Path(event.src_path))


class WatchManager:
    """Holds one watchdog Observer per watched folder path, in memory.
    Not persisted itself — `folders.watched` is the persisted record;
    this class is rebuilt from that column at server startup."""

    def __init__(self):
        self._observers: dict[str, Observer] = {}
        self._lock = threading.Lock()

    def start(self, path: str) -> bool:
        """Idempotent: returns True immediately if already watching this
        path. Returns False (does not raise) if the path doesn't exist or
        the OS refuses to add the watch (e.g. inotify_max_user_watches
        exhausted) — callers turn a False into a user-facing error."""
        with self._lock:
            if path in self._observers:
                return True
            if not Path(path).is_dir():
                return False
            obs = Observer()
            obs.schedule(_TetherHandler(), path, recursive=False)
            try:
                obs.start()
            except OSError:
                return False
            self._observers[path] = obs
            return True

    def stop(self, path: str):
        with self._lock:
            obs = self._observers.pop(path, None)
        if obs:
            obs.stop()
            obs.join()

    def is_watching(self, path: str) -> bool:
        with self._lock:
            return path in self._observers


watch_manager = WatchManager()

with db() as _con:
    _watched_rows = list(_con.execute("SELECT path FROM folders WHERE watched=1"))
for _row in _watched_rows:
    if not watch_manager.start(_row["path"]):
        print(f"tethering: could not resume watch on {_row['path']} (missing?)", file=sys.stderr)


# ----------------------------------------------------------------------------
# HDR merge (optional) — OpenCV exposure fusion (AlignMTB + MergeMertens)
# ----------------------------------------------------------------------------
class HdrDimensionMismatch(Exception):
    pass


def _hdr_available() -> bool:
    try:
        import cv2  # noqa: F401
        return True
    except Exception:
        return False


def _merge_hdr(images: list) -> Image.Image:
    """Exposure-fuse a same-size bracket of 8-bit RGB PIL images into one
    image via OpenCV AlignMTB (alignment) + MergeMertens (fusion).
    Raises HdrDimensionMismatch if the images aren't all the same size."""
    sizes = {im.size for im in images}
    if len(sizes) > 1:
        raise HdrDimensionMismatch(f"images have mismatched sizes: {sorted(sizes)}")
    import cv2
    arrs = [cv2.cvtColor(np.array(im.convert("RGB")), cv2.COLOR_RGB2BGR) for im in images]
    align = cv2.createAlignMTB()
    aligned = [a.copy() for a in arrs]
    align.process(arrs, aligned)
    arrs.clear()
    merge = cv2.createMergeMertens()
    fused = merge.process(aligned)
    out = np.clip(fused * 255, 0, 255).astype(np.uint8)
    return Image.fromarray(cv2.cvtColor(out, cv2.COLOR_BGR2RGB), "RGB")


@app.post("/api/hdr/merge")
def hdr_merge(payload: dict):
    if not _hdr_available():
        raise HTTPException(501, "HDR merge needs the optional 'opencv-python-headless' package: pip install -r requirements-hdr.txt")
    ids = payload.get("ids") or []
    if len(ids) < 2:
        raise HTTPException(400, "Select at least 2 photos to merge")
    if len(ids) > 12:
        raise HTTPException(400, "Select at most 12 photos to merge — that's well beyond a normal exposure bracket")
    rows = [_row(iid) for iid in ids]
    paths = [Path(r["path"]) for r in rows]
    try:
        images = [decode(p, half=False) for p in paths]
    except Exception as e:
        raise HTTPException(500, f"HDR merge failed: {e}")
    try:
        fused = _merge_hdr(images)
    except HdrDimensionMismatch:
        raise HTTPException(400, "Selected photos must have matching dimensions to merge — did you select a bracket set?")
    except Exception as e:
        raise HTTPException(500, f"HDR merge failed: {e}")
    out_dir = paths[0].parent
    stem = paths[0].stem
    out = out_dir / f"{stem}_HDR.jpg"
    n = 1
    while out.exists():
        n += 1
        out = out_dir / f"{stem}_HDR-{n}.jpg"
    try:
        fused.save(out, "JPEG", quality=95)
    except Exception as e:
        raise HTTPException(500, f"Could not write merged file: {e}")
    with db() as con:
        new_iid = register_image(out, con)
    return {"iid": new_iid}


@app.post("/api/stack")
def stack_photos(payload: dict):
    """Align a burst and combine it into one new photo in the catalog:
    median (remove moving people/objects), mean (reduce noise), lighten
    (light/star trails) or focus (focus stacking). No optional dependency; uses OpenCV for alignment
    when it happens to be installed."""
    ids = payload.get("ids") or []
    mode = payload.get("mode", "median")
    if mode not in stacking.MODES:
        raise HTTPException(400, f"mode must be one of {', '.join(stacking.MODES)}")
    if len(ids) < 2:
        raise HTTPException(400, "Select at least 2 photos to stack")
    if len(ids) > 60:
        raise HTTPException(400, "Select at most 60 photos to stack")
    if mode == "median" and len(ids) < 3:
        raise HTTPException(400, "Removing moving objects needs at least 3 photos (ideally 8 or more)")
    with db() as con:
        rows = [con.execute("SELECT id,path,filename,captured FROM images WHERE id=?", (iid,)).fetchone() for iid in ids]
    if any(r is None for r in rows):
        raise HTTPException(404, "Unknown image")
    rows.sort(key=lambda r: (r["captured"] or "", r["filename"]))
    paths = [Path(r["path"]) for r in rows]
    try:
        images = [decode(p, half=False) for p in paths]
        out_img = stacking.stack(images, mode, do_align=bool(payload.get("align", True)))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Stacking failed: {e}")
    suffix = {"median": "Clean", "mean": "Stack", "lighten": "Trails", "focus": "Focus"}[mode]
    out_dir, stem = paths[0].parent, paths[0].stem
    out = out_dir / f"{stem}_{suffix}.tif"
    n = 1
    while out.exists():
        n += 1
        out = out_dir / f"{stem}_{suffix}-{n}.tif"
    try:
        # lossless: an averaged stack's whole point is the clean gradients JPEG would re-block
        exif = None
        try:  # keep camera/lens/date from the reference frame; pixels are already upright
            exif = Image.open(paths[len(paths) // 2]).getexif()
            exif[0x0112] = 1
        except Exception:
            exif = None
        out_img.save(out, "TIFF", compression="tiff_deflate", **({"exif": exif} if exif else {}))
    except Exception as e:
        raise HTTPException(500, f"Could not write stacked file: {e}")
    with db() as con:
        new_iid = register_image(out, con)
    return {"iid": new_iid, "frames": len(paths), "size": list(out_img.size)}


# ----------------------------------------------------------------------------
# Camera colour profile calibration (optional) — OpenCV cv2.mcc ColorChecker
# detector; a 3x3 correction matrix per camera model, layered on top of
# LibRaw's own built-in per-camera matrix.
# ----------------------------------------------------------------------------
# Standard ColorChecker Classic (24-patch) sRGB D65 reference values,
# row order matches cv2.mcc's own patch ordering (4 rows x 6 columns,
# row-major starting top-left) — publicly documented, stable values.
COLORCHECKER_REFERENCE_SRGB = [
    (115, 82, 68), (194, 150, 130), (98, 122, 157), (87, 108, 67),
    (133, 128, 177), (103, 189, 170), (214, 126, 44), (80, 91, 166),
    (193, 90, 99), (94, 60, 108), (157, 188, 64), (224, 163, 46),
    (56, 61, 150), (70, 148, 73), (175, 54, 60), (231, 199, 31),
    (187, 86, 149), (8, 133, 161), (243, 243, 242), (200, 200, 200),
    (160, 160, 160), (122, 122, 121), (85, 85, 85), (52, 52, 52),
]


def _camera_profile_available() -> bool:
    try:
        import cv2
        return hasattr(cv2, "mcc")
    except Exception:
        return False


def _s2l(c: np.ndarray) -> np.ndarray:
    """sRGB (0-255) to linear light (0-1) — same EOTF as the frontend
    shader's s2l(), reproduced here so the correction matrix is solved
    in the same space it will be applied in."""
    c = c.astype(np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _solve_correction_matrix(observed_srgb: np.ndarray, reference_srgb: np.ndarray) -> np.ndarray:
    """observed_srgb, reference_srgb: (24, 3) arrays of 0-255 sRGB
    values. Returns a (3, 3) matrix M such that
    observed_linear @ M ≈ reference_linear, solved by least squares."""
    obs_lin = _s2l(np.asarray(observed_srgb, dtype=np.float64))
    ref_lin = _s2l(np.asarray(reference_srgb, dtype=np.float64))
    m, *_ = np.linalg.lstsq(obs_lin, ref_lin, rcond=None)
    return m


@app.post("/api/image/{iid}/cameraprofile/calibrate")
def calibrate_camera_profile(iid: str):
    if not _camera_profile_available():
        raise HTTPException(501, "Camera profile calibration needs the optional 'opencv-python-headless>=5.0' package: pip install -r requirements-cameraprofile.txt")
    with db() as con:
        r = con.execute("SELECT path,camera FROM images WHERE id=?", (iid,)).fetchone()
    if not r:
        raise HTTPException(404, "Unknown image")
    if not r["camera"]:
        raise HTTPException(400, "This photo has no camera model in its EXIF — cannot key a profile to it.")
    import cv2
    im = decode(Path(r["path"]), half=False).convert("RGB")
    arr_bgr = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
    detector = cv2.mcc.CCheckerDetector_create()
    if not detector.process(arr_bgr, cv2.mcc.MCC24):
        raise HTTPException(400, "No ColorChecker chart detected in this photo — make sure it fills a good portion of the frame, is well-lit and in focus.")
    checker = detector.getBestColorChecker()
    # getChartsRGB() returns a (3*N, 5) table: 3 consecutive rows per patch
    # (R, G, B in that order), columns [pixel_count, mean, stddev, min, max].
    # Column 1 (mean) is what we want. Values are already RGB, not BGR —
    # cv2.mcc converts internally before building this table (get_profile()
    # in opencv_contrib's modules/mcc/src/checker_detector.cpp calls
    # cv::cvtColor(img, img_rgb_org, COLOR_BGR2RGB) before populating it) —
    # verified against that source, since no real photographed chart was
    # available in this environment to detect against directly.
    charts_rgb = np.asarray(checker.getChartsRGB())
    observed = charts_rgb[:, 1].reshape(-1, 3)[:24]
    brightness = observed.sum(axis=1)
    if np.argmax(brightness) != 18 or np.argmin(brightness) != 23:
        raise HTTPException(400, "ColorChecker chart detected but patches look out of order — try photographing it with less glare/shadow, or more squarely facing the camera.")
    reference = np.array(COLORCHECKER_REFERENCE_SRGB, dtype=np.float64)
    matrix = _solve_correction_matrix(observed, reference)
    camera = r["camera"]
    with db() as con:
        con.execute("INSERT OR REPLACE INTO camera_profiles(camera, matrix, created) VALUES(?,?,?)",
                     (camera, json.dumps(matrix.tolist()), time.time()))
    return {"camera": camera}


@app.get("/api/image/{iid}/cameraprofile")
def camera_profile(iid: str):
    with db() as con:
        r = con.execute("SELECT camera FROM images WHERE id=?", (iid,)).fetchone()
    if not r:
        raise HTTPException(404, "Unknown image")
    if not r["camera"]:
        return {"matched": False}
    with db() as con:
        row = con.execute("SELECT matrix FROM camera_profiles WHERE camera=?", (r["camera"],)).fetchone()
    if not row:
        return {"matched": False}
    return {"matched": True, "camera": r["camera"], "matrix": json.loads(row["matrix"])}


# ----------------------------------------------------------------------------
# Panorama stitching (optional) — OpenCV Stitcher
# ----------------------------------------------------------------------------
class PanoramaStitchFailed(Exception):
    pass


def _panorama_available() -> bool:
    try:
        import cv2  # noqa: F401
        return True
    except Exception:
        return False


def _stitch_panorama(images: list) -> Image.Image:
    """Stitch 2+ overlapping 8-bit RGB PIL images into one panorama via
    OpenCV's Stitcher, then crop to the largest content rectangle
    (Stitcher's warping leaves irregular black borders). Raises
    PanoramaStitchFailed if the images can't be stitched (insufficient
    overlap/matches)."""
    import cv2
    arrs = [cv2.cvtColor(np.array(im.convert("RGB")), cv2.COLOR_RGB2BGR) for im in images]
    stitcher = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
    stitcher.setPanoConfidenceThresh(0.6)
    status, pano = stitcher.stitch(arrs)
    if status != cv2.Stitcher_OK:
        raise PanoramaStitchFailed(f"stitch failed with status {status}")
    gray = cv2.cvtColor(pano, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 1, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        x, y, w, h = cv2.boundingRect(max(contours, key=cv2.contourArea))
        pano = pano[y:y + h, x:x + w]
    return Image.fromarray(cv2.cvtColor(pano, cv2.COLOR_BGR2RGB), "RGB")


@app.post("/api/panorama/stitch")
def panorama_stitch(payload: dict):
    if not _panorama_available():
        raise HTTPException(501, "Panorama stitching needs the optional 'opencv-python-headless' package: pip install -r requirements-panorama.txt")
    ids = payload.get("ids") or []
    if len(ids) < 2:
        raise HTTPException(400, "Select at least 2 photos to stitch")
    if len(ids) > 8:
        raise HTTPException(400, "Select at most 8 photos to stitch at once")
    rows = [_row(iid) for iid in ids]
    paths = [Path(r["path"]) for r in rows]
    try:
        images = [decode(p, half=True) for p in paths]
    except Exception as e:
        raise HTTPException(500, f"Panorama stitch failed: {e}")
    try:
        stitched = _stitch_panorama(images)
    except PanoramaStitchFailed:
        raise HTTPException(400, "Could not stitch these photos — do they overlap enough?")
    except Exception as e:
        raise HTTPException(500, f"Panorama stitch failed: {e}")
    out_dir = paths[0].parent
    stem = paths[0].stem
    out = out_dir / f"{stem}_PANO.jpg"
    n = 1
    while out.exists():
        n += 1
        out = out_dir / f"{stem}_PANO-{n}.jpg"
    try:
        stitched.save(out, "JPEG", quality=95)
    except Exception as e:
        raise HTTPException(500, f"Could not write stitched file: {e}")
    with db() as con:
        new_iid = register_image(out, con)
    return {"iid": new_iid}


# ----------------------------------------------------------------------------
# API — filesystem & catalog
# ----------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {"ok": True, "rawpy": rawpy is not None, "libraw": getattr(rawpy, "libraw_version", None), "exif": exifread is not None, "ai": _ai_available(), "inpaint": _inpaint_available(), "gpu": _inpaint_device(), "aiDevice": ai_device(), "hdr": _hdr_available(), "panorama": _panorama_available(), "cameraProfile": _camera_profile_available()}


@app.get("/api/fs")
def list_fs(path: str = Query(default=str(Path.home()))):
    p = Path(path).expanduser()
    if not p.is_dir():
        raise HTTPException(404, "Not a directory")
    dirs, n_images = [], 0
    try:
        for c in sorted(p.iterdir(), key=lambda x: x.name.lower()):
            if c.name.startswith("."):
                continue
            if c.is_dir():
                dirs.append({"name": c.name, "path": str(c)})
            elif c.suffix.lower() in ALL_EXT:
                n_images += 1
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else None, "dirs": dirs, "images": n_images}


@app.get("/api/folders")
def folders():
    """Full folder hierarchy, derived from where the images actually live.

    The `folders` table only holds the roots you imported; images below them may sit in
    any number of subfolders. This walks every distinct `images.folder`, fills in the
    intermediate levels (a folder with no direct images but with images underneath still
    needs a node), and reports a recursive count for each. `root` marks the entries that
    can be removed from the catalog; `depth` is the nesting level under their root."""
    with db() as con:
        root_rows = con.execute("SELECT path, watched FROM folders ORDER BY path").fetchall()
        roots = [r["path"] for r in root_rows]
        watched_map = {r["path"]: bool(r["watched"]) for r in root_rows}
        counts = {r["folder"]: r["n"] for r in
                  con.execute("SELECT folder, COUNT(*) AS n FROM images GROUP BY folder")}

    nodes: set[str] = set(roots)
    for f in counts:
        nodes.add(f)
        owner = next((r for r in roots if f == r or f.startswith(r + "/")), None)
        if owner is None:
            continue
        cur = Path(f)
        while str(cur) != owner and cur != cur.parent:
            nodes.add(str(cur))
            cur = cur.parent

    out = []
    for path in sorted(nodes):
        owner = next((r for r in roots if path == r or path.startswith(r + "/")), None)
        depth = 0 if owner is None or path == owner else path[len(owner) + 1:].count("/") + 1
        n = sum(c for f, c in counts.items() if f == path or f.startswith(path + "/"))
        out.append({"path": path, "name": Path(path).name or path, "n": n,
                    "root": path in roots, "depth": depth, "watched": watched_map.get(path, False)})
    return out


@app.post("/api/import")
def import_folder(payload: dict):
    folder = Path(payload.get("path", "")).expanduser()
    if folder.is_file():
        # Dropping photos onto the window means "catalog where these live".
        folder = folder.parent
    if not folder.is_dir():
        raise HTTPException(400, "Folder not found")
    # Report the folder actually used: the caller may have passed a file, and it
    # needs the resolved folder to select it afterwards.
    return {**scan_folder(folder, bool(payload.get("recursive", True))), "folder": str(folder)}


@app.delete("/api/folders")
def remove_folder(path: str):
    watch_manager.stop(path)
    with db() as con:
        con.execute("DELETE FROM folders WHERE path=?", (path,))
        con.execute("DELETE FROM images WHERE folder=? OR folder LIKE ?", (path, path + "/%"))
        con.execute("DELETE FROM ignored WHERE folder=? OR folder LIKE ?", (path, path + "/%"))
    return {"ok": True}


@app.get("/api/ignored")
def list_ignored(folder: str = ""):
    """Photos removed from the library (still on disk) under `folder`."""
    with db() as con:
        rows = con.execute("SELECT path, folder, removed FROM ignored WHERE ?='' OR folder=? OR folder LIKE ? ORDER BY path",
                           (folder, folder, folder + "/%")).fetchall()
    return [{"path": r["path"], "filename": Path(r["path"]).name, "removed": r["removed"], "exists": Path(r["path"]).exists()} for r in rows]


@app.post("/api/ignored/restore")
def restore_ignored(payload: dict):
    """Bring removed photos back into the library (those still on disk)."""
    paths = [str(p) for p in payload.get("paths") or []]
    restored, missing = [], []
    with db() as con:
        for p in paths:
            con.execute("DELETE FROM ignored WHERE path=?", (p,))
            if Path(p).is_file():
                restored.append(register_image(Path(p), con))
            else:
                missing.append(p)
        con.commit()
    return {"restored": restored, "missing": missing}


@app.post("/api/folders/watch")
def watch_folder(payload: dict):
    path = payload.get("path", "")
    watch = bool(payload.get("watch"))
    with db() as con:
        if not con.execute("SELECT 1 FROM folders WHERE path=?", (path,)).fetchone():
            raise HTTPException(404, "Not an imported folder")
    if watch:
        if not watch_manager.start(path):
            raise HTTPException(400, f'Could not watch "{path}" — folder missing, or the system\'s inotify watch limit is exhausted.')
    else:
        watch_manager.stop(path)
    with db() as con:
        con.execute("UPDATE folders SET watched=? WHERE path=?", (int(watch), path))
        con.commit()
    return {"ok": True, "watched": watch}


@app.get("/api/tether/events")
def tether_events(since: float = 0):
    with _tether_events_lock:
        events = [e for e in _tether_events if e["ts"] > since]
    return {"events": events, "now": time.time()}


def _build_image_filter(folder: Optional[str] = None, q: Optional[str] = None, min_rating: int = 0,
                         flag: Optional[str] = None, label: Optional[str] = None, edited: Optional[bool] = None) -> tuple:
    """The WHERE-clause fragments GET /api/images already builds from
    its own query params, extracted so a Smart Collection's saved
    filter JSON can be evaluated the same way — both for listing (the
    frontend, via ordinary /api/images calls with these same params)
    and for computing each Smart Collection's live sidebar count."""
    where, args = [], []
    if folder:
        where.append("(folder=? OR folder LIKE ?)"); args += [folder, folder + "/%"]
    if q:
        where.append("(filename LIKE ? OR keywords LIKE ? OR camera LIKE ? OR lens LIKE ?)"); args += [f"%{q}%"] * 4
    if min_rating:
        where.append("rating>=?"); args.append(min_rating)
    if flag:
        where.append("flag=?"); args.append(flag)
    if label:
        where.append("label=?"); args.append(label)
    if edited is True:
        where.append("edits<>'{}'")
    elif edited is False:
        where.append("edits='{}'")
    return where, args


@app.get("/api/images")
def list_images(folder: Optional[str] = None, collection: Optional[int] = None, q: Optional[str] = None,
                min_rating: int = 0, flag: Optional[str] = None, label: Optional[str] = None,
                sort: str = "captured", desc: bool = False, edited: Optional[bool] = None):
    where, args = _build_image_filter(folder, q, min_rating, flag, label, edited)
    if collection:
        where.append("id IN (SELECT image_id FROM collection_items WHERE collection_id=?)"); args.append(collection)
    sort_col = {"captured": "COALESCE(captured, filename)", "filename": "filename", "rating": "rating", "mtime": "mtime", "updated": "updated", "folder": "folder"}.get(sort, "filename")
    sql = "SELECT id,path,folder,filename,ext,is_raw,width,height,captured,camera,lens,iso,shutter,aperture,focal,rating,flag,label,keywords,(edits<>'{}') AS edited,edits,copy_of,copy_index FROM images"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {sort_col} {'DESC' if desc else 'ASC'}, filename"
    with db() as con:
        rows = con.execute(sql, args).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        # Ship a short signature instead of the recipe itself: the grid only
        # needs it to cache-bust its thumbnail, and full edit JSON for a few
        # thousand rows would dwarf the rest of the payload.
        d["esig"] = _edit_sig(d.pop("edits", None))
        out.append(d)
    return out


@app.get("/api/images/geo")
def images_geo():
    with db() as con:
        rows = con.execute("SELECT id,lat,lon FROM images WHERE lat IS NOT NULL AND lon IS NOT NULL").fetchall()
        total = con.execute("SELECT COUNT(*) FROM images").fetchone()[0]
    return {"items": [dict(r) for r in rows], "total": total}


@app.get("/api/image/{iid}")
def get_image(iid: str):
    with db() as con:
        r = con.execute("SELECT * FROM images WHERE id=?", (iid,)).fetchone()
    if not r:
        raise HTTPException(404)
    return row_to_dict(r)


_FLAGS = {"", "pick", "reject"}


def _check_changes(payload: dict):
    """Reject values the catalog and the UI cannot represent (a rating of
    999999999 used to reach the grid and break it)."""
    if "rating" in payload:
        r = payload["rating"]
        if isinstance(r, bool) or not isinstance(r, int) or not 0 <= r <= 5:
            raise HTTPException(400, "rating must be an integer from 0 to 5")
    if "flag" in payload and payload["flag"] not in _FLAGS:
        raise HTTPException(400, "flag must be '', 'pick' or 'reject'")
    if "label" in payload and payload["label"] not in _XMP_LABELS | {""}:
        raise HTTPException(400, "label must be '' or one of " + ", ".join(sorted(_XMP_LABELS)))
    if "keywords" in payload and not isinstance(payload["keywords"], str):
        raise HTTPException(400, "keywords must be a string")
    if "edits" in payload and not isinstance(payload["edits"], dict):
        raise HTTPException(400, "edits must be an object")


@app.patch("/api/image/{iid}")
def patch_image(iid: str, payload: dict):
    _check_changes(payload)
    _row(iid)  # 404 for an unknown id
    allowed = {"rating", "flag", "label", "keywords", "edits"}
    sets, args = [], []
    for k, v in payload.items():
        if k in allowed:
            sets.append(f"{k}=?"); args.append(json.dumps(v) if k == "edits" else v)
    if not sets:
        raise HTTPException(400, "Nothing to update")
    sets.append("updated=?"); args.append(time.time()); args.append(iid)
    with db() as con:
        con.execute(f"UPDATE images SET {', '.join(sets)} WHERE id=?", args)
        r = con.execute("SELECT * FROM images WHERE id=?", (iid,)).fetchone()
    d = row_to_dict(r)
    _pool.submit(write_sidecar, d)
    if {"rating", "flag", "label", "keywords"} & payload.keys():
        _pool.submit(write_xmp_sidecar, d)
    return d


@app.post("/api/images/batch")
def batch_patch(payload: dict):
    ids, changes = payload.get("ids", []), payload.get("changes", {})
    _check_changes(changes)
    for iid in ids:  # all or nothing: validate every id before touching any
        _row(iid)
    out = []
    for iid in ids:
        out.append(patch_image(iid, changes))
    return out


def _row(iid: str) -> sqlite3.Row:
    with db() as con:
        r = con.execute("SELECT id,path,mtime,edits FROM images WHERE id=?", (iid,)).fetchone()
    if not r:
        raise HTTPException(404, "Unknown image")
    return r


@app.get("/api/image/{iid}/thumb")
def thumb(iid: str):
    r = _row(iid)
    try:
        ep = edited_thumb(iid, r["edits"])
        if ep is not None:
            return FileResponse(ep, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
        return FileResponse(ensure_thumb(Path(r["path"]), iid, r["mtime"]), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/image/{iid}/preview")
def preview(iid: str):
    r = _row(iid)
    try:
        return FileResponse(ensure_preview(Path(r["path"]), iid, r["mtime"]), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/image/{iid}/preview16")
def preview16(iid: str):
    r = _row(iid)
    try:
        cp = ensure_preview16(Path(r["path"]), iid, r["mtime"])
        with open(cp, "rb") as f:
            w, h = struct.unpack("<II", f.read(8))
        return FileResponse(cp, media_type="application/octet-stream",
                             headers={"Cache-Control": "max-age=86400", "X-Width": str(w), "X-Height": str(h)})
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/image/{iid}/full16")
def full16(iid: str):
    r = _row(iid)
    try:
        cp = ensure_full16(Path(r["path"]), iid, r["mtime"])
        with open(cp, "rb") as f:
            w, h = struct.unpack("<II", f.read(8))
        return FileResponse(cp, media_type="application/octet-stream", headers={"X-Width": str(w), "X-Height": str(h)})
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/image/{iid}/full")
def full(iid: str):
    r = _row(iid)
    try:
        return FileResponse(ensure_full(Path(r["path"]), iid, r["mtime"]), media_type="image/png", headers={"Cache-Control": "max-age=3600"})
    except Exception as e:
        raise HTTPException(500, str(e))


# ----------------------------------------------------------------------------
# Collections & presets
# ----------------------------------------------------------------------------
_FILTER_KEYS = {"folder", "q", "min_rating", "flag", "label", "edited"}


@app.get("/api/collections")
def collections():
    with db() as con:
        rows = con.execute("SELECT c.id,c.name,c.filter,(SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id=c.id) n FROM collections c ORDER BY name").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            if d["filter"]:
                try:
                    criteria = json.loads(d["filter"])
                    criteria = {k: v for k, v in criteria.items() if k in _FILTER_KEYS}
                    where, args = _build_image_filter(**criteria)
                    sql = "SELECT COUNT(*) FROM images"
                    if where:
                        sql += " WHERE " + " AND ".join(where)
                    d["n"] = con.execute(sql, args).fetchone()[0]
                    d["filter"] = criteria
                except Exception:
                    d["filter"] = None
            out.append(d)
    return out


@app.post("/api/collections")
def create_collection(payload: dict):
    filter_json = json.dumps(payload["filter"]) if payload.get("filter") is not None else None
    with db() as con:
        con.execute("INSERT OR IGNORE INTO collections(name, created, filter) VALUES(?,?,?)", (payload["name"], time.time(), filter_json))
        r = con.execute("SELECT id,name FROM collections WHERE name=?", (payload["name"],)).fetchone()
    return dict(r)


@app.delete("/api/collections/{cid}")
def delete_collection(cid: int):
    with db() as con:
        con.execute("DELETE FROM collection_items WHERE collection_id=?", (cid,))
        con.execute("DELETE FROM collections WHERE id=?", (cid,))
    return {"ok": True}


@app.post("/api/collections/{cid}/items")
def add_items(cid: int, payload: dict):
    with db() as con:
        r = con.execute("SELECT filter FROM collections WHERE id=?", (cid,)).fetchone()
        if r and r["filter"]:
            raise HTTPException(400, "Cannot manually add or remove photos from a Smart Collection")
        for iid in payload.get("ids", []):
            con.execute("INSERT OR IGNORE INTO collection_items VALUES(?,?,?)", (cid, iid, time.time()))
    return {"ok": True}


@app.delete("/api/collections/{cid}/items")
def remove_items(cid: int, payload: dict):
    with db() as con:
        r = con.execute("SELECT filter FROM collections WHERE id=?", (cid,)).fetchone()
        if r and r["filter"]:
            raise HTTPException(400, "Cannot manually add or remove photos from a Smart Collection")
        for iid in payload.get("ids", []):
            con.execute("DELETE FROM collection_items WHERE collection_id=? AND image_id=?", (cid, iid))
    return {"ok": True}


@app.get("/api/presets")
def presets():
    with db() as con:
        rows = con.execute("SELECT id,name,grp,settings FROM presets ORDER BY grp,name").fetchall()
    return [{**dict(r), "settings": json.loads(r["settings"])} for r in rows]


@app.post("/api/presets")
def save_preset(payload: dict):
    with db() as con:
        con.execute("INSERT INTO presets(name,grp,settings,created) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET settings=excluded.settings,grp=excluded.grp",
                    (payload["name"], payload.get("grp", "User"), json.dumps(payload["settings"]), time.time()))
    return {"ok": True}


@app.delete("/api/presets/{pid}")
def delete_preset(pid: int):
    with db() as con:
        con.execute("DELETE FROM presets WHERE id=?", (pid,))
    return {"ok": True}


# ----------------------------------------------------------------------------
# Export sink: the browser renders the final pixels on the GPU and posts them
# ----------------------------------------------------------------------------
_EXPORT_EXT = {"jpeg": ".jpg", "png": ".png", "webp": ".webp", "tiff": ".tif"}


def _export_dir(dest: str, subfolder: str) -> Path:
    """Destination folder, created if needed. The subfolder field is kept
    inside it: a name like "../.." or an absolute path there would silently
    escape the destination the user chose."""
    out_dir = Path(dest).expanduser()
    if subfolder.strip():
        safe = "/".join(part for part in Path(subfolder.strip()).parts
                        if part not in ("", ".", "..", "/") and ":" not in part)
        if safe:
            out_dir = out_dir / safe
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def _export_target(out_dir: Path, stem: str, ext: str, on_existing: str, metadata_src: str) -> tuple[Path, bool]:
    """Where to write an export, and whether to skip it — Lightroom's
    Existing Files choice (ask / rename / overwrite / skip).

    Names are compared case-insensitively, because exporting back into the
    source folder must not drop a "DSC_0001.jpg" beside an original
    "DSC_0001.JPG" — on a case-sensitive filesystem that is two files one
    keystroke apart. And the photo being exported is never written over,
    whatever the policy says: that would destroy the original to produce a
    copy of it."""
    try:
        entries = list(out_dir.iterdir())
    except OSError:
        entries = []
    taken = {e.name.lower() for e in entries}
    out = out_dir / (stem + ext)
    if out.name.lower() not in taken:
        return out, False
    clashes = [e for e in entries if e.name.lower() == out.name.lower()]
    src = Path(metadata_src).expanduser().resolve() if metadata_src else None
    if src is None or not any(e.resolve() == src for e in clashes):
        if on_existing == "skip":
            return out, True
        if on_existing == "ask":
            raise HTTPException(409, f"{out.name} already exists in {out_dir}")
        if on_existing == "overwrite":
            return clashes[0], False  # the existing file's own casing
    n, cand = 1, out
    while cand.name.lower() in taken:
        cand = out_dir / f"{stem}-{n}{ext}"; n += 1
    return cand, False


@app.post("/api/export")
async def export(file: UploadFile = File(...), dest: str = Form(...), filename: str = Form(...), fmt: str = Form("jpeg"),
                 quality: int = Form(92), long_edge: int = Form(0), sharpen: int = Form(0), metadata_src: str = Form(""),
                 subfolder: str = Form(""), on_existing: str = Form("rename"),
                 dpi: int = Form(0), metadata_mode: str = Form("copy"), keywords: str = Form(""), copyright: str = Form("")):
    """Render one exported file.

    `subfolder` and `on_existing` mirror Lightroom Classic's Export Location
    panel: "Put in Subfolder", and the Existing Files choice between asking,
    picking a new name, overwriting, and skipping.
    """
    if fmt not in _EXPORT_EXT:
        raise HTTPException(400, "fmt must be one of " + ", ".join(_EXPORT_EXT))
    out_dir = _export_dir(dest, subfolder)
    data = await file.read()
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if long_edge and max(im.size) > long_edge:
        im = fit(im, long_edge)
    if sharpen:
        from PIL import ImageFilter
        im = im.filter(ImageFilter.UnsharpMask(radius=1.0, percent=int(sharpen), threshold=1))
    exif_bytes = None
    if metadata_mode != "none" and metadata_src:
        try:
            with Image.open(metadata_src) as src:
                exif_bytes = src.info.get("exif")
        except Exception:
            exif_bytes = None
    if copyright or keywords:
        exif = Image.Exif()
        if exif_bytes:
            try:
                exif.load(exif_bytes)
            except Exception:
                pass
        if copyright:
            exif[0x8298] = copyright  # Copyright
        if keywords:
            exif[0x9C9E] = keywords.encode("utf-16-le") + b"\x00\x00"  # Windows XP Keywords
        exif_bytes = exif.tobytes()
    out, skip = _export_target(out_dir, Path(filename).stem, _EXPORT_EXT[fmt], on_existing, metadata_src)
    if skip:
        return {"skipped": True, "path": str(out)}
    kw: dict[str, Any] = {}
    if fmt == "jpeg":
        kw = {"quality": quality, "subsampling": 0 if quality >= 90 else 2, "optimize": True}
        if exif_bytes:
            kw["exif"] = exif_bytes
    elif fmt == "webp":
        kw = {"quality": quality, "method": 5}
    elif fmt == "tiff":
        kw = {"compression": "tiff_lzw"}
        if exif_bytes:
            kw["exif"] = exif_bytes
    if dpi and fmt in ("jpeg", "tiff", "png"):
        kw["dpi"] = (dpi, dpi)
    im.save(out, fmt.upper(), **kw)
    return {"path": str(out), "width": im.width, "height": im.height}


def _unsharp16(a: np.ndarray, amount: float) -> np.ndarray:
    """Output sharpening for 16-bit exports (PIL's UnsharpMask is 8-bit only):
    luminance high-pass from a ~1px Gaussian (three box passes), added to RGB."""
    f = a.astype(np.float32)
    lum = f @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    b = lum
    for _ in range(3):
        b = _box_mean(b, 1)
    return np.clip(f + ((lum - b) * amount)[..., None], 0, 65535).astype(np.uint16)


@app.post("/api/export16")
async def export16(file: UploadFile = File(...), width: int = Form(...), height: int = Form(...), dest: str = Form(...),
                   filename: str = Form(...), sharpen: int = Form(0), metadata_src: str = Form(""), subfolder: str = Form(""),
                   on_existing: str = Form("rename"), dpi: int = Form(0), metadata_mode: str = Form("copy"), copyright: str = Form("")):
    """16-bit TIFF export. The page renders in float and uploads raw little-endian
    uint16 RGB (width*height*3 samples); this writes it losslessly with tiff16."""
    data = await file.read()
    if len(data) != width * height * 6:
        raise HTTPException(400, f"expected {width * height * 6} bytes of RGB16, got {len(data)}")
    arr = np.frombuffer(data, "<u2").reshape(height, width, 3)
    if sharpen:
        arr = _unsharp16(arr, sharpen / 100 * 1.2)
    out_dir = _export_dir(dest, subfolder)
    out, skip = _export_target(out_dir, Path(filename).stem, ".tif", on_existing, metadata_src)
    if skip:
        return {"skipped": True, "path": str(out)}
    meta = {"copyright": copyright}
    if metadata_mode != "none" and metadata_src:
        try:
            with Image.open(metadata_src) as src_im:
                ex = src_im.getexif()
            meta.update({"make": ex.get(271), "model": ex.get(272), "datetime": ex.get(306)})
        except Exception:
            pass
    tmp = out.with_suffix(".tif.part")
    tmp.write_bytes(tiff16.encode(np.ascontiguousarray(arr), dpi=dpi, meta=meta))
    os.replace(tmp, out)
    return {"path": str(out), "width": width, "height": height}


@app.post("/api/image/{iid}/thumb")
async def put_edited_thumb(iid: str, file: UploadFile = File(...)):
    """Store a grid thumbnail rendered from the current edits.

    Thumbnails are decoded from the original file, so an edited photo kept
    showing its untouched self in the library. The edit pipeline is WebGL and
    only exists in the browser, so the browser renders the thumbnail and hands
    it back here, keyed by a hash of the recipe it was rendered from.
    """
    r = _row(iid)
    sig = _edit_sig(r["edits"])
    if not sig:
        return {"stored": False, "reason": "no edits"}
    dest = CACHE_DIR / "thumb_edit" / f"{iid}_{sig}.jpg"
    dest.parent.mkdir(parents=True, exist_ok=True)
    im = Image.open(io.BytesIO(await file.read())).convert("RGB")
    fit(im, THUMB_EDGE).save(dest, "JPEG", quality=86, optimize=True)
    return {"stored": True, "sig": sig}


# ----------------------------------------------------------------------------
# ONNX Runtime device selection — every AI model (denoise, sky, subject,
# people) goes through here, so a GPU build of onnxruntime is used everywhere
# as soon as it is installed. MANTIPHY_AI_DEVICE=cpu forces the CPU.
# ----------------------------------------------------------------------------
_ORT_PREFERENCE = [
    "CUDAExecutionProvider",       # NVIDIA (onnxruntime-gpu)
    "ROCMExecutionProvider",       # AMD, onnxruntime-rocm builds
    "MIGraphXExecutionProvider",   # AMD, newer onnxruntime builds (replaces ROCm EP)
    "OpenVINOExecutionProvider",   # Intel
    "CPUExecutionProvider",
]
_ORT_LABELS = {"CUDAExecutionProvider": "GPU (CUDA)", "ROCMExecutionProvider": "GPU (ROCm)",
               "MIGraphXExecutionProvider": "GPU (MIGraphX)", "OpenVINOExecutionProvider": "OpenVINO",
               "CPUExecutionProvider": "CPU"}
_ai_device_active: Optional[str] = None

# MIGraphX compiles each model for the GPU when a session opens (~2 min for
# denoise); caching the compiled program brings later starts under a second.
# The directory must exist, or the session fails and falls back to the CPU.
_MIGRAPHX_CACHE = CACHE_DIR / "migraphx"
_MIGRAPHX_CACHE.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("ORT_MIGRAPHX_MODEL_CACHE_PATH", str(_MIGRAPHX_CACHE))


def ort_providers() -> list[str]:
    """Execution providers to request, best first, always ending with CPU."""
    try:
        import onnxruntime as ort
        avail = set(ort.get_available_providers())
    except Exception:
        return ["CPUExecutionProvider"]
    if os.environ.get("MANTIPHY_AI_DEVICE", "").lower() == "cpu":
        return ["CPUExecutionProvider"]
    return [p for p in _ORT_PREFERENCE if p in avail] or ["CPUExecutionProvider"]


def _note_ai_device(active_providers: list[str]):
    """Remember what a session actually runs on: onnxruntime lists a GPU provider
    whenever its shim is installed, then quietly falls back to CPU if the driver
    libraries are missing — only the created session knows the truth."""
    global _ai_device_active
    _ai_device_active = _ORT_LABELS.get(active_providers[0], active_providers[0]) if active_providers else "CPU"


def ort_session(model_path: Path):
    """InferenceSession on the best available device, retrying on CPU if the GPU
    provider fails to initialise."""
    import onnxruntime as ort
    prov = ort_providers()
    try:
        sess = ort.InferenceSession(str(model_path), providers=prov)
    except Exception:
        if prov == ["CPUExecutionProvider"]:
            raise
        print(f"AI: {prov[0]} failed to start, using the CPU", file=sys.stderr)
        sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    _note_ai_device(sess.get_providers())
    return sess


def ai_device() -> str:
    """What AI inference runs on — measured once a model has loaded, predicted before."""
    if _ai_device_active:
        return _ai_device_active
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        return "unavailable"
    return _ORT_LABELS.get(ort_providers()[0], ort_providers()[0])


# ----------------------------------------------------------------------------
# AI masks (optional) — rembg for subject/background/people, skyseg.onnx for
# sky with a colour/luminance heuristic fallback when unavailable
# ----------------------------------------------------------------------------


def _ai_available() -> bool:
    try:
        import rembg  # noqa: F401
        return True
    except Exception:
        return False


def _rembg_new_session(name: str):
    """rembg session on the same device choice as every other model (rembg's own
    detection doesn't know MIGraphX), falling back to CPU if the GPU won't start."""
    from rembg import new_session
    prov = ort_providers()
    try:
        sess = new_session(name, providers=prov)
    except Exception:
        if prov == ["CPUExecutionProvider"]:
            raise
        sess = new_session(name, providers=["CPUExecutionProvider"])
    try:
        _note_ai_device(sess.inner_session.get_providers())
    except Exception:
        pass
    return sess


# rembg model per mask kind and quality. "hq" uses BiRefNet — the strongest
# open matting model rembg ships (hair, fur, feathers), ~1 GB and several times
# slower than ISNet on a CPU; with a GPU (./run.sh --with-ai-gpu) it is quick.
_REMBG_MODELS = {
    ("subject", "standard"): None,  # isnet-general-use, or MANTIPHY_REMBG_MODEL
    ("subject", "hq"): "birefnet-general",
    ("people", "standard"): "u2net_human_seg",
    ("people", "hq"): "birefnet-portrait",
}
_rembg_sessions: dict[str, Any] = {}


def _subject_mask(im: Image.Image, model: Optional[str] = None) -> np.ndarray:
    """rembg alpha matte (uint8). model=None is the general-purpose model
    (isnet-general-use, or the MANTIPHY_REMBG_MODEL override). Sessions are
    cached per model name and created on the best available device."""
    from rembg import remove
    name = model or os.environ.get("MANTIPHY_REMBG_MODEL", "isnet-general-use")
    if name not in _rembg_sessions:
        _rembg_sessions[name] = _rembg_new_session(name)
    out = remove(im, session=_rembg_sessions[name], only_mask=True)
    return np.asarray(out.convert("L"))


def _refine_soft_matte(im: Image.Image, alpha: np.ndarray) -> np.ndarray:
    """Recover hair/fur/feather edges a matting model predicted at ~1024 px:
    a guided filter at the photo's own resolution, applied only in the band
    where the matte is undecided, so solid interior and background stay put.
    alpha: float32 0..1 at the image's size. Returns the same."""
    w, h = im.size
    r = max(3, round(max(w, h) / 240))
    g = np.asarray(im.convert("L")).astype(np.float32) / 255.0
    mI, mp = _box_mean(g, r), _box_mean(alpha, r)
    a = (_box_mean(g * alpha, r) - mI * mp) / (_box_mean(g * g, r) - mI * mI + 1e-4)
    b = mp - a * mI
    q = np.clip(_box_mean(a, r) * g + _box_mean(b, r), 0, 1)
    edge = (alpha > 0.02) & (alpha < 0.98)
    band = _box_mean(edge.astype(np.float32), r) > 0
    return np.where(band, q, alpha).astype(np.float32)


def _sky_mask(im: Image.Image) -> np.ndarray:
    """Heuristic sky (no AI model): bright, low-saturation or bluish pixels that are
    connected to the top edge. Connectivity replaces the old "top of frame" ramp,
    which faded the mask out halfway down and missed sky dipping into valleys.
    The result is coarse on purpose; the caller snaps it to edges (_refine_matte)."""
    from PIL import ImageFilter
    w0, h0 = im.size
    small = im.convert("RGB").resize((256, max(1, round(256 * h0 / w0))), Image.BILINEAR)
    a = np.asarray(small).astype(np.float32) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    mx, mn = a.max(-1), a.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-5), 0)
    blueish = np.clip((b - r) * 4 + 0.5, 0, 1)
    score = np.clip(lum * 1.2, 0, 1) * np.clip(1.0 - sat * 1.6 + blueish * 0.8, 0, 1)
    cand = score > 0.35
    # geodesic reconstruction from the top row: grow the seed through candidates only
    reach = np.zeros_like(cand)
    reach[0] = cand[0]
    for _ in range(cand.shape[0] + cand.shape[1]):
        grown = reach.copy()
        grown[1:] |= reach[:-1]; grown[:-1] |= reach[1:]
        grown[:, 1:] |= reach[:, :-1]; grown[:, :-1] |= reach[:, 1:]
        grown &= cand
        if (grown == reach).all():
            break
        reach = grown
    m = reach.astype(np.float32) * np.clip(score / 0.6, 0, 1)
    mi = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5)).resize((w0, h0), Image.BILINEAR)
    return np.asarray(mi)


def _box_mean(a: np.ndarray, r: int) -> np.ndarray:
    """Mean over a (2r+1)^2 window, edge-clamped, via summed-area tables."""
    p = np.pad(a, r + 1, mode="edge").astype(np.float64)
    c = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return (s / (k * k))[: a.shape[0], : a.shape[1]].astype(np.float32)


def _refine_matte(im: Image.Image, prob: np.ndarray, grid: int = 320) -> np.ndarray:
    """Snap a coarse, soft mask to the photo's real edges (iterated guided filter).

    Segmentation models see the frame at a few hundred pixels, so at preview size
    their mask is a blurry blob that is often a cell or two off. Thresholding that
    blob gave staircase edges that bit into whatever met the sky (a ridge line,
    tree tops). The guided filter (He et al.) keeps the mask where the photo is
    flat and lets the photo's own edges place the transition; a window larger than
    the model's error, iterated with a little firming in between, pulls a mask
    that spills over a ridge back onto the ridge. `grid` is the resolution the
    mask was predicted at. Returns float32 0..1 at the image's size."""
    w, h = im.size
    if prob.shape != (h, w):
        prob = np.asarray(Image.fromarray((np.clip(prob, 0, 1) * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)).astype(np.float32) / 255.0
    g = np.asarray(im.convert("L")).astype(np.float32) / 255.0
    r = max(4, round(2.5 * max(w, h) / grid))
    eps = 1e-3
    mI = _box_mean(g, r)
    var = _box_mean(g * g, r) - mI * mI
    q = prob.astype(np.float32)
    for _ in range(3):
        mp = _box_mean(q, r)
        a = (_box_mean(g * q, r) - mI * mp) / (var + eps)
        b = mp - a * mI
        q = _box_mean(a, r) * g + _box_mean(b, r)
        q = np.clip((q - 0.5) * 2.0 + 0.5, 0, 1)
    return q.astype(np.float32)


# Pinned to a commit (not "main") and checked against its SHA-256, so a
# changed upstream file is refused rather than silently run.
_SKYSEG_MODEL_URL = ("https://huggingface.co/JianyuanWang/skyseg/resolve/"
                     "3ba8c6df1d9ba9ff26f637c7ba9568ac11a9aa7f/skyseg.onnx")
_SKYSEG_MODEL_SHA256 = "ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39"
_skyseg_sess = None
_skyseg_failed = False


def _check_sha256(data: bytes, expected: str, what: str):
    """Refuse a downloaded model whose bytes are not the ones this release was
    tested with — a replaced or corrupted file never gets loaded."""
    got = hashlib.sha256(data).hexdigest()
    if got != expected:
        raise RuntimeError(f"downloaded {what} failed its integrity check (sha256 {got[:12]}…, expected {expected[:12]}…)")


def _skyseg_model_path() -> Path:
    """Lazily download the ONNX weight on first use, same pattern as
    _denoise_model_path() above (this codebase has no shared download
    helper — each optional model does its own plain urllib download)."""
    dest = CACHE_DIR / "models" / "skyseg.onnx"
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    import urllib.request
    with urllib.request.urlopen(_SKYSEG_MODEL_URL, timeout=120) as resp:
        data = resp.read()
    _check_sha256(data, _SKYSEG_MODEL_SHA256, "sky model")
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    return dest


def _skyseg_session():
    global _skyseg_sess
    if _skyseg_sess is None:
        _skyseg_sess = ort_session(_skyseg_model_path())
    return _skyseg_sess


def _sky_mask_ai(im: Image.Image) -> np.ndarray:
    """Real segmentation via skyseg.onnx. Preprocessing/postprocessing
    verified against this model's production reference usage (Agisoft
    Metashape's automatic_sky_masking.py, which uses this exact model):
    resize to the model's declared input shape (fixed 320x320 fallback
    if dynamic), ImageNet normalization, NCHW; sigmoid (1-channel output)
    or softmax-then-sky-channel (multi-channel), resize the probability
    back to source size, threshold at 0.5."""
    sess = _skyseg_session()
    inp = sess.get_inputs()[0]
    shape = inp.shape

    def _dim(v, default):
        return v if isinstance(v, int) and v > 0 else default

    in_h = _dim(shape[2], 320) if len(shape) >= 4 else 320
    in_w = _dim(shape[3], 320) if len(shape) >= 4 else 320
    w0, h0 = im.size
    small = im.convert("RGB").resize((in_w, in_h), Image.BILINEAR)
    arr = np.asarray(small).astype(np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    arr = (arr - mean) / std
    arr = arr.transpose(2, 0, 1)[np.newaxis].astype(np.float32)
    out = sess.run(None, {inp.name: arr})[0]
    if out.ndim == 4:
        out = out[0]
    if out.shape[0] == 1:
        prob = 1.0 / (1.0 + np.exp(-out[0]))
    else:
        e = np.exp(out - out.max(axis=0, keepdims=True))
        soft = e / e.sum(axis=0, keepdims=True)
        prob = soft[1] if out.shape[0] > 1 else soft[0]
    # Keep the probability soft: the caller snaps it to the photo's edges with
    # _refine_matte(). A hard 0.5 threshold on a 320px prediction is what made
    # the sky mask staircase and nibble into mountains.
    prob_img = Image.fromarray((np.clip(prob, 0, 1) * 255).astype(np.uint8)).resize((w0, h0), Image.BILINEAR)
    return np.asarray(prob_img)


def _sky_mask_safe(im: Image.Image) -> np.ndarray:
    """kind=sky's entry point: tries the AI model, falls back to the
    colour/luminance heuristic on ANY failure — no --with-ai, download
    failure, corrupt model file, or inference error. Sky always has a
    usable default, unlike subject/background/people which have none.
    Once the AI path has failed (e.g. model download timeout), the
    failure is remembered so later calls skip straight to the heuristic
    instead of re-attempting a slow download every time."""
    global _skyseg_failed
    if _skyseg_failed:
        return _sky_mask(im)
    try:
        return _sky_mask_ai(im)
    except Exception:
        _skyseg_failed = True
        print("sky AI model unavailable, falling back to heuristic sky mask", file=sys.stderr)
        return _sky_mask(im)


@app.post("/api/image/{iid}/aimask")
def ai_mask(iid: str, kind: str = "subject", quality: str = Query("standard", pattern="^(standard|hq)$")):
    r = _row(iid)
    p = Path(r["path"])
    if kind == "sky":
        # v2: soft, edge-refined matte (the v1 cache holds hard-thresholded masks)
        kind_key = "sky_ai_v2" if (CACHE_DIR / "models" / "skyseg.onnx").exists() else "sky_heur_v2"
    else:
        # v2: edges refined at preview resolution
        kind_key = f"{kind}_{quality}_v2"
    cp = CACHE_DIR / "mask" / f"{iid}_{int(r['mtime'])}_{kind_key}.png"
    if cp.exists():
        return FileResponse(cp, media_type="image/png")
    pv = Image.open(ensure_preview(p, iid, r["mtime"])).convert("RGB")
    work = fit(pv, 1024)
    if kind in ("subject", "background", "people"):
        if not _ai_available():
            raise HTTPException(501, "AI subject/people masks need the optional 'rembg' package: ./run.sh --with-ai")
        model = _REMBG_MODELS[("people" if kind == "people" else "subject", quality)]
        try:
            m = _subject_mask(work, model=model)
        except Exception as e:
            raise HTTPException(500, f"AI mask failed: {e}")
        alpha = np.asarray(Image.fromarray(m).resize(pv.size, Image.BILINEAR)).astype(np.float32) / 255.0
        alpha = _refine_soft_matte(pv, alpha)
        if kind == "background":
            alpha = 1.0 - alpha
        m = (alpha * 255 + 0.5).astype(np.uint8)
    elif kind == "sky":
        # refine against the full preview, not the 1024px working copy, so the
        # edge follows the ridge line at the resolution it is displayed at
        m = _sky_mask_safe(work)
        m = (_refine_matte(pv, m.astype(np.float32) / 255.0) * 255).astype(np.uint8)
    else:
        raise HTTPException(400, "kind must be subject|background|people|sky")
    Image.fromarray(m).resize(pv.size, Image.BILINEAR).save(cp, "PNG")
    return FileResponse(cp, media_type="image/png")


@app.get("/api/skies")
def sky_list():
    return skylib.list_recipes()


@app.get("/api/skies/{sky_id}")
def sky_image(sky_id: str, res: str = "thumb"):
    if res not in ("thumb", "full"):
        raise HTTPException(400, "res must be thumb|full")
    try:
        recipe = skylib.get_recipe(sky_id)
    except KeyError:
        raise HTTPException(404, "unknown sky id")
    cp = CACHE_DIR / "skies" / f"{sky_id}_{res}.png"
    if not cp.exists():
        if res == "full":
            skylib.generate_sky(recipe, 2400, 1600).save(cp, "PNG")
        else:
            full_cp = CACHE_DIR / "skies" / f"{sky_id}_full.png"
            if full_cp.exists():
                full_img = Image.open(full_cp)
            else:
                full_img = skylib.generate_sky(recipe, 2400, 1600)
                full_img.save(full_cp, "PNG")
            full_img.resize((400, 267), Image.LANCZOS).save(cp, "PNG")
    return FileResponse(cp, media_type="image/png")


# ----------------------------------------------------------------------------
# Lens correction (optional) — lensfun profile database, distortion + vignetting
# ----------------------------------------------------------------------------
_lensfun_db = None
_LENSFUN_SCORE_FLOOR = 40  # below this, lensfunpy's fuzzy match is noise (garbage inputs score ~15-21; real matches score 49+)


def _get_lensfun_db():
    global _lensfun_db
    if _lensfun_db is None:
        import lensfunpy
        _lensfun_db = lensfunpy.Database()
    return _lensfun_db


def match_lens_profile(camera: str | None, lens_name: str | None, focal: float | None, aperture: float | None) -> dict:
    """Match a photo's EXIF-derived camera/lens strings against the bundled
    lensfun database and return interpolated distortion + vignetting
    coefficients for its actual focal length / aperture. Returns
    {"matched": False} on any missing input, no match, or a match below
    the confidence floor — never raises."""
    if not camera or not lens_name or not focal or not aperture:
        return {"matched": False}
    try:
        db = _get_lensfun_db()
        cams = db.find_cameras(None, camera, loose_search=True)
        if not cams or cams[0].score < _LENSFUN_SCORE_FLOOR:
            return {"matched": False}
        cam = cams[0]
        lenses = db.find_lenses(cam, None, lens_name, loose_search=True)
        if not lenses or lenses[0].score < _LENSFUN_SCORE_FLOOR:
            return {"matched": False}
        lens = lenses[0]
        dist = lens.interpolate_distortion(focal)
        vig = lens.interpolate_vignetting(focal, aperture, 1000.0)
        dist_model_names = {0: "none", 1: "poly3", 2: "poly5", 3: "ptlens"}
        dist_terms = list(dist.terms) + [0.0, 0.0, 0.0]
        vig_terms = list(vig.terms) + [0.0, 0.0, 0.0]
        return {
            "matched": True,
            "cameraName": cam.model,
            "lensName": lens.model,
            "distortion": {"model": dist_model_names.get(dist.model.value, "none"), "terms": dist_terms[:3]},
            "vignetting": {"model": "pa" if vig.model.value == 1 else "none", "terms": vig_terms[:3]},
            # lensfun coefficients are normalised to the sensor the lens was calibrated
            # on; a body with a different crop factor sees a smaller/larger image circle.
            "radiusScale": (lens.crop_factor / cam.crop_factor) if lens.crop_factor and cam.crop_factor else 1.0,
        }
    except Exception:
        return {"matched": False}


@app.get("/api/image/{iid}/lensprofile")
def lens_profile(iid: str):
    with db() as con:
        r = con.execute("SELECT camera,lens,focal,aperture FROM images WHERE id=?", (iid,)).fetchone()
    if not r:
        raise HTTPException(404, "Unknown image")
    return match_lens_profile(r["camera"], r["lens"], r["focal"], r["aperture"])


# ----------------------------------------------------------------------------
# Object removal (optional) — LaMa inpainting, GPU auto-detected via torch
# ----------------------------------------------------------------------------
_lama = None
_lama_device = None


def _inpaint_available() -> bool:
    try:
        import simple_lama_inpainting  # noqa: F401
        return True
    except Exception:
        return False


def _inpaint_device() -> str:
    """Report what device inpainting will actually run on, without loading the model."""
    global _lama_device
    if _lama_device:
        return _lama_device
    try:
        import torch
        _lama_device = f"cuda ({torch.cuda.get_device_name(0)})" if torch.cuda.is_available() else "cpu"
    except Exception:
        _lama_device = "unavailable"
    return _lama_device


def _lama_model():
    """Lazily load LaMa. simple_lama_inpainting picks CUDA automatically when torch reports it
    available, otherwise falls back to CPU — no config needed on your side."""
    global _lama
    if _lama is None:
        from simple_lama_inpainting import SimpleLama
        _lama = SimpleLama()
    return _lama


def _run_inpaint(image: Image.Image, mask: Image.Image) -> Image.Image:
    lama = _lama_model()
    with _decode_lock:  # the model isn't thread-safe / GPU shouldn't be hammered concurrently
        return lama(image.convert("RGB"), mask.convert("L"))


# ----------------------------------------------------------------------------
# AI denoise (optional) — NIND U-Net ONNX model, tiled inference
# ----------------------------------------------------------------------------
_DENOISE_MODEL_URL = (
    "https://github.com/darktable-org/darktable-ai/releases/download/"
    "release-5.6.0/denoise-nind.dtmodel"
)
_DENOISE_MODEL_SHA256 = "5d615c5026a3c579455b9082f72b91e109adb54f4125b5b5cde45983bd6776b2"  # the .onnx inside
_denoise_sess = None


def _denoise_available() -> bool:
    try:
        import onnxruntime  # noqa: F401
        return True
    except Exception:
        return False


def _denoise_model_path() -> Path:
    """Lazily download+extract the ONNX weight on first use. The .dtmodel
    release asset is a zip; we don't hardcode its internal layout, just grab
    the one .onnx file inside."""
    dest = CACHE_DIR / "models" / "denoise-nind.onnx"
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    import io as _io
    import urllib.request
    import zipfile
    with urllib.request.urlopen(_DENOISE_MODEL_URL, timeout=120) as resp:
        data = resp.read()
    with zipfile.ZipFile(_io.BytesIO(data)) as zf:
        onnx_name = next((n for n in zf.namelist() if n.endswith(".onnx")), None)
        if onnx_name is None:
            raise RuntimeError("downloaded model archive contains no .onnx file")
        onnx = zf.read(onnx_name)
        _check_sha256(onnx, _DENOISE_MODEL_SHA256, "denoise model")
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(onnx)
        os.replace(tmp, dest)
    return dest


def _denoise_session():
    """Lazily load the ONNX Runtime session on the best available device."""
    global _denoise_sess
    if _denoise_sess is None:
        _denoise_sess = ort_session(_denoise_model_path())
    return _denoise_sess


def _run_denoise(im: Image.Image, tile_size: int = 768, overlap: int = 64) -> Image.Image:
    """Tiled inference: mirror-pads tile edges, runs the (fixed-size) model
    tile by tile, and stitches by writing only each tile's core region —
    matching darktable-ai's reference implementation for this model."""
    sess = _denoise_session()
    input_name = sess.get_inputs()[0].name
    arr = np.asarray(im.convert("RGB")).astype(np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)[np.newaxis]  # (1, 3, H, W)
    _, _, H, W = arr.shape
    T, O = tile_size, overlap
    step = T - 2 * O
    n_y = (H + step - 1) // step
    n_x = (W + step - 1) // step
    pad_after_y = max(O, (n_y - 1) * step + T - H - O)
    pad_after_x = max(O, (n_x - 1) * step + T - W - O)
    padded = np.pad(arr, ((0, 0), (0, 0), (O, pad_after_y), (O, pad_after_x)), mode="reflect")
    out = np.zeros_like(arr)
    for ty in range(n_y):
        core_y = ty * step
        core_h = min(step, H - core_y)
        for tx in range(n_x):
            core_x = tx * step
            core_w = min(step, W - core_x)
            tile = np.ascontiguousarray(padded[:, :, core_y:core_y + T, core_x:core_x + T])
            with _decode_lock:  # rate-limit only the inference call itself, not the whole tile loop
                [tile_out] = sess.run(None, {input_name: tile})
            out[:, :, core_y:core_y + core_h, core_x:core_x + core_w] = \
                tile_out[:, :, O:O + core_h, O:O + core_w].astype(np.float32)
    out = np.clip(out[0].transpose(1, 2, 0), 0, 1)
    return Image.fromarray((out * 255).astype(np.uint8))


@app.post("/api/image/{iid}/inpaint")
async def inpaint(iid: str, res: str = Query("preview", pattern="^(preview|full)$"), mask: UploadFile = File(...)):
    """Paint-out object removal. `mask` is a PNG (white = remove, same pixel size as the
    preview/full image being edited). Returns the inpainted PNG. Results are cached by a hash
    of the mask so re-sending the same stroke set is instant."""
    if not _inpaint_available():
        raise HTTPException(501, "Object removal needs the optional 'simple-lama-inpainting' package (and torch): "
                                  "pip install simple-lama-inpainting torch")
    r = _row(iid)
    p = Path(r["path"])
    src_path = ensure_preview(p, iid, r["mtime"]) if res == "preview" else ensure_full(p, iid, r["mtime"])
    mask_bytes = await mask.read()
    h = hashlib.sha1(mask_bytes).hexdigest()[:16]
    cp = CACHE_DIR / "heal" / f"{iid}_{int(r['mtime'])}_{res}_{h}.png"
    if cp.exists():
        return FileResponse(cp, media_type="image/png")
    src = Image.open(src_path).convert("RGB")
    m = Image.open(io.BytesIO(mask_bytes)).convert("L").resize(src.size, Image.NEAREST)
    if not m.getbbox() or m.getextrema()[1] == 0:
        # nothing painted — hand back the source unchanged rather than call the model
        src.save(cp, "PNG")
        return FileResponse(cp, media_type="image/png")
    try:
        out = _run_inpaint(src, m)
    except Exception as e:
        raise HTTPException(500, f"Inpainting failed: {e}")
    out.save(cp, "PNG")
    return FileResponse(cp, media_type="image/png")


def _noise_sigma(noisy: Image.Image, clean: Image.Image) -> float:
    """Noise level the denoiser removed, as a robust std (MAD) of the luminance
    difference, in 0..1 units. Real texture is sparse next to sensor noise, so
    the median ignores it; the Develop pass uses this to tell the two apart."""
    a = np.asarray(noisy.convert("L"), dtype=np.float32)
    b = np.asarray(clean.convert("L").resize(noisy.size), dtype=np.float32)
    d = (a - b)[::2, ::2] / 255.0
    return float(1.4826 * np.median(np.abs(d - np.median(d))))


@app.post("/api/image/{iid}/denoise")
def denoise(iid: str, res: str = Query("preview", pattern="^(preview|full)$")):
    """AI noise reduction (NIND ONNX model). Deterministic given iid+mtime+res,
    so — like /inpaint — the result is cached and a repeat call is instant.
    X-Noise-Sigma carries the measured noise level (see _noise_sigma)."""
    r = _row(iid)
    p = Path(r["path"])
    cp = CACHE_DIR / "denoise" / f"{iid}_{int(r['mtime'])}_{res}.png"
    sp = cp.with_suffix(".sigma")
    if not cp.exists():
        if not _denoise_available():
            raise HTTPException(501, "AI denoise needs the optional 'onnxruntime' package: pip install onnxruntime")
        src_path = ensure_preview(p, iid, r["mtime"]) if res == "preview" else ensure_full(p, iid, r["mtime"])
        im = Image.open(src_path).convert("RGB")
        try:
            out = _run_denoise(im)
        except Exception as e:
            raise HTTPException(500, f"AI denoise failed: {e}")
        out.save(cp, "PNG")
        sp.write_text(f"{_noise_sigma(im, out):.6f}")
    if not sp.exists():  # cached before the noise level was recorded
        src_path = ensure_preview(p, iid, r["mtime"]) if res == "preview" else ensure_full(p, iid, r["mtime"])
        sp.write_text(f"{_noise_sigma(Image.open(src_path), Image.open(cp)):.6f}")
    return FileResponse(cp, media_type="image/png", headers={"X-Noise-Sigma": sp.read_text().strip()})


# ----------------------------------------------------------------------------
# Static frontend
# ----------------------------------------------------------------------------
class _NoCacheStatic(StaticFiles):
    """Serve the frontend with revalidation forced.

    Without a Cache-Control header the browser falls back to heuristic
    freshness and keeps serving index.html / app.js from its disk cache, so an
    updated app keeps showing the old UI until the cache is cleared by hand —
    and the cache outlives the window, so closing and reopening does not help.
    "no-cache" means revalidate, not "do not store": the ETag still makes an
    unchanged file a 304 with no body.
    """

    async def get_response(self, path: str, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/", _NoCacheStatic(directory=str(FRONTEND), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    print(f"\n  Mantiphy  →  http://127.0.0.1:{PORT}\n  data: {DATA_DIR}\n  cache: {CACHE_DIR}\n")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
