"""Standalone check that bad API input gets a 4xx instead of a crash or a
broken catalog, and that 16-bit export treats existing files like the
8-bit one. Runs against a throwaway catalog and cache. No pytest.

Run with:

    .venv/bin/python -m backend.test_apivalidation
"""
import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp())
os.environ["MANTIPHY_DATA"] = str(_TMP / "data")
os.environ["MANTIPHY_CACHE"] = str(_TMP / "cache")
os.environ["MANTIPHY_SIDECARS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import backend.server as server  # noqa: E402

client = TestClient(server.app, base_url=f"http://127.0.0.1:{server.PORT}")


def test_unknown_image_is_404():
    assert client.patch("/api/image/nope", json={"rating": 3}).status_code == 404
    assert client.post("/api/images/batch", json={"ids": ["nope"], "changes": {"rating": 3}}).status_code == 404


def test_out_of_range_values_are_400():
    for bad in ({"rating": 999999999}, {"rating": -1}, {"rating": "3"}, {"rating": True},
                {"flag": "maybe"}, {"label": "<b>"}, {"keywords": 5}, {"edits": []}):
        r = client.patch("/api/image/nope", json=bad)
        assert r.status_code == 400, (bad, r.status_code)
        r = client.post("/api/images/batch", json={"ids": [], "changes": bad})
        assert r.status_code == 400, (bad, r.status_code)


def test_unknown_export_format_is_400():
    r = client.post("/api/export", files={"file": ("x.png", b"-", "image/png")},
                    data={"dest": str(_TMP / "out"), "filename": "x", "fmt": "gif"})
    assert r.status_code == 400, r.status_code


def _export16(dest: Path, on_existing: str):
    w = h = 2
    return client.post("/api/export16", files={"file": ("x.raw", bytes(w * h * 6), "application/octet-stream")},
                       data={"width": w, "height": h, "dest": str(dest), "filename": "DSC_0001.NEF",
                             "on_existing": on_existing}).json()


def test_export16_overwrite_keeps_the_existing_files_casing():
    dest = _TMP / "tif"; dest.mkdir()
    (dest / "DSC_0001.TIF").write_bytes(b"old")
    r = _export16(dest, "overwrite")
    assert Path(r["path"]).name == "DSC_0001.TIF", r
    assert sorted(p.name for p in dest.iterdir()) == ["DSC_0001.TIF"]
    r = _export16(dest, "rename")
    assert Path(r["path"]).name == "DSC_0001-1.tif", r
    assert _export16(dest, "skip").get("skipped") is True


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok ", name)
    print("OK")
