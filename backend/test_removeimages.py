"""Standalone check for "Remove from library" / "Delete from disk". No pytest —
matches this codebase's convention. Uses a throwaway SQLite file, a temp photo
folder and a temp XDG trash, never the real catalog or the user's trash.

Run with:

    .venv/bin/python -m backend.test_removeimages
"""
import os
import tempfile
from pathlib import Path

import backend.server as server
from backend.server import create_virtual_copy, remove_images, sidecar_path, xmp_sidecar_path
from backend.test_virtualcopies import _temp_db, _insert_original


def _setup():
    root = Path(tempfile.mkdtemp())
    os.environ["XDG_DATA_HOME"] = str(root / "xdg")
    photo = root / "shots" / "bird.NEF"
    photo.parent.mkdir()
    photo.write_bytes(b"raw")
    sidecar_path(photo).write_text("{}")
    xmp_sidecar_path(photo).write_text("<x/>")
    (photo.with_suffix(".xmp")).write_text("<lightroom/>")  # shared with a JPEG twin — must stay
    con = _temp_db()
    iid, _ = _insert_original(con, str(photo))
    return root, photo, con, iid


def test_remove_from_library_keeps_files():
    root, photo, con, iid = _setup()
    copy = create_virtual_copy(con, iid)
    r = remove_images(con, [iid], from_disk=False)
    assert r["removed"] == [iid], r
    assert photo.exists() and sidecar_path(photo).exists()
    assert con.execute("SELECT COUNT(*) FROM images WHERE id=?", (copy,)).fetchone()[0] == 1  # copy still usable


def test_delete_from_disk_goes_to_trash_with_sidecars_and_copies():
    root, photo, con, iid = _setup()
    copy = create_virtual_copy(con, iid)
    r = remove_images(con, [iid], from_disk=True)
    assert set(r["removed"]) == {iid, copy}, r
    assert not photo.exists() and not sidecar_path(photo).exists() and not xmp_sidecar_path(photo).exists()
    assert photo.with_suffix(".xmp").exists(), "Lightroom-style shared sidecar must not be trashed"
    trash = root / "xdg" / "Trash"
    assert (trash / "files" / "bird.NEF").read_bytes() == b"raw"
    info = (trash / "info" / "bird.NEF.trashinfo").read_text()
    assert "Path=" in info and "bird.NEF" in info and "DeletionDate=" in info
    assert con.execute("SELECT COUNT(*) FROM images").fetchone()[0] == 0


def test_deleting_a_virtual_copy_from_disk_never_touches_the_file():
    root, photo, con, iid = _setup()
    copy = create_virtual_copy(con, iid)
    r = remove_images(con, [copy], from_disk=True)
    assert r["removed"] == [copy] and r["trashed"] == [], r
    assert photo.exists()


def test_trash_name_collisions_get_a_suffix():
    root, photo, con, iid = _setup()
    first = server.move_to_trash(sidecar_path(photo))
    sidecar_path(photo).write_text("{}")
    second = server.move_to_trash(sidecar_path(photo))
    assert first != second and first.exists() and second.exists()


def _on_other_disk(top: Path, fn):
    """Run fn() as if files lived on another filesystem mounted at top."""
    saved = server._same_fs, server._mount_top
    server._same_fs, server._mount_top = (lambda a, b: False), (lambda p: top)
    try:
        fn()
    finally:
        server._same_fs, server._mount_top = saved


def test_other_disk_uses_its_own_trash_not_the_home_one():
    top = Path(tempfile.mkdtemp())
    photo = top / "shoot" / "DSC_0001.NEF"; photo.parent.mkdir(); photo.write_bytes(b"raw")

    def body():
        dest = server.move_to_trash(photo)
        assert dest == top / f".Trash-{os.getuid()}" / "files" / "DSC_0001.NEF", dest
        info = (dest.parent.parent / "info" / "DSC_0001.NEF.trashinfo").read_text()
        assert "\nPath=shoot/DSC_0001.NEF\n" in info, info   # relative to the disk's top
    _on_other_disk(top, body)


def test_unwritable_other_disk_falls_back_to_the_home_trash():
    top = Path(tempfile.mkdtemp())
    photo = top / "DSC_0002.NEF"; photo.write_bytes(b"raw")
    home_trash = Path(tempfile.mkdtemp()) / "Trash"
    saved = server._trash_dir
    server._trash_dir = lambda: home_trash
    top.chmod(0o500)                     # like a share whose root is read-only
    try:
        got = []
        _on_other_disk(top, lambda: got.append(server._trash_for(photo)))
        assert got == [(home_trash, None)], got
    finally:
        top.chmod(0o700)
        server._trash_dir = saved


def _with_temp_catalog(fn):
    """Run fn(root) against a throwaway catalog/cache (patches server globals)."""
    root = Path(tempfile.mkdtemp())
    saved = server.DB_PATH, server.CACHE_DIR, server.WRITE_SIDECARS
    server.DB_PATH, server.CACHE_DIR, server.WRITE_SIDECARS = root / "c.sqlite", root / "cache", False
    for sub in ("thumb", "preview", "mask"):
        (root / "cache" / sub).mkdir(parents=True)
    with server.db() as c:
        c.executescript(server.SCHEMA)
        server._migrate_schema(c)
    try:
        fn(root)
    finally:
        server.DB_PATH, server.CACHE_DIR, server.WRITE_SIDECARS = saved


def _jpeg(p):
    from PIL import Image
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), (120, 80, 40)).save(p, quality=90)


def test_removed_photos_stay_out_of_reimports_until_restored():
    def body(root):
        shots = root / "shots"
        for n in ("a.jpg", "b.jpg"):
            _jpeg(shots / n)
        assert server.scan_folder(shots, True)["added"] == 2
        with server.db() as con:
            bid = con.execute("SELECT id FROM images WHERE filename='b.jpg'").fetchone()["id"]
            remove_images(con, [bid], from_disk=False)
        assert server.scan_folder(shots, True)["added"] == 0, "re-import must not bring b.jpg back"
        ig = server.list_ignored(str(shots))
        assert [i["filename"] for i in ig] == ["b.jpg"], ig
        r = server.restore_ignored({"paths": [ig[0]["path"]]})
        assert len(r["restored"]) == 1 and not r["missing"], r
        assert server.list_ignored(str(shots)) == []
        with server.db() as con:
            assert con.execute("SELECT COUNT(*) FROM images").fetchone()[0] == 2
    _with_temp_catalog(body)


def test_removing_the_folder_forgets_its_ignore_list():
    def body(root):
        shots = root / "shots"
        _jpeg(shots / "a.jpg")
        server.scan_folder(shots, True)
        with server.db() as con:
            remove_images(con, [con.execute("SELECT id FROM images").fetchone()["id"]], from_disk=False)
        server.remove_folder(str(shots))
        assert server.list_ignored() == []
        assert server.scan_folder(shots, True)["added"] == 1
    _with_temp_catalog(body)


if __name__ == "__main__":
    test_remove_from_library_keeps_files()
    test_delete_from_disk_goes_to_trash_with_sidecars_and_copies()
    test_deleting_a_virtual_copy_from_disk_never_touches_the_file()
    test_trash_name_collisions_get_a_suffix()
    test_other_disk_uses_its_own_trash_not_the_home_one()
    test_unwritable_other_disk_falls_back_to_the_home_trash()
    test_removed_photos_stay_out_of_reimports_until_restored()
    test_removing_the_folder_forgets_its_ignore_list()
    print("OK")
