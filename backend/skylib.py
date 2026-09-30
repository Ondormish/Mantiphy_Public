"""Procedural sky library for the sky-replacement feature.

Every sky is generated from a small parameter recipe (colours, cloud
density, optional sun glow / stars) — no third-party photos are shipped
or downloaded, so there's no image-licensing story to maintain. Same
recipe id + same output size always renders identical bytes (seeded off
the recipe id), so the caller (backend/server.py) can cache freely.
"""
from __future__ import annotations

import zlib

import numpy as np
from PIL import Image

SKY_RECIPES: list[dict] = [
    {"id": "clear-blue", "name": "Clear blue", "horizon": (210, 225, 235), "zenith": (40, 110, 200), "cloud_density": 0.0},
    {"id": "hazy-blue", "name": "Hazy blue", "horizon": (225, 220, 210), "zenith": (90, 140, 205), "cloud_density": 0.15, "cloud_scale": 5, "cloud_opacity": 0.35, "cloud_softness": 0.8},
    {"id": "fair-weather-cumulus", "name": "Fair weather cumulus", "horizon": (200, 215, 230), "zenith": (60, 130, 210), "cloud_density": 0.4, "cloud_scale": 6, "cloud_opacity": 0.85, "cloud_softness": 0.35},
    {"id": "wispy-cirrus", "name": "Wispy cirrus", "horizon": (215, 220, 228), "zenith": (70, 135, 205), "cloud_density": 0.25, "cloud_scale": 14, "cloud_opacity": 0.5, "cloud_softness": 0.9},
    {"id": "dramatic-storm", "name": "Dramatic storm", "horizon": (90, 95, 100), "zenith": (35, 40, 50), "cloud_density": 0.75, "cloud_scale": 5, "cloud_opacity": 0.9, "cloud_softness": 0.2},
    {"id": "overcast-moody", "name": "Overcast moody", "horizon": (150, 150, 150), "zenith": (110, 112, 118), "cloud_density": 0.85, "cloud_scale": 4, "cloud_opacity": 0.75, "cloud_softness": 0.6},
    {"id": "cold-overcast", "name": "Cold overcast", "horizon": (180, 188, 195), "zenith": (140, 150, 165), "cloud_density": 0.7, "cloud_scale": 5, "cloud_opacity": 0.6, "cloud_softness": 0.7},
    {"id": "foggy-white", "name": "Foggy white", "horizon": (235, 235, 235), "zenith": (205, 208, 212), "cloud_density": 0.5, "cloud_scale": 3, "cloud_opacity": 0.4, "cloud_softness": 0.95},
    {"id": "golden-hour", "name": "Golden hour", "horizon": (255, 190, 110), "zenith": (90, 120, 175), "cloud_density": 0.3, "cloud_scale": 6, "cloud_opacity": 0.6, "cloud_softness": 0.5, "sun": {"x": 0.5, "y": 0.75, "radius": 0.35, "color": (255, 200, 120), "warmth": 0.8}},
    {"id": "sunset-orange", "name": "Sunset orange", "horizon": (255, 120, 60), "zenith": (60, 50, 90), "cloud_density": 0.35, "cloud_scale": 6, "cloud_opacity": 0.7, "cloud_softness": 0.4, "sun": {"x": 0.5, "y": 0.85, "radius": 0.3, "color": (255, 150, 70), "warmth": 0.9}},
    {"id": "sunset-pastel", "name": "Sunset pastel", "horizon": (250, 190, 190), "zenith": (150, 140, 200), "cloud_density": 0.3, "cloud_scale": 7, "cloud_opacity": 0.55, "cloud_softness": 0.7},
    {"id": "dusk-purple", "name": "Dusk purple", "horizon": (150, 110, 160), "zenith": (35, 30, 70), "cloud_density": 0.35, "cloud_scale": 6, "cloud_opacity": 0.55, "cloud_softness": 0.6},
    {"id": "blue-hour", "name": "Blue hour", "horizon": (90, 110, 160), "zenith": (15, 25, 60), "cloud_density": 0.15, "cloud_scale": 6, "cloud_opacity": 0.4, "cloud_softness": 0.7},
    {"id": "starry-night", "name": "Starry night", "horizon": (20, 25, 45), "zenith": (3, 5, 18), "cloud_density": 0.1, "cloud_scale": 8, "cloud_opacity": 0.25, "cloud_softness": 0.8, "stars": 0.8},
    {"id": "deep-blue-altitude", "name": "Deep blue (altitude)", "horizon": (120, 155, 200), "zenith": (10, 40, 110), "cloud_density": 0.05, "cloud_scale": 6, "cloud_opacity": 0.3, "cloud_softness": 0.6},
    {"id": "desert-dusty", "name": "Desert dusty", "horizon": (225, 200, 160), "zenith": (150, 170, 195), "cloud_density": 0.1, "cloud_scale": 5, "cloud_opacity": 0.3, "cloud_softness": 0.7},
    {"id": "autumn-amber", "name": "Autumn amber", "horizon": (230, 160, 100), "zenith": (120, 140, 175), "cloud_density": 0.3, "cloud_scale": 6, "cloud_opacity": 0.55, "cloud_softness": 0.5},
    {"id": "winter-pale", "name": "Winter pale", "horizon": (220, 225, 230), "zenith": (160, 180, 205), "cloud_density": 0.35, "cloud_scale": 5, "cloud_opacity": 0.5, "cloud_softness": 0.6},
]


