"""Standalone check that downloaded models are refused when their bytes do
not match the pinned SHA-256, and that a tampered cached copy is never used.
No network, no pytest.

Run with:

    .venv/bin/python -m backend.test_modelintegrity
"""
import io
import os
import tempfile
import urllib.request
from pathlib import Path

import backend.server as server


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _offline(payload: bytes):
    saved = urllib.request.urlopen
    urllib.request.urlopen = lambda *a, **k: _FakeResponse(payload)
    return saved


def test_tampered_lama_is_refused_everywhere():
    tmp = Path(tempfile.mkdtemp())
    saved_cache, saved_home = server.CACHE_DIR, os.environ.get("TORCH_HOME")
    server.CACHE_DIR = tmp / "cache"
    os.environ["TORCH_HOME"] = str(tmp / "torch")
    hub = tmp / "torch" / "hub" / "checkpoints" / "big-lama.pt"
    hub.parent.mkdir(parents=True)
    hub.write_bytes(b"tampered weights")                 # a cached copy that was swapped
    saved_open = _offline(b"also not the real model")    # and a download that is not the real file
    try:
        try:
            server._lama_model_path()
            raise AssertionError("a model with the wrong SHA-256 was accepted")
        except RuntimeError as e:
            assert "integrity" in str(e), e
        assert not (server.CACHE_DIR / "models" / "big-lama.pt").exists(), "bad download was kept"
    finally:
        urllib.request.urlopen = saved_open
        server.CACHE_DIR = saved_cache
        if saved_home is None:
            os.environ.pop("TORCH_HOME", None)
        else:
            os.environ["TORCH_HOME"] = saved_home


def test_tampered_sky_download_is_refused():
    tmp = Path(tempfile.mkdtemp())
    saved_cache = server.CACHE_DIR
    server.CACHE_DIR = tmp
    (tmp / "models").mkdir()
    (tmp / "models" / "skyseg.onnx").write_bytes(b"swapped")   # a tampered cached copy
    saved_open = _offline(b"not an onnx model")
    try:
        try:
            server._skyseg_model_path()
            raise AssertionError("sky model with the wrong SHA-256 was accepted")
        except RuntimeError as e:
            assert "integrity" in str(e), e
        assert (tmp / "models" / "skyseg.onnx").read_bytes() == b"swapped", "only a verified file may replace it"
    finally:
        urllib.request.urlopen = saved_open
        server.CACHE_DIR = saved_cache


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok ", name)
    print("OK")
