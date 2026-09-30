"""Standalone check for XMP sidecar writing (metadata round-trip). No
pytest.

Run with:

    .venv/bin/python -m backend.test_xmpwrite
"""
import tempfile
from pathlib import Path

import backend.server as server
from backend.server import write_xmp_sidecar, read_xmp_sidecar, xmp_sidecar_path


def _row(path, rating=0, flag="", label="", keywords=""):
    return {"path": str(path), "rating": rating, "flag": flag, "label": label, "keywords": keywords}


def test_writes_fresh_packet_when_no_xmp_exists():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")
    xmp = xmp_sidecar_path(photo)
    assert not xmp.exists()

    write_xmp_sidecar(_row(photo, rating=4, label="green", keywords="sunset, beach"))

    assert xmp.exists()
    result = read_xmp_sidecar(xmp)
    assert result == {"rating": 4, "label": "green", "keywords": "sunset, beach"}, result


def test_merges_preserving_foreign_lightroom_schema():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")
    xmp = xmp_sidecar_path(photo)
    xmp.write_text('''<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 6.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmp:Rating="3"
    crs:Exposure2012="0.50"
    crs:Contrast2012="10">
   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
''')

    write_xmp_sidecar(_row(photo, rating=5, label="blue", keywords="test"))

    text = xmp.read_text()
    # foreign crs: schema survives verbatim, under its ORIGINAL prefix (not ns0/ns3/etc.)
    assert 'crs:Exposure2012="0.50"' in text, text
    assert 'crs:Contrast2012="10"' in text, text
    assert "<crs:ToneCurvePV2012>" in text, text
    assert "ns0:" not in text and "ns1:" not in text and "ns2:" not in text and "ns3:" not in text, text
    # mapped fields were updated
    result = read_xmp_sidecar(xmp)
    assert result["rating"] == 5, result
    assert result["label"] == "blue", result
    assert result["keywords"] == "test", result


def test_reject_flag_writes_negative_one_rating():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")

    write_xmp_sidecar(_row(photo, rating=4, flag="reject"))

    result = read_xmp_sidecar(xmp_sidecar_path(photo))
    assert result["flag"] == "reject", result
    assert result["rating"] == 0, result  # read_xmp_sidecar() sets rating=0 alongside flag=reject


def test_pick_flag_writes_no_distinct_rating_value():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")

    write_xmp_sidecar(_row(photo, rating=3, flag=""))
    before = read_xmp_sidecar(xmp_sidecar_path(photo))
    assert before["rating"] == 3, before

    write_xmp_sidecar(_row(photo, rating=3, flag="pick"))
    after = read_xmp_sidecar(xmp_sidecar_path(photo))
    # "pick" has no XMP slot — the existing numeric rating is untouched, not cleared
    assert after["rating"] == 3, after
    assert after.get("flag") != "reject", after


def test_clearing_keywords_removes_the_subject_element_entirely():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")

    write_xmp_sidecar(_row(photo, keywords="alpha, beta"))
    assert read_xmp_sidecar(xmp_sidecar_path(photo))["keywords"] == "alpha, beta"

    write_xmp_sidecar(_row(photo, keywords=""))
    xmp = xmp_sidecar_path(photo)
    assert "dc:subject" not in xmp.read_text(), xmp.read_text()
    result = read_xmp_sidecar(xmp)
    assert result is None or "keywords" not in result, result


def test_unreadable_existing_xmp_is_left_untouched():
    """A file another tool wrote but that cannot be parsed, or has no
    rdf:Description to merge into, must survive byte for byte: replacing it
    would destroy that tool's data (e.g. Lightroom develop settings)."""
    d = tempfile.mkdtemp()
    for name, body in {
        "malformed": '<x:xmpmeta xmlns:x="adobe:ns:meta/"><crs:Exposure>+0.50</crs:Exposure',
        "no_description": '<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">'
                          '<crs:Exposure>+0.50</crs:Exposure></x:xmpmeta>',
    }.items():
        photo = Path(d) / f"{name}.NEF"
        photo.write_bytes(b"fake raw")
        xmp = xmp_sidecar_path(photo)
        xmp.write_text(body)
        write_xmp_sidecar(_row(photo, rating=2))  # must not raise
        assert xmp.read_text() == body, name


def test_reserved_ns_prefix_is_merged_not_dropped():
    """ElementTree refuses to register ns0-style prefixes; that must not make
    the whole file unreadable (and so skipped or lost)."""
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")
    xmp = xmp_sidecar_path(photo)
    xmp.write_text('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
                   '<rdf:Description xmlns:ns0="http://ns.adobe.com/camera-raw-settings/1.0/" ns0:Exposure="+0.50"/>'
                   '</rdf:RDF></x:xmpmeta>')
    write_xmp_sidecar(_row(photo, rating=3))
    text = xmp.read_text()
    assert 'Exposure="+0.50"' in text, text
    assert read_xmp_sidecar(xmp)["rating"] == 3


