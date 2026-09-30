"""Standalone check for lens-profile matching against the bundled
lensfun database. No pytest — matches this codebase's existing
convention (see backend/test_skylib.py). Run with:

    .venv/bin/python -m backend.test_lensprofile
"""
from backend.server import match_lens_profile


def test_known_camera_and_lens_matches():
    result = match_lens_profile("Canon Canon EOS 5D Mark IV", "Canon EF 50mm f/1.8 STM", 50.0, 2.0)
    assert result["matched"] is True, result
    assert result["cameraName"] == "Canon EOS 5D Mark IV", result["cameraName"]
    assert result["lensName"] == "Canon EF 50mm f/1.8 STM", result["lensName"]
    assert result["distortion"]["model"] == "ptlens", result["distortion"]
    assert len(result["distortion"]["terms"]) == 3
    assert result["vignetting"]["model"] == "pa", result["vignetting"]
    assert len(result["vignetting"]["terms"]) == 3
    assert abs(result["radiusScale"] - 1.005) < 0.01, result["radiusScale"]


def _shader_vignetting_gain(terms, scale, x, y, w, h):
    """Mirror of the FS_BASE lensfun vignetting maths in frontend/engine.js."""
    import math
    Rd = math.hypot(x - w / 2, y - h / 2) / math.hypot(w / 2, h / 2) * scale
    f = 1 + terms[0] * Rd ** 2 + terms[1] * Rd ** 4 + terms[2] * Rd ** 6
    return min(max(1 / max(f, 0.125), 1 / 8), 8)


def test_vignetting_gain_matches_lensfun():
    """The shader's corner gain must agree with lensfun's own modifier. It used to
    normalise the radius to half the short side (lensfun uses the half-diagonal),
    which blew the corners up to white."""
    import numpy as np
    import lensfunpy
    from backend.server import _get_lensfun_db
    db = _get_lensfun_db()
    cam = db.find_cameras(None, "Canon EOS 5D Mark IV", loose_search=True)[0]
    lens = db.find_lenses(cam, None, "Canon EF 50mm f/1.8 STM", loose_search=True)[0]
    prof = match_lens_profile("Canon Canon EOS 5D Mark IV", "Canon EF 50mm f/1.8 STM", 50.0, 2.0)
    w, h = 600, 400
    mod = lensfunpy.Modifier(lens, cam.crop_factor, w, h)
    mod.initialize(50.0, 2.0, 1000.0, pixel_format=np.float32)
    img = np.ones((h, w, 3), np.float32)
    mod.apply_color_modification(img)
    for x, y in [(0, 0), (w // 2, 0), (0, h // 2), (w // 4, h // 4)]:
        want = float(img[y, x, 0])
        got = _shader_vignetting_gain(prof["vignetting"]["terms"], prof["radiusScale"], x + 0.5, y + 0.5, w, h)
        assert abs(got - want) / want < 0.05, (x, y, got, want)


def test_unmatched_lens_returns_matched_false():
    result = match_lens_profile("Canon Canon EOS 5D Mark IV", "Totally Made Up Lens Model XYZ 9999mm", 50.0, 2.0)
    assert result == {"matched": False}, result


def test_missing_metadata_returns_matched_false_without_calling_lensfun():
    assert match_lens_profile(None, "Canon EF 50mm f/1.8 STM", 50.0, 2.0) == {"matched": False}
    assert match_lens_profile("Canon Canon EOS 5D Mark IV", None, 50.0, 2.0) == {"matched": False}
    assert match_lens_profile("Canon Canon EOS 5D Mark IV", "Canon EF 50mm f/1.8 STM", None, 2.0) == {"matched": False}
    assert match_lens_profile("Canon Canon EOS 5D Mark IV", "Canon EF 50mm f/1.8 STM", 50.0, None) == {"matched": False}


if __name__ == "__main__":
    test_known_camera_and_lens_matches()
    test_vignetting_gain_matches_lensfun()
    test_unmatched_lens_returns_matched_false()
    test_missing_metadata_returns_matched_false_without_calling_lensfun()
    print("OK")
