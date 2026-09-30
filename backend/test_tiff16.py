"""Standalone check for the 16-bit TIFF writer (backend/tiff16.py). No pytest.

Run with:

    .venv/bin/python -m backend.test_tiff16
"""
import numpy as np

from backend import tiff16


def test_roundtrip_is_lossless_and_tagged():
    rng = np.random.default_rng(0)
    img = rng.integers(0, 65536, (137, 211, 3), dtype=np.uint16)  # odd sizes: partial last strip
    data = tiff16.encode(img, dpi=300, meta={"make": "Canon", "model": "EOS R5", "copyright": "Me"})
    back, tags = tiff16.decode(data)
    assert np.array_equal(back, img)
    assert tags[258] == (16, 16, 16) and tags[259] == (8,) and tags[317] == (2,)
    assert tags[271].rstrip(b"\0") == b"Canon" and tags[33432].rstrip(b"\0") == b"Me"
    assert 34675 in tags, "sRGB ICC profile must be embedded"


def test_smooth_gradient_compresses():
    x = np.linspace(0, 65535, 1024, dtype=np.float64)
    img = np.stack([np.tile(x, (256, 1))] * 3, -1).astype(np.uint16)
    data = tiff16.encode(img)
    assert len(data) < img.nbytes / 20, len(data)  # predictor makes gradients nearly free


def test_readable_by_tifffile_if_installed():
    try:
        import tifffile
    except ImportError:
        return
    import io
    img = np.random.default_rng(1).integers(0, 65536, (70, 90, 3), dtype=np.uint16)
    assert np.array_equal(tifffile.imread(io.BytesIO(tiff16.encode(img))), img)


if __name__ == "__main__":
    test_roundtrip_is_lossless_and_tagged()
    test_smooth_gradient_compresses()
    test_readable_by_tifffile_if_installed()
    print("OK")
