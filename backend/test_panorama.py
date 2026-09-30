"""Standalone check for panorama stitching. No pytest — matches this
codebase's existing convention (see backend/test_hdr.py). Run with:

    .venv/bin/python -m backend.test_panorama
"""
import numpy as np
from PIL import Image

from backend.server import _panorama_available, _stitch_panorama, PanoramaStitchFailed


def _textured_scene(w=600, h=350, seed=7):
    """One wide synthetic scene with scattered, distinctly-colored
    circles — rich enough in corner-like features for OpenCV's
    Stitcher to find reliable matches. A smooth gradient was tried
    first and found insufficiently feature-rich (Stitcher couldn't
    find enough matches to stitch it) — this fixture must stay
    textured, not smooth."""
    rng = np.random.default_rng(seed)
    scene = np.full((h, w, 3), 40, np.uint8)
    img = Image.fromarray(scene, "RGB")
    import PIL.ImageDraw as ImageDraw
    draw = ImageDraw.Draw(img)
    for _ in range(300):
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        r = int(rng.integers(4, 20))
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color, outline=(255, 255, 255))
    return img


def _overlapping_crops(scene, n=4, crop_w=300, step=100):
    """n horizontally-overlapping crops of one scene (each crop_w wide,
    offset by step — a large majority overlap between neighbors)."""
    w, h = scene.size
    crops = []
    for i in range(n):
        x0 = i * step
        x1 = min(x0 + crop_w, w)
        crops.append(scene.crop((x0, 0, x1, h)))
    return crops


def test_stitch_returns_larger_image():
    scene = _textured_scene()
    crops = _overlapping_crops(scene)
    pano = _stitch_panorama(crops)
    assert pano.mode == "RGB", pano.mode
    assert pano.size[0] > crops[0].size[0], pano.size


def test_stitch_handles_no_overlap():
    rng = np.random.default_rng(1)
    noise = [Image.fromarray(rng.integers(0, 255, (200, 200, 3), dtype=np.uint8), "RGB") for _ in range(3)]
    try:
        _stitch_panorama(noise)
        assert False, "expected PanoramaStitchFailed"
    except PanoramaStitchFailed:
        pass


def test_panorama_available_never_raises():
    result = _panorama_available()
    assert result in (True, False), result


if __name__ == "__main__":
    test_stitch_returns_larger_image()
    test_stitch_handles_no_overlap()
    test_panorama_available_never_raises()
    print("OK")
