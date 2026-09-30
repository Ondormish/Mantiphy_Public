"""Standalone check for camera profile calibration (ColorChecker). No
pytest. Real cv2.mcc chart detection needs an actual photographed
chart, unavailable in this sandbox — these tests cover the matrix
maths and the SQLite round-trip only, matching the monkeypatch-free,
pure-function style already used by backend/test_highlightrecovery.py.

Run with:

    .venv/bin/python -m backend.test_cameraprofile
"""
import json
import sqlite3
import tempfile
import time

import numpy as np
from fastapi import HTTPException

import backend.server as server
from backend.server import (
    SCHEMA,
    _solve_correction_matrix,
    _camera_profile_available,
    COLORCHECKER_REFERENCE_SRGB,
    camera_profile,
    calibrate_camera_profile,
)


def _s2l(c):
    c = np.asarray(c, dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _l2s(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055) * 255.0


def test_solve_correction_matrix_identity_when_observed_equals_reference():
    patches = np.array(COLORCHECKER_REFERENCE_SRGB, dtype=np.float64)
    m = _solve_correction_matrix(patches, patches)
    assert np.max(np.abs(m - np.eye(3))) < 1e-6, m


def test_solve_correction_matrix_recovers_a_known_transform():
    reference = np.array(COLORCHECKER_REFERENCE_SRGB, dtype=np.float64)
    true_m = np.array([[1.1, 0.05, -0.02], [0.02, 0.95, 0.03], [-0.01, 0.04, 1.05]])
    ref_lin = _s2l(reference)
    obs_lin = np.clip(ref_lin @ np.linalg.inv(true_m), 0.0, 1.0)
    observed = _l2s(obs_lin)
    recovered = _solve_correction_matrix(observed, reference)
    assert np.allclose(recovered, true_m, atol=0.02), (recovered, true_m)


def test_camera_profile_db_round_trip():
    fd = tempfile.mkstemp(suffix=".sqlite")[1]
    con = sqlite3.connect(fd)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    matrix = np.eye(3).tolist()
    con.execute("INSERT OR REPLACE INTO camera_profiles(camera, matrix, created) VALUES(?,?,?)",
                ("Test Camera Model", json.dumps(matrix), time.time()))
    con.commit()
    row = con.execute("SELECT matrix FROM camera_profiles WHERE camera=?", ("Test Camera Model",)).fetchone()
    assert row is not None
    assert json.loads(row["matrix"]) == matrix
    # re-calibrating the same camera overwrites, does not duplicate
    con.execute("INSERT OR REPLACE INTO camera_profiles(camera, matrix, created) VALUES(?,?,?)",
                ("Test Camera Model", json.dumps([[2, 0, 0], [0, 2, 0], [0, 0, 2]]), time.time()))
    con.commit()
    rows = con.execute("SELECT matrix FROM camera_profiles WHERE camera=?", ("Test Camera Model",)).fetchall()
    assert len(rows) == 1, rows


def test_camera_profile_available_checks_hasattr_mcc():
    # Sanity check only — actual availability depends on the installed
    # environment; this just confirms the function never raises.
    assert isinstance(_camera_profile_available(), bool)


def _temp_db():
    fd = tempfile.mkstemp(suffix=".sqlite")[1]
    con = sqlite3.connect(fd)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return fd, con


def _insert_image(con, iid, camera):
    con.execute(
        """INSERT INTO images(id,path,folder,filename,ext,is_raw,size,mtime,updated,camera)
           VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (iid, f"/photos/{iid}.raw", "/photos", f"{iid}.raw", "raw", 1, 1000, time.time(), time.time(), camera),
    )
    con.commit()


def test_camera_profile_route_unmatched_camera_no_crash():
    """This is the exact call that raised IndexError before the route
    was fixed to query 'camera' explicitly instead of via _row()."""
    fd, con = _temp_db()
    _insert_image(con, "a", "Test Camera Model")
    con.close()

    old_db_path = server.DB_PATH
    server.DB_PATH = fd
    try:
        result = camera_profile("a")
    finally:
        server.DB_PATH = old_db_path
    assert result == {"matched": False}, result


def test_camera_profile_route_matched_camera():
    fd, con = _temp_db()
    _insert_image(con, "b", "Test Camera Model")
    matrix = np.eye(3).tolist()
    con.execute("INSERT OR REPLACE INTO camera_profiles(camera, matrix, created) VALUES(?,?,?)",
                ("Test Camera Model", json.dumps(matrix), time.time()))
    con.commit()
    con.close()

    old_db_path = server.DB_PATH
    server.DB_PATH = fd
    try:
        result = camera_profile("b")
    finally:
        server.DB_PATH = old_db_path
    assert result == {"matched": True, "camera": "Test Camera Model", "matrix": matrix}, result


def test_calibrate_camera_profile_rejects_null_camera_after_row_read():
    """Proves the row-read fix works (no IndexError) and that the
    NULL/empty-camera guard fires before any decode()/cv2 work —
    without needing a real photographed ColorChecker chart."""
    if not _camera_profile_available():
        print("skip: cv2.mcc not available")
        return
    fd, con = _temp_db()
    _insert_image(con, "c", None)
    con.close()

    old_db_path = server.DB_PATH
    server.DB_PATH = fd
    try:
        try:
            calibrate_camera_profile("c")
            assert False, "expected HTTPException for a NULL-camera photo"
        except HTTPException as e:
            assert e.status_code == 400, e.status_code
    finally:
        server.DB_PATH = old_db_path


def test_camera_profile_route_unknown_image_404s():
    fd, con = _temp_db()
    con.close()
    old_db_path = server.DB_PATH
    server.DB_PATH = fd
    try:
        try:
            camera_profile("nonexistent")
            assert False, "expected HTTPException for an unknown image id"
        except HTTPException as e:
            assert e.status_code == 404, e.status_code
    finally:
        server.DB_PATH = old_db_path


if __name__ == "__main__":
    test_solve_correction_matrix_identity_when_observed_equals_reference()
    test_solve_correction_matrix_recovers_a_known_transform()
    test_camera_profile_db_round_trip()
    test_camera_profile_available_checks_hasattr_mcc()
    test_camera_profile_route_unmatched_camera_no_crash()
    test_camera_profile_route_matched_camera()
    test_calibrate_camera_profile_rejects_null_camera_after_row_read()
    test_camera_profile_route_unknown_image_404s()
    print("OK")
