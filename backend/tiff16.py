"""Minimal writer for 16-bit-per-channel RGB TIFF files.

Pillow cannot write 48-bit RGB, and the 16-bit export should not need a new
dependency, so this writes a baseline TIFF by hand: little-endian, one IFD,
Adobe Deflate compression with the horizontal-differencing predictor (the
combination Lightroom, Photoshop, darktable and GIMP all read), an embedded
sRGB ICC profile, and a few descriptive tags copied from the source photo.
"""
from __future__ import annotations

import struct
import time
import zlib

import numpy as np

# TIFF field types
_SHORT, _LONG, _RATIONAL, _ASCII, _UNDEFINED = 3, 4, 5, 2, 7


def _srgb_icc() -> bytes | None:
    try:
        from PIL import ImageCms
        return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    except Exception:
        return None


def encode(rgb16: np.ndarray, dpi: int = 0, meta: dict | None = None, rows_per_strip: int = 64) -> bytes:
    """rgb16: (H, W, 3) uint16. meta: optional make/model/datetime/copyright/software/description."""
    if rgb16.dtype != np.uint16 or rgb16.ndim != 3 or rgb16.shape[2] != 3:
        raise ValueError("expected an (H, W, 3) uint16 array")
    H, W = rgb16.shape[:2]
    meta = meta or {}

    # strips: predictor 2 = each sample minus the same channel of the previous pixel
    strips = []
    for y in range(0, H, rows_per_strip):
        block = rgb16[y:y + rows_per_strip].astype(np.int32)
        diff = block.copy()
        diff[:, 1:] -= block[:, :-1]
        strips.append(zlib.compress((diff & 0xFFFF).astype("<u2").tobytes(), 6))

    entries: list[tuple[int, int, int, bytes]] = []  # (tag, type, count, payload)

    def short(tag, *vals):
        entries.append((tag, _SHORT, len(vals), struct.pack("<%dH" % len(vals), *vals)))

    def long_(tag, *vals):
        entries.append((tag, _LONG, len(vals), struct.pack("<%dI" % len(vals), *vals)))

    def ascii_(tag, s):
        if s:
            b = str(s).encode("ascii", "replace") + b"\0"
            entries.append((tag, _ASCII, len(b), b))

    def rational(tag, num, den=1):
        entries.append((tag, _RATIONAL, 1, struct.pack("<II", num, den)))

    long_(256, W)
    long_(257, H)
    short(258, 16, 16, 16)
    short(259, 8)          # Adobe Deflate
    short(262, 2)          # RGB
    ascii_(270, meta.get("description"))
    ascii_(271, meta.get("make"))
    ascii_(272, meta.get("model"))
    long_(273, *([0] * len(strips)))          # StripOffsets, patched below
    short(274, 1)
    short(277, 3)
    long_(278, rows_per_strip)
    long_(279, *[len(s) for s in strips])
    rational(282, dpi or 72)
    rational(283, dpi or 72)
    short(284, 1)
    short(296, 2)          # inch
    ascii_(305, meta.get("software", "Mantiphy"))
    ascii_(306, meta.get("datetime") or time.strftime("%Y:%m:%d %H:%M:%S"))
    short(317, 2)          # horizontal predictor
    ascii_(33432, meta.get("copyright"))
    icc = _srgb_icc()
    if icc:
        entries.append((34675, _UNDEFINED, len(icc), icc))
    entries.sort(key=lambda e: e[0])

    # layout: header | IFD | out-of-line values | strips
    ifd_off = 8
    ifd_size = 2 + 12 * len(entries) + 4
    extra_off = ifd_off + ifd_size
    extra = bytearray()
    offsets_field = {}
    ifd = bytearray(struct.pack("<H", len(entries)))
    for tag, typ, count, payload in entries:
        if len(payload) <= 4:
            val = payload.ljust(4, b"\0")
        else:
            if (extra_off + len(extra)) % 2:
                extra += b"\0"
            val = struct.pack("<I", extra_off + len(extra))
            if tag == 273:
                offsets_field["pos"] = len(extra)
            extra += payload
        if tag == 273 and len(payload) <= 4:
            offsets_field["inline"] = len(ifd) + 8
        ifd += struct.pack("<HHI", tag, typ, count) + val
    ifd += struct.pack("<I", 0)

    data_off = extra_off + len(extra)
    offs, o = [], data_off
    for s in strips:
        offs.append(o)
        o += len(s)
    packed = struct.pack("<%dI" % len(offs), *offs)
    if "inline" in offsets_field:
        p = offsets_field["inline"]
        ifd[p:p + 4] = packed
    else:
        p = offsets_field["pos"]
        extra[p:p + len(packed)] = packed
    return b"II*\0" + struct.pack("<I", ifd_off) + bytes(ifd) + bytes(extra) + b"".join(strips)


def decode(data: bytes) -> np.ndarray:
    """Read back what encode() writes (used by the tests and nothing else)."""
    assert data[:4] == b"II*\0"
    ifd = struct.unpack_from("<I", data, 4)[0]
    n = struct.unpack_from("<H", data, ifd)[0]
    tags = {}
    sizes = {_SHORT: 2, _LONG: 4, _RATIONAL: 8, _ASCII: 1, _UNDEFINED: 1}
    for i in range(n):
        tag, typ, count = struct.unpack_from("<HHI", data, ifd + 2 + 12 * i)
        size = sizes[typ] * count
        off = ifd + 2 + 12 * i + 8 if size <= 4 else struct.unpack_from("<I", data, ifd + 2 + 12 * i + 8)[0]
        raw = data[off:off + size]
        if typ == _SHORT:
            tags[tag] = struct.unpack("<%dH" % count, raw)
        elif typ == _LONG:
            tags[tag] = struct.unpack("<%dI" % count, raw)
        else:
            tags[tag] = raw
    W, H = tags[256][0], tags[257][0]
    rows = []
    for off, cnt in zip(tags[273], tags[279]):
        diff = np.frombuffer(zlib.decompress(data[off:off + cnt]), "<u2").astype(np.uint32).reshape(-1, W, 3)
        rows.append((np.cumsum(diff, axis=1) & 0xFFFF).astype(np.uint16))
    out = np.concatenate(rows)[:H]
    return out, tags
