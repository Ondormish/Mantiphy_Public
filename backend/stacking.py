"""Image stacking: align a burst of frames and combine them per pixel.

- median  — removes anything that moves (people walking through a scene,
            cars, birds): each pixel keeps the value most frames agree on
            (averaged over those frames, so noise drops too).
            Needs the passer-by to cover a given spot in fewer than half
            the frames, so ~8-15 frames a few seconds apart work well.
- mean    — averages the frames: noise drops by about sqrt(N) while the
            static scene stays sharp (a handheld "multi-shot" night mode).
- lighten — keeps the brightest value: light trails, star trails, fireworks.
- focus   — focus stacking: each pixel comes from the frames where it is
            sharpest (local Laplacian energy, soft-weighted so there are no
            seams), for macro and near-far landscapes shot at several focus
            distances. Refocusing changes magnification slightly ("focus
            breathing"), so this mode also estimates a scale per frame.

Alignment has no required dependency: phase correlation in numpy finds each
frame's shift against the reference frame, coarse on a small copy and then
refined at full resolution (sub-pixel). When OpenCV is installed (the
optional HDR/panorama extra), ORB features + a RANSAC homography are used
instead, which also absorbs handheld rotation and small perspective change.
Pure functions only — the HTTP endpoint lives in server.py.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

MODES = ("median", "mean", "lighten", "focus")


def _gray(a: np.ndarray) -> np.ndarray:
    return (a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114).astype(np.float32)


def _phase_shift(ref: np.ndarray, img: np.ndarray, with_peak: bool = False):
    """(dy, dx) such that img shifted by (dy, dx) lines up with ref. Sub-pixel
    via a parabola through the correlation peak and its neighbours. with_peak
    also returns the peak height (how well the two actually match)."""
    h, w = ref.shape
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    A = np.fft.fft2((ref - ref.mean()) * win)
    B = np.fft.fft2((img - img.mean()) * win)
    R = A * np.conj(B)
    R /= np.abs(R) + 1e-9
    c = np.fft.ifft2(R).real
    py, px = np.unravel_index(np.argmax(c), c.shape)

    def sub(cm, c0, cp):
        d = cm - 2 * c0 + cp
        return 0.0 if abs(d) < 1e-12 else 0.5 * (cm - cp) / d

    dy = py + sub(c[(py - 1) % h, px], c[py, px], c[(py + 1) % h, px])
    dx = px + sub(c[py, (px - 1) % w], c[py, px], c[py, (px + 1) % w])
    if dy > h / 2:
        dy -= h
    if dx > w / 2:
        dx -= w
    if with_peak:
        return float(dy), float(dx), float(c[py, px])
    return float(dy), float(dx)


def _soften(g: np.ndarray, r: int) -> np.ndarray:
    """~Gaussian blur (three box passes each way); r=0 is a no-op."""
    for _ in range(3 if r else 0):
        g = _box1(_box1(g, r, 0), r, 1)
    return g.astype(np.float32)


def estimate_shift(ref: np.ndarray, img: np.ndarray, smooth: int = 0) -> tuple[float, float]:
    """Coarse-to-fine translation between two RGB frames (float32 0..255).
    smooth blurs both before correlating, so frames focused at different
    distances (sharp here, soft there) still correlate on shared structure."""
    H, W = ref.shape[:2]
    g_ref, g_img = _soften(_gray(ref), smooth), _soften(_gray(img), smooth)
    # coarse: whole frame at <= 512 px
    s = max(1, int(np.ceil(max(H, W) / 512)))
    dy, dx = _phase_shift(g_ref[::s, ::s], g_img[::s, ::s])
    dy, dx = dy * s, dx * s
    # fine: a central full-resolution window, pre-shifted by the coarse estimate
    win = min(1024, H // 2 * 2, W // 2 * 2)
    cy, cx = H // 2, W // 2
    y0, x0 = cy - win // 2, cx - win // 2
    iy, ix = int(round(y0 - dy)), int(round(x0 - dx))
    iy = min(max(iy, 0), H - win)
    ix = min(max(ix, 0), W - win)
    fy, fx = _phase_shift(g_ref[y0:y0 + win, x0:x0 + win], g_img[iy:iy + win, ix:ix + win])
    return (iy - y0) * -1.0 + fy, (ix - x0) * -1.0 + fx


def _shift_image(a: np.ndarray, dy: float, dx: float) -> tuple[np.ndarray, np.ndarray]:
    """Translate by (dy, dx) with bilinear sampling. Returns (image, valid mask)."""
    H, W = a.shape[:2]
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    # PIL's affine maps output -> input: x_in = x_out - dx
    out = np.asarray(im.transform((W, H), Image.AFFINE, (1, 0, -dx, 0, 1, -dy), resample=Image.BILINEAR)).astype(np.float32)
    valid = np.zeros((H, W), bool)
    y0, y1 = int(np.ceil(max(0, dy))), int(np.floor(min(H, H + dy)))
    x0, x1 = int(np.ceil(max(0, dx))), int(np.floor(min(W, W + dx)))
    valid[y0:y1, x0:x1] = True
    return out, valid


def _warp_similarity(a: np.ndarray, scale: float, dy: float, dx: float, size=None):
    """Scale about the centre, then translate. Returns (image, valid mask)."""
    H, W = a.shape[:2]
    oW, oH = size or (W, H)
    cx, cy = (W - 1) / 2, (H - 1) / 2
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    coeffs = (1 / scale, 0, cx - (dx + cx) / scale, 0, 1 / scale, cy - (dy + cy) / scale)
    out = np.asarray(im.transform((oW, oH), Image.AFFINE, coeffs, resample=Image.BILINEAR)).astype(np.float32)
    ys, xs = np.arange(oH)[:, None], np.arange(oW)[None, :]
    xin = xs * coeffs[0] + coeffs[2]
    yin = ys * coeffs[4] + coeffs[5]
    valid = (xin >= 0) & (xin <= W - 1) & (yin >= 0) & (yin <= H - 1)
    return out, valid


def estimate_similarity(ref: np.ndarray, img: np.ndarray, grid: int = 4) -> tuple[float, float, float]:
    """(scale, dy, dx) for frames that differ by a small magnification as well
    as a shift (focus breathing). Measures the local shift of a grid of tiles
    (phase correlation on softened luminance, so a sharp and a blurred rendering
    of the same detail still match), then fits shift = (1 - m)(p - c) + t by
    weighted least squares, dropping tiles that disagree. Returns the scale and
    shift to pass to _warp_similarity()."""
    H, W = ref.shape[:2]
    k = max(1, int(np.ceil(max(H, W) / 1600)))
    smooth = max(1, max(H, W) // (300 * k))
    g_ref = _soften(_gray(ref)[::k, ::k], smooth)
    g_img = _soften(_gray(img)[::k, ::k], smooth)
    h, w = g_ref.shape
    th, tw = h // grid, w // grid
    cy, cx = (h - 1) / 2, (w - 1) / 2
    rows = []
    for i in range(grid):
        for j in range(grid):
            y0, x0 = i * th, j * tw
            dy, dx, peak = _phase_shift(g_ref[y0:y0 + th, x0:x0 + tw], g_img[y0:y0 + th, x0:x0 + tw], with_peak=True)
            rows.append((x0 + tw / 2 - cx, y0 + th / 2 - cy, dx, dy, max(peak, 1e-6)))
    R = np.array(rows)
    keep = np.ones(len(R), bool)
    for _ in range(3):
        px, py, dx, dy, wt = R[keep].T
        # unknowns: a (= 1 - m), tx, ty ; equations dx = a*px + tx, dy = a*py + ty
        A = np.zeros((2 * len(px), 3)); A[0::2, 0], A[0::2, 1] = px, 1; A[1::2, 0], A[1::2, 2] = py, 1
        bvec = np.empty(2 * len(px)); bvec[0::2], bvec[1::2] = dx, dy
        sw = np.repeat(np.sqrt(wt), 2)
        sol = np.linalg.lstsq(A * sw[:, None], bvec * sw, rcond=None)[0]
        res = np.hypot(R[:, 2] - (sol[0] * R[:, 0] + sol[1]), R[:, 3] - (sol[0] * R[:, 1] + sol[2]))
        new_keep = res < max(1.5, 3 * np.median(res[keep]))
        if new_keep.sum() < 4 or (new_keep == keep).all():
            break
        keep = new_keep
    m = 1.0 - sol[0]
    return float(1.0 / m), float(sol[2] * k / m), float(sol[1] * k / m)


def _align_cv2(ref: np.ndarray, img: np.ndarray):
    """Homography alignment with OpenCV, or None if unavailable/unreliable."""
    try:
        import cv2
    except Exception:
        return None
    H, W = ref.shape[:2]
    s = min(1.0, 1600 / max(H, W))
    small = lambda a: cv2.resize(_gray(a).astype(np.uint8), None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    orb = cv2.ORB_create(4000)
    k1, d1 = orb.detectAndCompute(small(ref), None)
    k2, d2 = orb.detectAndCompute(small(img), None)
    if d1 is None or d2 is None or len(k1) < 20 or len(k2) < 20:
        return None
    matches = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(d2, d1)
    if len(matches) < 20:
        return None
    src = np.float32([k2[m.queryIdx].pt for m in matches]) / s
    dst = np.float32([k1[m.trainIdx].pt for m in matches]) / s
    Hm, inl = cv2.findHomography(src, dst, cv2.RANSAC, 2.0)
    if Hm is None or inl is None or inl.sum() < 15:
        return None
    warped = cv2.warpPerspective(img, Hm, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    valid = cv2.warpPerspective(np.ones((H, W), np.uint8), Hm, (W, H), flags=cv2.INTER_NEAREST, borderValue=0).astype(bool)
    return warped.astype(np.float32), valid


def align(frames: list[np.ndarray], ref_index: int | None = None, use_cv2: bool = True, use_scale: bool = False):
    """Align every frame onto the reference (the middle one by default).
    use_scale also solves for magnification (focus stacks) when OpenCV isn't
    there to do it. Returns (aligned frames as uint8, common valid mask)."""
    if ref_index is None:
        ref_index = len(frames) // 2
    ref = frames[ref_index].astype(np.float32)
    H, W = ref.shape[:2]
    out, common = [], np.ones((H, W), bool)
    for i, f in enumerate(frames):
        if f.shape != ref.shape:
            raise ValueError("All photos in a stack must have the same dimensions")
        if i == ref_index:
            out.append(f.astype(np.uint8))
            continue
        res = _align_cv2(ref, f.astype(np.float32)) if use_cv2 else None
        if res is None:
            sc, dy, dx = estimate_similarity(ref, f.astype(np.float32)) if use_scale else (1.0,) + estimate_shift(ref, f.astype(np.float32))
            if abs(dy) > 0.08 * H or abs(dx) > 0.08 * W:
                sc, dy, dx = 1.0, 0.0, 0.0  # implausible for a burst from one spot: leave the frame as shot
            res = _warp_similarity(f.astype(np.float32), sc, dy, dx) if sc != 1.0 else _shift_image(f.astype(np.float32), dy, dx)
        a, valid = res
        out.append(np.clip(a + 0.5, 0, 255).astype(np.uint8))
        common &= valid
    return out, common


def combine(frames: list[np.ndarray], mode: str, strip: int = 256) -> np.ndarray:
    """Per-pixel combination of aligned uint8 frames, processed in row strips
    so a stack of many full-size frames never needs one giant float array."""
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    if mode == "focus":
        return _focus_combine(frames, strip)
    H = frames[0].shape[0]
    out = np.empty(frames[0].shape, np.uint8)
    for y in range(0, H, strip):
        block = np.stack([f[y:y + strip] for f in frames]).astype(np.float32)
        if mode == "median":
            # Median, then the mean of the frames that agree with it: an intruder
            # is excluded outright instead of nudging an even-count median (which
            # left faint ghosts), and the agreeing frames average the noise down.
            med = np.median(block, axis=0)
            dev = np.abs(block - med).max(axis=-1, keepdims=True)
            sigma = 1.4826 * float(np.median(dev))
            keep = dev <= max(3.0 * sigma, 6.0)
            n = keep.sum(axis=0)
            r = np.where(n > 0, (block * keep).sum(axis=0) / np.maximum(n, 1), med)
        elif mode == "mean":
            r = block.mean(axis=0)
        else:
            r = block.max(axis=0)
        out[y:y + strip] = np.clip(r + 0.5, 0, 255).astype(np.uint8)
    return out


def _box1(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    c = np.cumsum(np.pad(a, [(r + 1, r) if i == axis else (0, 0) for i in range(a.ndim)], mode="edge"), axis=axis)
    hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
    lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
    return (hi - lo) / (2 * r + 1)


def _focus_combine(frames: list[np.ndarray], strip: int) -> np.ndarray:
    """Soft winner-takes-most blend by local sharpness. Sharpness is the Laplacian
    energy of the luminance averaged over a window a little wider than the
    blur you want to escape; raising it to a high power before normalising
    makes the sharpest frame dominate without hard seams between regions."""
    H, W = frames[0].shape[:2]
    r = max(3, W // 300)
    m = r + 2
    out = np.empty(frames[0].shape, np.uint8)
    for y in range(0, H, strip):
        y0, y1 = max(0, y - m), min(H, y + strip + m)
        block = np.stack([f[y0:y1] for f in frames]).astype(np.float32)   # (N, h, W, 3)
        g = block @ np.array([0.299, 0.587, 0.114], np.float32)           # (N, h, W)
        p = np.pad(g, ((0, 0), (1, 1), (1, 1)), mode="edge")
        lap = np.abs(4 * g - p[:, :-2, 1:-1] - p[:, 2:, 1:-1] - p[:, 1:-1, :-2] - p[:, 1:-1, 2:])
        e = _box1(_box1(lap * lap, r, 1), r, 2)
        w = (e / (e.max(axis=0, keepdims=True) + 1e-6)) ** 6 + 1e-6
        w /= w.sum(axis=0, keepdims=True)
        r_ = (block * w[..., None]).sum(axis=0)
        a, b = y - y0, y - y0 + min(strip, H - y)
        out[y:y + (b - a)] = np.clip(r_[a:b] + 0.5, 0, 255).astype(np.uint8)
    return out


def crop_to_valid(img: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Box inside the region every frame covers (the borders a shifted or
    rotated frame leaves empty are cut off, like a panorama crop): repeatedly
    drop whichever border line holds the most uncovered pixels."""
    t, b, l, r = 0, valid.shape[0], 0, valid.shape[1]
    while b - t > 1 and r - l > 1:
        box = valid[t:b, l:r]
        if box.all():
            break
        bad = {"t": (~box[0]).sum(), "b": (~box[-1]).sum(), "l": (~box[:, 0]).sum(), "r": (~box[:, -1]).sum()}
        k = max(bad, key=bad.get)
        if k == "t": t += 1
        elif k == "b": b -= 1
        elif k == "l": l += 1
        else: r -= 1
    return img[t:b, l:r]


def stack(images: list[Image.Image], mode: str, do_align: bool = True, use_cv2: bool = True) -> Image.Image:
    frames = [np.asarray(im.convert("RGB")) for im in images]
    if do_align:
        frames, valid = align(frames, use_cv2=use_cv2, use_scale=(mode == "focus"))
    else:
        if any(f.shape != frames[0].shape for f in frames):
            raise ValueError("All photos in a stack must have the same dimensions")
        valid = np.ones(frames[0].shape[:2], bool)
    out = combine(frames, mode)
    return Image.fromarray(crop_to_valid(out, valid))
