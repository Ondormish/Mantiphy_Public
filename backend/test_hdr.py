"""Standalone check for HDR exposure-fusion merging. No pytest — matches
this codebase's existing convention (see backend/test_skylib.py). Run
with:

    .venv/bin/python -m backend.test_hdr
"""
import numpy as np
from PIL import Image

from backend.server import _hdr_available, _merge_hdr, HdrDimensionMismatch


def _bracket(w=120, h=80):
    """3 synthetic same-size exposure brackets of one gradient scene:
    dark, normal, bright."""
    base = np.tile(np.linspace(0, 255, w, dtype=np.float32), (h, 1))
    base = np.stack([base] * 3, axis=-1)

    def expose(factor):
        arr = np.clip(base * factor, 0, 255).astype(np.uint8)
        return Image.fromarray(arr, "RGB")

    return [expose(0.4), expose(1.0), expose(1.8)]


def test_merge_returns_same_size_image():
    images = _bracket(120, 80)
    fused = _merge_hdr(images)
    assert fused.size == (120, 80), fused.size
    assert fused.mode == "RGB", fused.mode


def test_merge_rejects_mismatched_dimensions():
    images = _bracket(120, 80)
    images[1] = images[1].resize((100, 80))
    try:
        _merge_hdr(images)
        assert False, "expected HdrDimensionMismatch"
    except HdrDimensionMismatch:
        pass


def test_hdr_available_never_raises():
    result = _hdr_available()
    assert result in (True, False), result


if __name__ == "__main__":
    test_merge_returns_same_size_image()
    test_merge_rejects_mismatched_dimensions()
    test_hdr_available_never_raises()
    print("OK")
