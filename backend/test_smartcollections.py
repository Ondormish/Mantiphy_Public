"""Standalone check for Smart Collections. No pytest — matches this
codebase's existing convention (see backend/test_virtualcopies.py,
the first test in this suite to touch a real SQLite database directly
via a temp file, same pattern reused here).

Run with:

    .venv/bin/python -m backend.test_smartcollections
"""
import sqlite3
import tempfile
import time

import backend.server as server
from backend.server import SCHEMA, _migrate_schema, _build_image_filter, add_items, remove_items
from fastapi import HTTPException


def _temp_db():
    fd = tempfile.mkstemp(suffix=".sqlite")[1]
    con = sqlite3.connect(fd)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    _migrate_schema(con)
    return con


def _insert_image(con, iid, rating=0, flag="", edits="{}"):
    con.execute(
        """INSERT INTO images(id,path,folder,filename,ext,is_raw,size,mtime,updated,rating,flag,label,edits,keywords)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (iid, f"/photos/{iid}.jpg", "/photos", f"{iid}.jpg", "jpg", 0, 1000, time.time(), time.time(), rating, flag, "", edits, ""),
    )
    con.commit()


def test_build_image_filter_matches_manual_where_clause():
    """Regression check on the extraction itself: the helper must
    produce a WHERE clause that actually filters correctly, not just
    structurally resemble the old inline code."""
    con = _temp_db()
    _insert_image(con, "a", rating=5, flag="pick")
    _insert_image(con, "b", rating=2, flag="")
    _insert_image(con, "c", rating=5, flag="")
    where, args = _build_image_filter(min_rating=5)
    sql = "SELECT id FROM images"
    if where:
        sql += " WHERE " + " AND ".join(where)
    ids = {r["id"] for r in con.execute(sql, args)}
    assert ids == {"a", "c"}, ids


def test_build_image_filter_combines_criteria_with_and():
    con = _temp_db()
    _insert_image(con, "a", rating=5, flag="pick")
    _insert_image(con, "b", rating=5, flag="")
    where, args = _build_image_filter(min_rating=5, flag="pick")
    sql = "SELECT id FROM images WHERE " + " AND ".join(where)
    ids = {r["id"] for r in con.execute(sql, args)}
    assert ids == {"a"}, ids


def test_smart_collection_count_matches_matching_photos():
    import json
    con = _temp_db()
    _insert_image(con, "a", rating=5)
    _insert_image(con, "b", rating=1)
    _insert_image(con, "c", rating=5)
    con.execute("INSERT INTO collections(name, created, filter) VALUES(?,?,?)", ("5-star", time.time(), json.dumps({"min_rating": 5})))
    con.commit()
    row = con.execute("SELECT id, filter FROM collections WHERE name=?", ("5-star",)).fetchone()
    criteria = json.loads(row["filter"])
    where, args = _build_image_filter(**criteria)
    sql = "SELECT COUNT(*) FROM images"
    if where:
        sql += " WHERE " + " AND ".join(where)
    count = con.execute(sql, args).fetchone()[0]
    assert count == 2, count


OLD_SCHEMA_COLLECTIONS_TABLE = """
CREATE TABLE images (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, folder TEXT NOT NULL, filename TEXT NOT NULL,
  ext TEXT NOT NULL, is_raw INTEGER NOT NULL DEFAULT 0, size INTEGER, mtime REAL,
  width INTEGER, height INTEGER, captured TEXT, camera TEXT, lens TEXT, iso INTEGER,
  shutter TEXT, aperture REAL, focal REAL, rating INTEGER DEFAULT 0, flag TEXT DEFAULT '',
  label TEXT DEFAULT '', edits TEXT DEFAULT '{}', keywords TEXT DEFAULT '', updated REAL,
  copy_of TEXT, copy_index INTEGER
);
CREATE TABLE collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created REAL
);
CREATE TABLE collection_items (
  collection_id INTEGER, image_id TEXT, added REAL, PRIMARY KEY (collection_id, image_id)
);
"""


def test_migrate_schema_adds_filter_column_idempotently():
    """The collections-table migration must run independently of the
    images-table migration's own guard. Simulates a catalog that's
    already in the POST-virtual-copies shape (images already has
    copy_of, so that half of _migrate_schema() has nothing to do) but
    has never seen the filter column on collections — exactly the
    real-world state every catalog that upgraded through last
    chantier's migration but not yet this one will be in."""
    con = sqlite3.connect(tempfile.mkstemp(suffix=".sqlite")[1])
    con.row_factory = sqlite3.Row
    con.executescript(OLD_SCHEMA_COLLECTIONS_TABLE)
    cols = {r["name"] for r in con.execute("PRAGMA table_info(images)")}
    assert "copy_of" in cols, "fixture should already be in the post-virtual-copies shape"
    coll_cols_before = {r["name"] for r in con.execute("PRAGMA table_info(collections)")}
    assert "filter" not in coll_cols_before, "fixture should NOT have the filter column yet"
    _migrate_schema(con)  # first call: adds filter since it's missing
    _migrate_schema(con)  # second call: must be a silent no-op, not a duplicate-column error
    coll_cols_after = {r["name"] for r in con.execute("PRAGMA table_info(collections)")}
    assert "filter" in coll_cols_after, coll_cols_after
    # images now gains lat/lon columns during this run. There are now two independent,
    # self-guarded images-column migrations in _migrate_schema(): the older copy_of
    # rebuild (which doesn't fire since copy_of is already present), and the new
    # lat/lon ALTER TABLE block (which fires since lat/lon are missing from this fixture).
    img_cols_after = {r["name"] for r in con.execute("PRAGMA table_info(images)")}
    assert img_cols_after == cols | {"lat", "lon"}, (img_cols_after, cols)


