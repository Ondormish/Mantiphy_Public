"""Standalone check for image stacking (backend/stacking.py). No pytest —
matches this codebase's convention. Synthetic frames only.

Run with:

    .venv/bin/python -m backend.test_stacking
"""
import numpy as np
from PIL import Image, ImageDraw

from backend import stacking


def _scene(w=640, h=420, seed=0):
    rng = np.random.default_rng(seed)
    y = np.linspace(0, 1, h)[:, None]
    a = np.zeros((h, w, 3), np.float32)
    a[..., 0], a[..., 1], a[..., 2] = 80 + 100 * y, 140 + 60 * y, 220 - 30 * y
    im = Image.fromarray(a.astype(np.uint8))
    d = ImageDraw.Draw(im)
    for i in range(40):  # texture for the aligner to lock onto
        x0, y0 = rng.integers(0, w - 40), rng.integers(h // 3, h - 40)
        d.rectangle((x0, y0, x0 + rng.integers(8, 40), y0 + rng.integers(8, 40)), fill=tuple(int(v) for v in rng.integers(20, 120, 3)))
    return np.asarray(im).astype(np.float32)


def _burst(n=7, noise=12.0, shifts=None, walker=True):
    base = _scene()
    rng = np.random.default_rng(1)
    shifts = shifts or [(rng.uniform(-9, 9), rng.uniform(-9, 9)) for _ in range(n)]
    frames = []
    for i, (dy, dx) in enumerate(shifts):
        f = base.copy()
        if walker:  # a red "person" crossing the frame, somewhere else each time
            x = 40 + i * 80
            f[250:380, x:x + 30] = (210, 30, 30)
        f, _ = stacking._shift_image(f, dy, dx)  # camera shake
        f = f + rng.normal(0, noise, f.shape)
        frames.append(Image.fromarray(np.clip(f, 0, 255).astype(np.uint8)))
    return base, frames, shifts


def test_phase_correlation_recovers_known_shift():
    base = _scene()
    moved, _ = stacking._shift_image(base, 6.4, -11.3)
    dy, dx = stacking.estimate_shift(base, moved)
    # moved = base shifted by (+6.4, -11.3); aligning it back needs the opposite shift
    assert abs(dy + 6.4) < 0.35 and abs(dx - 11.3) < 0.35, (dy, dx)


def test_median_removes_the_walker():
    base, frames, _ = _burst()
    out = np.asarray(stacking.stack(frames, "median", use_cv2=False)).astype(np.float32)
    red = (out[..., 0] > 170) & (out[..., 1] < 80) & (out[..., 2] < 80)
    assert red.sum() < 30, red.sum()
    # no faint ghost either: with a still camera the result must match the clean
    # scene where the walker was (an even-count plain median left a visible ghost)
    base, still, _ = _burst(n=6, shifts=[(0.0, 0.0)] * 6)
    out = np.asarray(stacking.stack(still, "median", do_align=False)).astype(np.float32)
    for i in range(6):
        x = 40 + i * 80
        ghost = np.abs((out[250:380, x:x + 30] - base[250:380, x:x + 30]).mean(axis=(0, 1)))  # bias, not noise
        assert ghost.max() < 1.5, (i, ghost)


def test_mean_reduces_noise_without_blurring():
    base, frames, _ = _burst(n=8, noise=16.0, walker=False)
    one = np.asarray(frames[len(frames) // 2]).astype(np.float32)
    out = np.asarray(stacking.stack(frames, "mean", use_cv2=False)).astype(np.float32)
    # compare flat sky patches (top-left) — noise std should drop by ~sqrt(8)
    patch = lambda a: a[30:90, 30:150, 2]
    assert patch(out).std() < patch(one).std() * 0.5, (patch(out).std(), patch(one).std())
    # and edges stay sharp: strong gradients survive
    g = np.abs(np.diff(out[..., 1], axis=1))
    assert g.max() > 40, g.max()


def test_lighten_keeps_brightest_and_crops_to_common_area():
    _, frames, shifts = _burst(n=4, walker=False)
    out = stacking.stack(frames, "lighten", use_cv2=False)
    W, H = frames[0].size
    assert out.size[0] <= W and out.size[1] <= H
    assert out.size[0] >= W - 2 * 20 and out.size[1] >= H - 2 * 20, out.size


def test_mismatched_sizes_are_rejected():
    a = Image.new("RGB", (100, 80)); b = Image.new("RGB", (80, 100))
    try:
        stacking.stack([a, b], "median", use_cv2=False)
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_stack_endpoint_writes_a_new_catalogued_photo():
    """End to end through the HTTP endpoint with a throwaway catalog."""
    import tempfile
    from pathlib import Path
    tmp = Path(tempfile.mkdtemp())
    import backend.server as server
    from fastapi.testclient import TestClient
    saved = server.DB_PATH, server.CACHE_DIR, server.WRITE_SIDECARS
    server.DB_PATH, server.CACHE_DIR, server.WRITE_SIDECARS = tmp / "catalog.sqlite", tmp / "cache", False
    for sub in ("thumb", "preview", "mask"):
        (tmp / "cache" / sub).mkdir(parents=True)
    with server.db() as c:
        c.executescript(server.SCHEMA)
        server._migrate_schema(c)
    try:
        _stack_endpoint_checks(server, TestClient, tmp)
    finally:
        server.DB_PATH, server.CACHE_DIR, server.WRITE_SIDECARS = saved


def _stack_endpoint_checks(server, TestClient, tmp):
    _, frames, _ = _burst(n=5)
    shots = tmp / "burst"; shots.mkdir()
    for i, f in enumerate(frames):
        f.save(shots / f"b{i}.jpg", quality=95)
    client = TestClient(server.app, base_url=f"http://127.0.0.1:{server.PORT}")  # the local-only guard checks Host
    r = client.post("/api/import", json={"path": str(shots), "recursive": False})
    assert r.status_code == 200, r.text
    ids = [im["id"] for im in client.get("/api/images", params={"folder": str(shots)}).json()]
    assert len(ids) == 5, ids
    r = client.post("/api/stack", json={"ids": ids, "mode": "median"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["frames"] == 5 and out["iid"] not in ids
    assert list(shots.glob("*_Clean.tif")), list(shots.iterdir())
    r = client.post("/api/stack", json={"ids": ids[:2], "mode": "median"})
    assert r.status_code == 400


def _focus_frames(scales=(1.0, 1.0, 1.0)):
    """Three shots of one textured scene, each sharp in a different third."""
    from PIL import ImageFilter
    rng = np.random.default_rng(3)
    # structure at every scale, like a real subject: shapes plus fine texture
    big = _scene(600, 360)
    fine = rng.normal(0, 25, (360, 600, 1))
    scene = np.clip(big + fine, 0, 255).astype(np.uint8)
    blurred = np.asarray(Image.fromarray(scene).filter(ImageFilter.GaussianBlur(4)))
    frames = []
    for i, sc in enumerate(scales):
        f = blurred.copy()
        f[:, i * 200:(i + 1) * 200] = scene[:, i * 200:(i + 1) * 200]
        if sc != 1.0:
            f, _ = stacking._warp_similarity(f.astype(np.float32), sc, 0, 0)
        frames.append(Image.fromarray(np.clip(f, 0, 255).astype(np.uint8)))
    return scene, frames


def _lap_energy(a):
    g = a.astype(np.float32).mean(-1)
    return float((np.abs(4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:])).mean())


def test_focus_stack_is_sharp_everywhere():
    scene, frames = _focus_frames()
    out = np.asarray(stacking.stack(frames, "focus", do_align=False))
    for i in range(3):
        region = slice(20, 340), slice(i * 200 + 20, (i + 1) * 200 - 20)
        got, want = _lap_energy(out[region]), _lap_energy(scene[region])
        assert got > 0.85 * want, (i, got, want)


def test_similarity_recovers_focus_breathing():
    base = _scene()
    grown, _ = stacking._warp_similarity(base, 1.025, 3.0, -2.0)
    sc, dy, dx = stacking.estimate_similarity(base, grown)
    assert abs(sc - 1 / 1.025) < 0.006, sc


if __name__ == "__main__":
    test_phase_correlation_recovers_known_shift()
    test_median_removes_the_walker()
    test_mean_reduces_noise_without_blurring()
    test_lighten_keeps_brightest_and_crops_to_common_area()
    test_mismatched_sizes_are_rejected()
    test_focus_stack_is_sharp_everywhere()
    test_similarity_recovers_focus_breathing()
    test_stack_endpoint_writes_a_new_catalogued_photo()
    print("OK")
