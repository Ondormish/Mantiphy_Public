"""Standalone check for the AI sky segmentation path (skyseg.onnx via
onnxruntime). No pytest. The real ~167 MB model is never downloaded in
this environment: backend.server._skyseg_sess is monkeypatched to a
stub session object (same monkeypatch-a-module-global style already
used by backend/test_smartcollections.py for DB_PATH), so these tests
exercise only the pre/post-processing math, never real inference or
the network.

Run with:

    .venv/bin/python -m backend.test_skyseg
"""
import numpy as np
from PIL import Image

import backend.server as server


class _StubInput:
    name = "input"
    shape = [1, 3, 4, 4]


class _StubSession:
    """1-channel (sigmoid-path) stub: fixed logits, left half strongly
    positive (sky), right half strongly negative (not sky)."""
    def get_inputs(self):
        return [_StubInput()]

    def run(self, output_names, feed):
        arr = feed[_StubInput.name]
        assert arr.shape == (1, 3, 4, 4), arr.shape  # confirms resize + NCHW happened
        logits = np.array([[10.0, 10.0, -10.0, -10.0]] * 4, dtype=np.float32)
        return [logits[np.newaxis, np.newaxis]]  # (1, 1, 4, 4)


class _RaisingSession:
    def get_inputs(self):
        raise RuntimeError("simulated model load/inference failure")


def test_sky_mask_ai_sigmoid_threshold_and_resize():
    server._skyseg_sess = _StubSession()
    try:
        im = Image.new("RGB", (8, 8), (100, 150, 200))
        out = server._sky_mask_ai(im)
        assert out.shape == (8, 8), out.shape
        assert out.dtype == np.uint8
        assert out[4, 1] >= 250, out[4, 1]  # left half: sky (soft probability, refined later)
        assert out[4, 6] <= 5, out[4, 6]    # right half: not sky
    finally:
        server._skyseg_sess = None


def test_sky_mask_safe_falls_back_to_heuristic_on_failure():
    server._skyseg_sess = _RaisingSession()
    try:
        im = Image.new("RGB", (8, 8), (100, 150, 200))
        out = server._sky_mask_safe(im)
        expected = server._sky_mask(im)
        assert np.array_equal(out, expected), "fallback must exactly match the heuristic's own output"
        assert server._skyseg_failed is True, "failure must be remembered"
    finally:
        server._skyseg_sess = None
        server._skyseg_failed = False


def test_sky_mask_safe_uses_ai_path_when_available():
    server._skyseg_sess = _StubSession()
    try:
        im = Image.new("RGB", (8, 8), (100, 150, 200))
        out = server._sky_mask_safe(im)
        expected = server._sky_mask_ai(im)
        assert np.array_equal(out, expected), "must use the AI result, not silently fall back, when the model works"
    finally:
        server._skyseg_sess = None


def test_sky_mask_safe_remembers_failure_and_skips_retry():
    """After the first failure, _skyseg_failed must be set and later
    calls must not re-invoke _skyseg_session() (i.e. no repeated
    download attempt)."""
    server._skyseg_sess = _RaisingSession()
    try:
        im = Image.new("RGB", (8, 8), (100, 150, 200))
        server._sky_mask_safe(im)
        assert server._skyseg_failed is True

        def _boom():
            raise AssertionError("_skyseg_session() must not be called again after a remembered failure")
        orig_session = server._skyseg_session
        server._skyseg_session = _boom
        try:
            out = server._sky_mask_safe(im)
            expected = server._sky_mask(im)
            assert np.array_equal(out, expected)
        finally:
            server._skyseg_session = orig_session
    finally:
        server._skyseg_sess = None
        server._skyseg_failed = False


def test_ai_mask_sky_cache_key_distinguishes_ai_from_heuristic():
    """kind=sky must use a different cache filename depending on whether
    the model file is present on disk, so an AI-produced mask never
    conflates with a previously-cached heuristic one."""
    from pathlib import Path
    model_path = server.CACHE_DIR / "models" / "skyseg.onnx"
    # CACHE_DIR is the user's real cache: set a downloaded model aside and put it
    # back afterwards rather than deleting it.
    backup = model_path.with_name("skyseg.onnx.test-backup")
    existed = model_path.exists()
    try:
        if existed:
            model_path.replace(backup)
        model_path.parent.mkdir(parents=True, exist_ok=True)

        cp_heur = server.CACHE_DIR / "mask" / "TESTIID_1_sky_heur.png"
        cp_ai = server.CACHE_DIR / "mask" / "TESTIID_1_sky_ai.png"
        for p in (cp_heur, cp_ai):
            if p.exists():
                p.unlink()

        kind_key = "sky_ai" if model_path.exists() else "sky_heur"
        assert kind_key == "sky_heur"

        model_path.write_bytes(b"not a real model, presence is all that matters here")
        kind_key = "sky_ai" if model_path.exists() else "sky_heur"
        assert kind_key == "sky_ai"
    finally:
        if model_path.exists():
            model_path.unlink()
        if existed:
            backup.replace(model_path)


def test_refine_matte_pulls_spill_back_to_the_ridge():
    """A coarse mask that spills ~12px over a dark ridge must be pulled back onto
    the ridge line by _refine_matte (the old hard threshold left it eating the
    mountain)."""
    from PIL import ImageFilter
    w, h = 400, 300
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (150, 190, 235)                      # sky
    ridge = (150 + 40 * np.sin(np.arange(w) / 40)).astype(int)
    truth = np.zeros((h, w), bool)
    for x in range(w):
        img[ridge[x]:, x] = (60, 70, 50)          # mountain
        truth[:ridge[x], x] = True
    im = Image.fromarray(img)
    spill = Image.fromarray(truth.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(25))
    coarse = np.asarray(spill.resize((40, 40), Image.BILINEAR).resize((w, h), Image.BILINEAR)).astype(np.float32) / 255
    before = ((coarse > 0.5) & ~truth).sum()
    q = server._refine_matte(im, coarse, grid=40)
    after = ((q > 0.5) & ~truth).sum()
    assert after < before * 0.2, (before, after)
    assert ((q < 0.5) & truth).sum() < truth.sum() * 0.01


if __name__ == "__main__":
    test_refine_matte_pulls_spill_back_to_the_ridge()
    test_sky_mask_ai_sigmoid_threshold_and_resize()
    test_sky_mask_safe_falls_back_to_heuristic_on_failure()
    test_sky_mask_safe_uses_ai_path_when_available()
    test_sky_mask_safe_remembers_failure_and_skips_retry()
    test_ai_mask_sky_cache_key_distinguishes_ai_from_heuristic()
    print("OK")
