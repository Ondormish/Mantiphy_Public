"""Standalone check for the tiled AI-denoise inference helper.

No pytest, no real ONNX model needed — matches this codebase's existing
convention of manual/standalone verification (there is no test framework
in the repo yet). Run with:

    .venv/bin/python -m backend.test_denoise
"""
import numpy as np
from PIL import Image

from backend import server


class _IdentitySession:
    """Stand-in for onnxruntime.InferenceSession: returns its input unchanged,
    so this test verifies the tiling/stitching math, not the real model."""

    def get_inputs(self):
        return [type("Inp", (), {"name": "input"})()]

    def run(self, _output_names, feeds):
        return [feeds["input"]]


def test_tiling_reconstructs_image_losslessly():
    server._denoise_sess = _IdentitySession()
    rng = np.random.default_rng(0)
    # Deliberately not a multiple of the 768 tile size, and bigger than one
    # tile in both dimensions, so the test exercises padding + multiple tiles.
    im = Image.fromarray((rng.random((500, 900, 3)) * 255).astype(np.uint8))

    out = server._run_denoise(im)

    assert out.size == im.size, f"expected {im.size}, got {out.size}"
    orig = np.asarray(im).astype(np.int16)
    got = np.asarray(out).astype(np.int16)
    # Identity model through a uint8->float32[0,1]->uint8 round trip: allow
    # ±1 for rounding, and the result must be seamless (no tile-edge jumps).
    max_diff = np.abs(orig - got).max()
    assert max_diff <= 1, f"tiling introduced a diff of {max_diff}, expected <=1"


if __name__ == "__main__":
    test_tiling_reconstructs_image_losslessly()
    print("OK")