def list_recipes() -> list[dict]:
    return [{"id": r["id"], "name": r["name"]} for r in SKY_RECIPES]


def get_recipe(sky_id: str) -> dict:
    for r in SKY_RECIPES:
        if r["id"] == sky_id:
            return r
    raise KeyError(sky_id)


def _value_noise(rng: np.random.Generator, w: int, h: int, cells: int) -> np.ndarray:
    """Bilinear-upsampled random grid, shape (h, w), values in [0, 1]."""
    cells = max(2, cells)
    small = (rng.random((cells + 1, cells + 1)) * 255).astype(np.uint8)
    img = Image.fromarray(small, mode="L").resize((w, h), Image.BICUBIC)
    return np.asarray(img).astype(np.float32) / 255.0


def generate_sky(recipe: dict, w: int, h: int) -> Image.Image:
    """Deterministic procedural sky: vertical gradient + optional multi-octave
    noise clouds, sun glow, and stars. Same recipe + size -> identical bytes."""
    seed = zlib.crc32(recipe["id"].encode()) & 0xFFFFFFFF
    rng = np.random.default_rng(seed)

    t = (np.linspace(0.0, 1.0, h) ** 0.8)[:, None, None]  # (h, 1, 1)
    zenith = np.array(recipe["zenith"], dtype=np.float32)
    horizon = np.array(recipe["horizon"], dtype=np.float32)
    base = zenith[None, None, :] * (1 - t) + horizon[None, None, :] * t
    base = np.repeat(base, w, axis=1).astype(np.float32)  # (h, w, 3)

    density = recipe.get("cloud_density", 0.0)
    if density > 0:
        base_cells = max(2, round(recipe.get("cloud_scale", 6) * w / 400))
        n = (0.5 * _value_noise(rng, w, h, base_cells)
             + 0.3 * _value_noise(rng, w, h, base_cells * 3)
             + 0.2 * _value_noise(rng, w, h, base_cells * 8))
        n = np.clip((n - (1 - density)) / max(density, 1e-3), 0, 1)
        softness = recipe.get("cloud_softness", 0.5)
        n = n ** (1.0 + (1 - softness) * 2)
        opacity = recipe.get("cloud_opacity", 0.8) * n[..., None]
        base = base * (1 - opacity) + 255.0 * opacity

    sun = recipe.get("sun")
    if sun:
        xs = np.linspace(0.0, 1.0, w)[None, :]
        ys = np.linspace(0.0, 1.0, h)[:, None]
        d = np.sqrt((xs - sun["x"]) ** 2 + (ys - sun["y"]) ** 2)
        glow = np.clip(1 - d / max(sun["radius"], 1e-3), 0, 1) ** 2
        sc = np.array(sun["color"], dtype=np.float32)
        base = base + glow[..., None] * sc[None, None, :] * sun.get("warmth", 0.6)

    stars = recipe.get("stars", 0.0)
    if stars > 0:
        n_stars = int(stars * w * h / 4000)
        xs = rng.integers(0, w, n_stars)
        ys = rng.integers(0, max(1, int(h * 0.6)), n_stars)
        base[ys, xs] = 255.0

    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB")
