"""Standalone check for the local-only guard (DNS rebinding and cross-site
requests). No pytest.

Run with:

    .venv/bin/python -m backend.test_localonly
"""
from fastapi.testclient import TestClient

import backend.server as server

OK_BASE = f"http://127.0.0.1:{server.PORT}"


def test_own_host_and_origin_are_served():
    c = TestClient(server.app, base_url=OK_BASE)
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/health", headers={"Origin": OK_BASE, "Sec-Fetch-Site": "same-origin"}).status_code == 200
    assert TestClient(server.app, base_url=f"http://localhost:{server.PORT}").get("/api/health").status_code == 200


def test_rebound_host_is_refused():
    """A hostile domain resolving to 127.0.0.1 arrives with its own Host header."""
    c = TestClient(server.app, base_url="http://evil.example")
    assert c.get("/api/fs", params={"path": "/etc"}).status_code == 403
    c = TestClient(server.app, base_url="http://127.0.0.1:1")   # right address, wrong port
    assert c.get("/api/health").status_code == 403


def test_cross_site_requests_are_refused():
    c = TestClient(server.app, base_url=OK_BASE)
    files = {"file": ("x.png", b"not read", "image/png")}
    form = {"dest": "/tmp/mantiphy-should-not-exist", "filename": "owned", "fmt": "png"}
    r = c.post("/api/export", files=files, data=form, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403, r.status_code
    r = c.post("/api/export", files=files, data=form, headers={"Origin": "null"})   # sandboxed iframe
    assert r.status_code == 403, r.status_code
    r = c.post("/api/export", files=files, data=form, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403, r.status_code
    r = c.get("/api/health", headers={"Origin": f"http://127.0.0.1:{server.PORT + 1}"})   # another local app
    assert r.status_code == 403, r.status_code


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok ", name)
    print("OK")
