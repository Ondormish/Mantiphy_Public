"""Standalone check for XMP sidecar import (read-only). No pytest —
matches this codebase's existing convention (see
backend/test_smartcollections.py, backend/test_virtualcopies.py).

Run with:

    .venv/bin/python -m backend.test_xmpimport
"""
import tempfile
from pathlib import Path

from backend.server import (
    read_xmp_sidecar,
    read_sidecar,
    sidecar_path,
    lightroom_xmp_sidecar_path,
)

LR_ATTR_XMP = """<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmp:Rating="5"
    xmp:Label="Red">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>vacances</rdf:li>
     <rdf:li>plage</rdf:li>
    </rdf:Bag>
   </dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"""

DT_ELEM_REJECT_XMP = """<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
          xmlns:xmp="http://ns.adobe.com/xap/1.0/">
  <rdf:Description rdf:about="">
   <xmp:Rating>-1</xmp:Rating>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"""


def _write(dirpath: Path, name: str, content: str) -> Path:
    p = dirpath / name
    p.write_text(content, encoding="utf-8")
    return p


def test_rating_as_attribute():
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "a.xmp", LR_ATTR_XMP)
        result = read_xmp_sidecar(p)
        assert result["rating"] == 5, result


def test_rating_as_child_element():
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "b.xmp", DT_ELEM_REJECT_XMP)
        result = read_xmp_sidecar(p)
        assert result["flag"] == "reject", result
        assert result["rating"] == 0, result


def test_rating_minus_one_is_reject_not_a_negative_rating():
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "c.xmp", DT_ELEM_REJECT_XMP)
        result = read_xmp_sidecar(p)
        assert "rating" in result and result["rating"] == 0
        assert result.get("flag") == "reject"


def test_each_color_label_lowercased():
    for color in ("Red", "Yellow", "Green", "Blue", "Purple"):
        xmp = LR_ATTR_XMP.replace('xmp:Label="Red"', f'xmp:Label="{color}"')
        with tempfile.TemporaryDirectory() as d:
            p = _write(Path(d), "d.xmp", xmp)
            result = read_xmp_sidecar(p)
            assert result["label"] == color.lower(), (color, result)


def test_multiple_keywords_joined_with_comma_space():
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "e.xmp", LR_ATTR_XMP)
        result = read_xmp_sidecar(p)
        assert result["keywords"] == "vacances, plage", result


def test_malformed_or_empty_or_tagless_returns_none_not_an_exception():
    with tempfile.TemporaryDirectory() as d:
        malformed = _write(Path(d), "bad.xmp", "not xml at all {{{")
        assert read_xmp_sidecar(malformed) is None

        empty = _write(Path(d), "empty.xmp", "")
        assert read_xmp_sidecar(empty) is None

        no_tags = _write(Path(d), "notags.xmp", """<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""/>
 </rdf:RDF>
</x:xmpmeta>""")
        assert read_xmp_sidecar(no_tags) is None

        missing = Path(d) / "does-not-exist.xmp"
        assert read_xmp_sidecar(missing) is None


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


def test_lightroom_extension_replaced_sidecar_found_and_read():
    with tempfile.TemporaryDirectory() as d:
        photo = Path(d) / "photo.NEF"
        photo.write_bytes(b"")
        _write(Path(d), "photo.xmp", LR_ATTR_XMP)

        assert lightroom_xmp_sidecar_path(photo) == Path(d) / "photo.xmp"
        result = read_sidecar(photo)
        assert result is not None and result["rating"] == 5, result


def test_appended_form_wins_over_lightroom_form_when_both_exist():
    with tempfile.TemporaryDirectory() as d:
        photo = Path(d) / "photo.NEF"
        photo.write_bytes(b"")
        appended = LR_ATTR_XMP.replace('xmp:Rating="5"', 'xmp:Rating="3"')
        _write(Path(d), "photo.NEF.xmp", appended)
        _write(Path(d), "photo.xmp", LR_ATTR_XMP)

        result = read_sidecar(photo)
        assert result is not None and result["rating"] == 3, result


def test_multiple_rdf_description_blocks_all_examined():
    with tempfile.TemporaryDirectory() as d:
        p = _write(Path(d), "f.xmp", MULTI_DESC_XMP)
        result = read_xmp_sidecar(p)
        assert result is not None
        assert result["rating"] == 4, result
        assert result["label"] == "blue", result
        assert result["keywords"] == "montagne", result


def test_read_sidecar_uses_xmp_only_when_no_mantiphy_json_present():
    with tempfile.TemporaryDirectory() as d:
        photo = Path(d) / "photo.NEF"
        photo.write_bytes(b"")  # read_sidecar only needs the path, not real RAW bytes
        _write(Path(d), "photo.NEF.xmp", LR_ATTR_XMP)

        # .xmp alone -> read via the XMP path
        result = read_sidecar(photo)
        assert result is not None and result["rating"] == 5, result

        # now add a .mantiphy.json for the same photo -> it must win, .xmp ignored
        sidecar_path(photo).write_text('{"mantiphy": 1, "rating": 1, "flag": "", "label": "", "keywords": "", "edits": {}}')
        result = read_sidecar(photo)
        assert result["rating"] == 1, result


if __name__ == "__main__":
    test_rating_as_attribute()
    test_rating_as_child_element()
    test_rating_minus_one_is_reject_not_a_negative_rating()
    test_each_color_label_lowercased()
    test_multiple_keywords_joined_with_comma_space()
    test_malformed_or_empty_or_tagless_returns_none_not_an_exception()
    test_lightroom_extension_replaced_sidecar_found_and_read()
    test_appended_form_wins_over_lightroom_form_when_both_exist()
    test_multiple_rdf_description_blocks_all_examined()
    test_read_sidecar_uses_xmp_only_when_no_mantiphy_json_present()
    print("OK")