def test_write_sidecars_disabled_writes_nothing():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")
    xmp = xmp_sidecar_path(photo)

    old = server.WRITE_SIDECARS
    server.WRITE_SIDECARS = False
    try:
        write_xmp_sidecar(_row(photo, rating=5))
    finally:
        server.WRITE_SIDECARS = old
    assert not xmp.exists(), "no .xmp should be written when WRITE_SIDECARS is False"


def test_full_roundtrip_rating_label_and_keywords():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")

    write_xmp_sidecar(_row(photo, rating=5, label="purple", keywords="mountain, hike, summit"))

    result = read_xmp_sidecar(xmp_sidecar_path(photo))
    assert result == {"rating": 5, "label": "purple", "keywords": "mountain, hike, summit"}, result


def test_clearing_a_preexisting_rating_actually_removes_the_attribute():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")

    write_xmp_sidecar(_row(photo, rating=4))
    assert read_xmp_sidecar(xmp_sidecar_path(photo))["rating"] == 4

    write_xmp_sidecar(_row(photo, rating=0, flag=""))
    xmp = xmp_sidecar_path(photo)
    assert "xmp:Rating" not in xmp.read_text(), xmp.read_text()
    result = read_xmp_sidecar(xmp)
    assert result is None or "rating" not in result, result


def test_clearing_a_preexisting_label_actually_removes_the_attribute():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")

    write_xmp_sidecar(_row(photo, label="red"))
    assert read_xmp_sidecar(xmp_sidecar_path(photo))["label"] == "red"

    write_xmp_sidecar(_row(photo, label=""))
    xmp = xmp_sidecar_path(photo)
    assert "xmp:Label" not in xmp.read_text(), xmp.read_text()
    result = read_xmp_sidecar(xmp)
    assert result is None or "label" not in result, result


MULTI_DESC_XMP = """<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Exempt Tool">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
          xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
          xmlns:xmp="http://ns.adobe.com/xap/1.0/"
          xmlns:dc="http://purl.org/dc/elements/1.1/">
  <rdf:Description rdf:about="" tiff:Make="Nikon"/>
  <rdf:Description rdf:about="" xmp:Rating="4" xmp:Label="Blue"/>
  <rdf:Description rdf:about="">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>montagne</rdf:li>
    </rdf:Bag>
   </dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"""


def test_multiple_description_blocks_are_all_kept_in_sync():
    d = tempfile.mkdtemp()
    photo = Path(d) / "shot.NEF"
    photo.write_bytes(b"fake raw")
    xmp = xmp_sidecar_path(photo)

    # (a) clearing rating/label/keywords must reach the block that actually
    # holds them, not silently no-op on the first (unrelated) block.
    xmp.write_text(MULTI_DESC_XMP)
    write_xmp_sidecar(_row(photo, rating=0, flag="", label="", keywords=""))
    result = read_xmp_sidecar(xmp)
    assert result is None or not ({"rating", "label", "keywords"} & result.keys()), result

    # (b) writing a new value must not duplicate the attribute across two
    # sibling rdf:Description blocks under the same subject.
    xmp.write_text(MULTI_DESC_XMP)
    write_xmp_sidecar(_row(photo, rating=5, label="red", keywords="new, tag"))
    text = xmp.read_text()
    assert text.count("xmp:Rating") == 1, text
    result = read_xmp_sidecar(xmp)
    assert result["rating"] == 5, result
    assert result["label"] == "red", result
    assert result["keywords"] == "new, tag", result


if __name__ == "__main__":
    test_writes_fresh_packet_when_no_xmp_exists()
    test_merges_preserving_foreign_lightroom_schema()
    test_reject_flag_writes_negative_one_rating()
    test_pick_flag_writes_no_distinct_rating_value()
    test_clearing_keywords_removes_the_subject_element_entirely()
    test_unreadable_existing_xmp_is_left_untouched()
    test_reserved_ns_prefix_is_merged_not_dropped()
    test_write_sidecars_disabled_writes_nothing()
    test_full_roundtrip_rating_label_and_keywords()
    test_clearing_a_preexisting_rating_actually_removes_the_attribute()
    test_clearing_a_preexisting_label_actually_removes_the_attribute()
    test_multiple_description_blocks_are_all_kept_in_sync()
    print("OK")
