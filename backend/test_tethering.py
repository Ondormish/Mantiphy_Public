"""Standalone check for tethering (folder-watch import). No pytest.

Run with:

    .venv/bin/python -m backend.test_tethering
"""
import sqlite3
import tempfile
import threading
import time
from pathlib import Path

import backend.server as server
from backend.server import (
    SCHEMA,
    _migrate_schema,
    _wait_for_stable_file,
    WatchManager,
    watch_folder,
    tether_events,
)


def _temp_db():
    fd = tempfile.mkstemp(suffix=".sqlite")[1]
    con = sqlite3.connect(fd)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    _migrate_schema(con)
    return fd, con


def test_migrate_schema_adds_watched_column_idempotently():
    fd, con = _temp_db()
    cols = {r["name"] for r in con.execute("PRAGMA table_info(folders)")}
    assert "watched" in cols, cols
    _migrate_schema(con)  # second call: must be a silent no-op
    cols_after = {r["name"] for r in con.execute("PRAGMA table_info(folders)")}
    assert cols_after == cols, (cols_after, cols)


def test_wait_for_stable_file_true_when_size_stops_changing():
    old_interval, old_timeout = server._STABILITY_INTERVAL, server._STABILITY_TIMEOUT
    server._STABILITY_INTERVAL, server._STABILITY_TIMEOUT = 0.1, 2.0
    try:
        d = tempfile.mkdtemp()
        p = Path(d) / "still.jpg"
        p.write_bytes(b"x" * 100)
        assert _wait_for_stable_file(p) is True
    finally:
        server._STABILITY_INTERVAL, server._STABILITY_TIMEOUT = old_interval, old_timeout


def test_wait_for_stable_file_false_when_it_never_stabilizes():
    old_interval, old_timeout = server._STABILITY_INTERVAL, server._STABILITY_TIMEOUT
    server._STABILITY_INTERVAL, server._STABILITY_TIMEOUT = 0.05, 0.3
    try:
        d = tempfile.mkdtemp()
        p = Path(d) / "growing.jpg"
        p.write_bytes(b"x")
        stop = threading.Event()

        def grow():
            n = 1
            while not stop.is_set():
                n += 1
                p.write_bytes(b"x" * n)
                time.sleep(0.03)

        t = threading.Thread(target=grow, daemon=True)
        t.start()
        try:
            assert _wait_for_stable_file(p) is False
        finally:
            stop.set()
            t.join(timeout=2)
    finally:
        server._STABILITY_INTERVAL, server._STABILITY_TIMEOUT = old_interval, old_timeout


def test_wait_for_stable_file_false_when_file_vanishes():
    d = tempfile.mkdtemp()
    p = Path(d) / "ghost.jpg"
    assert _wait_for_stable_file(p) is False  # never existed, first stat() raises


def test_watch_manager_start_returns_false_for_missing_path():
    wm = WatchManager()
    assert wm.start("/no/such/directory/hopefully") is False


def test_watch_manager_imports_a_dropped_file():
    old_interval, old_timeout = server._STABILITY_INTERVAL, server._STABILITY_TIMEOUT
    server._STABILITY_INTERVAL, server._STABILITY_TIMEOUT = 0.1, 3.0
    old_db_path = server.DB_PATH
    fd, con = _temp_db()
    con.execute("INSERT INTO folders(path, added) VALUES(?,?)", (tempfile.mkdtemp(), time.time()))
    row = con.execute("SELECT path FROM folders").fetchone()
    watch_dir = row["path"]
    con.close()
    server.DB_PATH = fd
    wm = WatchManager()
    try:
        assert wm.start(watch_dir) is True
        (Path(watch_dir) / "shot.jpg").write_bytes(b"\xff\xd8\xff" + b"x" * 200)  # JPEG-ish magic bytes, content doesn't need to be valid
        deadline = time.time() + 5
        found = False
        while time.time() < deadline:
            con2 = sqlite3.connect(fd)
            con2.row_factory = sqlite3.Row
            n = con2.execute("SELECT COUNT(*) AS n FROM images").fetchone()["n"]
            con2.close()
            if n == 1:
                found = True
                break
            time.sleep(0.2)
        assert found, "dropped file was never imported"
    finally:
        wm.stop(watch_dir)
        server.DB_PATH = old_db_path
        server._STABILITY_INTERVAL, server._STABILITY_TIMEOUT = old_interval, old_timeout


def test_tether_events_filters_by_since():
    old_events = list(server._tether_events)
    server._tether_events.clear()
    try:
        server._tether_events.extend([
            {"id": "a", "folder": "/x", "ts": 100.0},
            {"id": "b", "folder": "/x", "ts": 200.0},
        ])
        result = tether_events(since=150.0)
        assert [e["id"] for e in result["events"]] == ["b"], result
        assert result["now"] >= 200.0, result
    finally:
        server._tether_events.clear()
        server._tether_events.extend(old_events)


def test_watch_folder_route_persists_and_toggles():
    old_db_path = server.DB_PATH
    fd, con = _temp_db()
    watch_dir = tempfile.mkdtemp()
    con.execute("INSERT INTO folders(path, added) VALUES(?,?)", (watch_dir, time.time()))
    con.commit()
    con.close()
    server.DB_PATH = fd
    try:
        result = watch_folder({"path": watch_dir, "watch": True})
        assert result == {"ok": True, "watched": True}, result
        assert server.watch_manager.is_watching(watch_dir) is True
        con2 = sqlite3.connect(fd)
        con2.row_factory = sqlite3.Row
        row = con2.execute("SELECT watched FROM folders WHERE path=?", (watch_dir,)).fetchone()
        con2.close()
        assert row["watched"] == 1, dict(row)

        result = watch_folder({"path": watch_dir, "watch": False})
        assert result == {"ok": True, "watched": False}, result
        assert server.watch_manager.is_watching(watch_dir) is False
        con3 = sqlite3.connect(fd)
        con3.row_factory = sqlite3.Row
        row = con3.execute("SELECT watched FROM folders WHERE path=?", (watch_dir,)).fetchone()
        con3.close()
        assert row["watched"] == 0, dict(row)
    finally:
        server.watch_manager.stop(watch_dir)
        server.DB_PATH = old_db_path


if __name__ == "__main__":
    test_migrate_schema_adds_watched_column_idempotently()
    test_wait_for_stable_file_true_when_size_stops_changing()
    test_wait_for_stable_file_false_when_it_never_stabilizes()
    test_wait_for_stable_file_false_when_file_vanishes()
    test_watch_manager_start_returns_false_for_missing_path()
    test_watch_manager_imports_a_dropped_file()
    test_tether_events_filters_by_since()
    test_watch_folder_route_persists_and_toggles()
    print("OK")
