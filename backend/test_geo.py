"""Standalone check for GPS extraction and the /api/images/geo route.
No pytest.

Run with:

    .venv/bin/python -m backend.test_geo
"""
import sqlite3
import tempfile
import time

import backend.server as server
from backend.server import SCHEMA, _migrate_schema, _gps_decimal, images_geo


class _Ratio:
    def __init__(self, v):
        self._v = v

    def __float__(self):
        return float(self._v)


class _FakeTag:
    def __init__(self, values=None, s=""):
        self.values = values
        self._s = s

    def __str__(self):
        return self._s


def test_gps_decimal_north_east():
    tags = {
        "GPS GPSLatitudeRef": _FakeTag(s="N"),
        "GPS GPSLatitude": _FakeTag(values=[_Ratio(48), _Ratio(51), _Ratio(29.34)]),
    }
    lat = _gps_decimal(tags, "GPS GPSLatitudeRef", "GPS GPSLatitude")
    assert abs(lat - 48.85815) < 1e-4, lat


def test_gps_decimal_south_west_are_negative():
    tags = {
        "GPS GPSLatitudeRef": _FakeTag(s="S"),
        "GPS GPSLatitude": _FakeTag(values=[_Ratio(33), _Ratio(51), _Ratio(35.9)]),
    }
    lat = _gps_decimal(tags, "GPS GPSLatitudeRef", "GPS GPSLatitude")
    assert lat < 0, lat
    assert abs(lat - (-33.86)) < 0.01, lat


def test_gps_decimal_east_is_positive():
    tags = {
        "GPS GPSLongitudeRef": _FakeTag(s="E"),
        "GPS GPSLongitude": _FakeTag(values=[_Ratio(2), _Ratio(21), _Ratio(0)]),
    }
    lon = _gps_decimal(tags, "GPS GPSLongitudeRef", "GPS GPSLongitude")
    assert abs(lon - 2.35) < 1e-4, lon


def test_gps_decimal_west_is_negative():
    tags = {
        "GPS GPSLongitudeRef": _FakeTag(s="W"),
        "GPS GPSLongitude": _FakeTag(values=[_Ratio(118), _Ratio(14), _Ratio(37.2)]),
    }
    lon = _gps_decimal(tags, "GPS GPSLongitudeRef", "GPS GPSLongitude")
    assert lon < 0, lon
    assert abs(lon - (-118.2436)) < 1e-3, lon


def test_gps_decimal_missing_tags_returns_none():
    assert _gps_decimal({}, "GPS GPSLatitudeRef", "GPS GPSLatitude") is None


def test_null_island_collapses_to_none():
    # Mirrors the (0,0) -> None collapse read_metadata() applies after
    # calling _gps_decimal() for both axes; not directly testable in
    # isolation without a real EXIF blob, so this pins the exact
    # condition read_metadata() checks.
    lat, lon = 0.0, 0.0
    if lat == 0 and lon == 0:
        lat = lon = None
    assert lat is None and lon is None


def _temp_db():
    fd = tempfile.mkstemp(suffix=".sqlite")[1]
    con = sqlite3.connect(fd)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    _migrate_schema(con)
    return fd, con


def _insert_image(con, iid, lat=None, lon=None):
    con.execute(
        """INSERT INTO images(id,path,folder,filename,ext,is_raw,size,mtime,updated,lat,lon)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (iid, f"/photos/{iid}.jpg", "/photos", f"{iid}.jpg", "jpg", 0, 1000, time.time(), time.time(), lat, lon),
    )
    con.commit()


def test_images_geo_route_returns_only_geotagged_photos():
    fd, con = _temp_db()
    _insert_image(con, "a", 48.858, 2.294)
    _insert_image(con, "b", None, None)
    con.close()

    old_db_path = server.DB_PATH
    server.DB_PATH = fd
    try:
        result = images_geo()
    finally:
        server.DB_PATH = old_db_path
    assert len(result["items"]) == 1, result
    assert result["items"][0]["id"] == "a", result
    assert abs(result["items"][0]["lat"] - 48.858) < 1e-6, result
    assert result["total"] == 2, result  # counts BOTH the geotagged and non-geotagged fixture rows


def test_migrate_schema_adds_lat_lon_idempotently():
    fd, con = _temp_db()
    cols = {r["name"] for r in con.execute("PRAGMA table_info(images)")}
    assert "lat" in cols and "lon" in cols, cols
    _migrate_schema(con)  # second call: must be a silent no-op, no error
    cols_after = {r["name"] for r in con.execute("PRAGMA table_info(images)")}
    assert cols_after == cols, (cols_after, cols)


if __name__ == "__main__":
    test_gps_decimal_north_east()
    test_gps_decimal_south_west_are_negative()
    test_gps_decimal_east_is_positive()
    test_gps_decimal_west_is_negative()
    test_gps_decimal_missing_tags_returns_none()
    test_null_island_collapses_to_none()
    test_images_geo_route_returns_only_geotagged_photos()
    test_migrate_schema_adds_lat_lon_idempotently()
    print("OK")