def test_items_route_logic_rejects_smart_collection():
    """Calls the real add_items/remove_items route functions (not just
    a hand-rolled check of the same condition) against a temp catalog,
    via backend.server.DB_PATH monkeypatched so db() opens our file."""
    import json
    fd = tempfile.mkstemp(suffix=".sqlite")[1]
    con = sqlite3.connect(fd)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    _migrate_schema(con)
    con.execute("INSERT INTO collections(name, created, filter) VALUES(?,?,?)", ("Smart", time.time(), json.dumps({"min_rating": 5})))
    con.execute("INSERT INTO collections(name, created, filter) VALUES(?,?,?)", ("Regular", time.time(), None))
    con.commit()
    smart_id = con.execute("SELECT id FROM collections WHERE name='Smart'").fetchone()["id"]
    regular_id = con.execute("SELECT id FROM collections WHERE name='Regular'").fetchone()["id"]
    _insert_image(con, "x")
    con.close()

    old_db_path = server.DB_PATH
    server.DB_PATH = fd
    try:
        try:
            add_items(smart_id, {"ids": ["x"]})
            assert False, "expected HTTPException on a Smart Collection"
        except HTTPException as e:
            assert e.status_code == 400, e.status_code
        try:
            remove_items(smart_id, {"ids": ["x"]})
            assert False, "expected HTTPException on a Smart Collection"
        except HTTPException as e:
            assert e.status_code == 400, e.status_code
        assert add_items(regular_id, {"ids": ["x"]}) == {"ok": True}
        assert remove_items(regular_id, {"ids": ["x"]}) == {"ok": True}
    finally:
        server.DB_PATH = old_db_path


def test_collections_route_survives_a_malformed_filter_row():
    """A corrupt/unrecognised filter value (hand-edited DB, or a future
    frontend field _build_image_filter doesn't know yet) must degrade
    that one row to filter=None, not 500 the whole sidebar list."""
    import json
    fd = tempfile.mkstemp(suffix=".sqlite")[1]
    con = sqlite3.connect(fd)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    _migrate_schema(con)
    con.execute("INSERT INTO collections(name, created, filter) VALUES(?,?,?)", ("Good", time.time(), json.dumps({"min_rating": 5})))
    con.execute("INSERT INTO collections(name, created, filter) VALUES(?,?,?)", ("BadJSON", time.time(), "not json"))
    con.execute("INSERT INTO collections(name, created, filter) VALUES(?,?,?)", ("BadShape", time.time(), json.dumps([1, 2])))
    con.execute("INSERT INTO collections(name, created, filter) VALUES(?,?,?)", ("UnknownKey", time.time(), json.dumps({"bogus": 1})))
    con.commit()
    con.close()

    old_db_path = server.DB_PATH
    server.DB_PATH = fd
    try:
        rows = {r["name"]: r for r in server.collections()}
    finally:
        server.DB_PATH = old_db_path
    assert rows["Good"]["filter"] == {"min_rating": 5}, rows["Good"]
    for bad in ("BadJSON", "BadShape"):
        assert rows[bad]["filter"] is None, (bad, rows[bad])
    # an unrecognised key (e.g. a future frontend field this backend
    # doesn't know yet) is stripped rather than fatal — the row still
    # degrades gracefully instead of taking the whole list down
    assert rows["UnknownKey"]["filter"] == {}, rows["UnknownKey"]


if __name__ == "__main__":
    test_build_image_filter_matches_manual_where_clause()
    test_build_image_filter_combines_criteria_with_and()
    test_smart_collection_count_matches_matching_photos()
    test_migrate_schema_adds_filter_column_idempotently()
    test_items_route_logic_rejects_smart_collection()
    test_collections_route_survives_a_malformed_filter_row()
    print("OK")
