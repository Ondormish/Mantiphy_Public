"""Standalone check for procedural sky generation.

No pytest — matches this codebase's existing convention of manual/
standalone verification (see backend/test_denoise.py). Run with:

    .venv/bin/python -m backend.test_skylib
"""
from backend import skylib


def test_list_recipes_nonempty_and_unique_ids():
    recipes = skylib.list_recipes()
    assert len(recipes) >= 15, f"expected at least 15 recipes, got {len(recipes)}"
    ids = [r["id"] for r in recipes]
    assert len(ids) == len(set(ids)), "duplicate recipe ids"
    assert all(r["name"] for r in recipes), "every recipe needs a display name"


def test_generate_sky_is_deterministic_and_right_size():
    recipe = skylib.get_recipe("golden-hour")
    a = skylib.generate_sky(recipe, 120, 80)
    b = skylib.generate_sky(recipe, 120, 80)
    assert a.size == (120, 80), f"expected (120, 80), got {a.size}"
    assert a.tobytes() == b.tobytes(), "same recipe+size must render identical bytes"


def test_generate_sky_gradient_top_to_bottom():
    # A recipe with no clouds/sun/stars is a pure vertical gradient:
    # top ~= zenith colour, bottom ~= horizon colour.
    recipe = {"id": "test-plain", "name": "Test plain", "horizon": (200, 100, 50), "zenith": (10, 20, 200), "cloud_density": 0.0}
    img = skylib.generate_sky(recipe, 40, 100)
    px = img.load()
    top, bottom = px[20, 0], px[20, 99]
    assert abs(top[2] - 200) < 15 and abs(top[0] - 10) < 15, f"top should be near zenith colour, got {top}"
    assert abs(bottom[0] - 200) < 15 and abs(bottom[2] - 50) < 15, f"bottom should be near horizon colour, got {bottom}"


def test_get_recipe_unknown_id_raises_keyerror():
    try:
        skylib.get_recipe("does-not-exist")
        assert False, "expected KeyError"
    except KeyError:
        pass


if __name__ == "__main__":
    test_list_recipes_nonempty_and_unique_ids()
    test_generate_sky_is_deterministic_and_right_size()
    test_generate_sky_gradient_top_to_bottom()
    test_get_recipe_unknown_id_raises_keyerror()
    print("OK")
