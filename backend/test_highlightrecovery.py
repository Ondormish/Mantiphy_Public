"""Standalone check for the 16-bit highlight-recovery decode path. No
pytest — matches this codebase's existing convention.

Run with:

    .venv/bin/python -m backend.test_highlightrecovery
"""
import struct
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

from backend.server import decode, decode16, fit16, ensure_preview16


def test_decode_unchanged_still_returns_uint8():
    """Non-regression guard: decode() (used by HDR merge and Panorama)
    must never be touched by this chantier — it must keep returning an
    8-bit PIL Image, dtype uint8 when converted to an array."""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "photo.jpg"
        Image.new("RGB", (12, 8), (100, 150, 200)).save(p, "JPEG")
        im = decode(p)
        arr = np.asarray(im)
        assert arr.dtype == np.uint8, arr.dtype
        assert im.mode == "RGB", im.mode


def test_decode16_non_raw_scales_to_uint16_range():
    """A non-RAW file (already 8-bit, camera-baked) gets no highlight
    recovery, but decode16() must still return uint16 RGBA, scaled by
    257 (255*257 == 65535, the exact 8-bit-to-16-bit range scale)."""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "photo.jpg"
        # (100, 150, 201) round-trips exactly through JPEG's RGB<->YCbCr
        # conversion (verified empirically); 200 does not (decodes back
        # as 199 due to color-space rounding, unrelated to decode16()).
        Image.new("RGB", (12, 8), (100, 150, 201)).save(p, "JPEG")
        arr = decode16(p)
        assert arr.dtype == np.uint16, arr.dtype
        assert arr.shape == (8, 12, 4), arr.shape
        assert arr[0, 0, 0] == 100 * 257, arr[0, 0, 0]
        assert arr[0, 0, 1] == 150 * 257, arr[0, 0, 1]
        assert arr[0, 0, 2] == 201 * 257, arr[0, 0, 2]
        assert arr[0, 0, 3] == 65535, arr[0, 0, 3]  # alpha always opaque


def test_fit16_resizes_and_preserves_uint16():
    arr = np.zeros((100, 200, 4), dtype=np.uint16)
    arr[..., 0] = 40000
    arr[..., 3] = 65535
    out = fit16(arr, 100)
    assert max(out.shape[:2]) <= 100, out.shape
    assert out.dtype == np.uint16, out.dtype
    assert out[0, 0, 0] == 40000, out[0, 0, 0]
    assert out[0, 0, 3] == 65535, out[0, 0, 3]


def test_fit16_no_op_when_already_smaller_than_edge():
    arr = np.zeros((10, 20, 4), dtype=np.uint16)
    out = fit16(arr, 2560)
    assert out.shape == arr.shape, out.shape
    assert out is arr  # early-return path, same object, matching fit()'s own behavior


def test_ensure_preview16_writes_readable_raw16_file():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "photo.jpg"
        Image.new("RGB", (12, 8), (10, 20, 30)).save(p, "JPEG")
        cp = ensure_preview16(p, "TESTIID2", 12345.0)
        assert cp.exists()
        data = cp.read_bytes()
        w, h = struct.unpack("<II", data[:8])
        assert (w, h) == (12, 8), (w, h)
        pixels = np.frombuffer(data[8:], dtype="<u2").reshape(h, w, 4)
        assert pixels[0, 0, 0] == 10 * 257, pixels[0, 0, 0]
        assert pixels[0, 0, 3] == 65535, pixels[0, 0, 3]


if __name__ == "__main__":
    test_decode_unchanged_still_returns_uint8()
    test_decode16_non_raw_scales_to_uint16_range()
    test_fit16_resizes_and_preserves_uint16()
    test_fit16_no_op_when_already_smaller_than_edge()
    test_ensure_preview16_writes_readable_raw16_file()
    print("OK")
