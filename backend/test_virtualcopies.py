"""Standalone check for virtual-copy creation/deletion. No pytest —
matches this codebase's existing convention. This is the first test
in this suite to touch the catalog database directly (every other
backend/test_*.py tests pure functions with synthetic in-memory
data) — uses a throwaway temp SQLite file, never the real catalog.

Run with:

    .venv/bin/python -m backend.test_virtualcopies
"""
import sqlite3
import tempfile
import time
from pathlib import Path

from backend.server import SCHEMA, image_id_for, create_virtual_copy, delete_virtual_copy, CannotDeleteOriginal, _migrate_schema

OLD_SCHEMA_IMAGES_TABLE = """
CREATE TABLE images (
  id TEXT PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  folder TEXT NOT NULL,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  is_raw INTEGER NOT NULL DEFAULT 0,
  size INTEGER, mtime REAL,
  width INTEGER, height INTEGER,
  captured TEXT, camera TEXT, lens TEXT,
  iso INTEGER, shutter TEXT, aperture REAL, focal REAL,
  rating INTEGER DEFAULT 0,
  flag TEXT DEFAULT '',
  label TEXT DEFAULT '',
  edits TEXT DEFAULT '{}',
  keywords TEXT DEFAULT '',
  updated REAL
);
CREATE INDEX idx_images_folder ON images(folder);
"""


def _temp_db():
    fd = tempfile.mkstemp(suffix=".sqlite")[1]
    con = sqlite3.connect(fd)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def _insert_original(con, path="/photos/test.NEF"):
    iid = image_id_for(Path(path))
    con.execute(
        """INSERT INTO images(id,path,folder,filename,ext,is_raw,size,mtime,width,height,
           captured,camera,lens,iso,shutter,aperture,focal,rating,flag,label,edits,keywords,updated)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (iid, path, "/photos", "test.NEF", "nef", 1, 1000, time.time(), 6000, 4000,
         "2026:01:01 12:00:00", "Test Camera", "Test Lens", 100, "1/200", 4.0, 50.0,
         3, "pick", "red", '{"v":1}', "kw1,kw2", time.time()),
    )
    con.commit()
    return iid, path


def test_copy_shares_path_gets_distinct_id():
    con = _temp_db()
    orig_id, path = _insert_original(con)
    copy_id = create_virtual_copy(con, orig_id)
    orig = con.execute("SELECT * FROM images WHERE id=?", (orig_id,)).fetchone()
    copy = con.execute("SELECT * FROM images WHERE id=?", (copy_id,)).fetchone()
    assert copy_id != orig_id, copy_id
    assert copy["path"] == orig["path"] == path, (copy["path"], orig["path"])
    assert copy["copy_of"] == orig_id, copy["copy_of"]
    assert copy["copy_index"] == 1, copy["copy_index"]
    assert orig["copy_of"] is None, orig["copy_of"]
    # copied fields
    assert copy["rating"] == 3, copy["rating"]
    assert copy["flag"] == "pick", copy["flag"]
    assert copy["label"] == "red", copy["label"]
    assert copy["edits"] == '{"v":1}', copy["edits"]
    assert copy["keywords"] == "kw1,kw2", copy["keywords"]


def test_second_copy_increments_index():
    con = _temp_db()
    orig_id, _ = _insert_original(con)
    create_virtual_copy(con, orig_id)
    copy2_id = create_virtual_copy(con, orig_id)
    copy2 = con.execute("SELECT * FROM images WHERE id=?", (copy2_id,)).fetchone()
    assert copy2["copy_index"] == 2, copy2["copy_index"]


def test_copy_of_a_copy_does_not_chain():
    con = _temp_db()
    orig_id, _ = _insert_original(con)
    copy1_id = create_virtual_copy(con, orig_id)
    copy2_id = create_virtual_copy(con, copy1_id)  # copying a copy
    copy2 = con.execute("SELECT * FROM images WHERE id=?", (copy2_id,)).fetchone()
    assert copy2["copy_of"] == orig_id, copy2["copy_of"]  # points at the TRUE original, not copy1


def test_delete_copy_removes_row():
    con = _temp_db()
    orig_id, _ = _insert_original(con)
    copy_id = create_virtual_copy(con, orig_id)
    delete_virtual_copy(con, copy_id)
    assert con.execute("SELECT 1 FROM images WHERE id=?", (copy_id,)).fetchone() is None


def test_delete_original_rejected():
    con = _temp_db()
    orig_id, _ = _insert_original(con)
    try:
        delete_virtual_copy(con, orig_id)
        assert False, "expected CannotDeleteOriginal"
    except CannotDeleteOriginal:
        pass
    assert con.execute("SELECT 1 FROM images WHERE id=?", (orig_id,)).fetchone() is not None


def test_migration_from_old_schema_preserves_data_and_drops_unique():
    """Simulates a real pre-existing catalog: old images table (UNIQUE
    on path, no copy_of/copy_index), one real row, then runs
    _migrate_schema() and confirms the row survived AND a second row
    with the same path (impossible before migration) now succeeds."""
    con = sqlite3.connect(tempfile.mkstemp(suffix=".sqlite")[1])
    con.row_factory = sqlite3.Row
    con.executescript(OLD_SCHEMA_IMAGES_TABLE)
    iid, path = _insert_original(con)
    _migrate_schema(con)
    row = con.execute("SELECT * FROM images WHERE id=?", (iid,)).fetchone()
    assert row is not None and row["path"] == path, "original row lost in migration"
    assert row["rating"] == 3 and row["keywords"] == "kw1,kw2", "column data corrupted in migration"
    cols = {r["name"] for r in con.execute("PRAGMA table_info(images)")}
    assert "copy_of" in cols and "copy_index" in cols, cols
    # the real proof UNIQUE is gone: a second row with the identical path must now succeed
    con.execute(
        "INSERT INTO images(id,path,folder,filename,ext,is_raw,size,mtime,updated,copy_of,copy_index) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ("second-row-same-path", path, "/photos", "test.NEF", "nef", 1, 1000, time.time(), time.time(), iid, 1),
    )
    con.commit()
    assert con.execute("SELECT COUNT(*) FROM images WHERE path=?", (path,)).fetchone()[0] == 2
    # idempotent: running it again on an already-migrated DB must be a no-op, not an error
    _migrate_schema(con)


if __name__ == "__main__":
    test_copy_shares_path_gets_distinct_id()
    test_second_copy_increments_index()
    test_copy_of_a_copy_does_not_chain()
    test_delete_copy_removes_row()
    test_delete_original_rejected()
    test_migration_from_old_schema_preserves_data_and_drops_unique()
    print("OK")
