"""sources.py: every source has what the server, the index and the web app read from it."""

import re

import pytest

import brain_index
from conftest import SERVER
from sources import FOLDERS, KIND_OF_FOLDER, SOURCE_TAGS, SOURCES, public

# Every field read from a source somewhere: server/*.py and server/web/*.js.
FIELDS = {"folder": str, "format": str, "one": str, "many": str, "label": str, "title": str, "platform": str,
          "by": str, "by_label": str, "verdicts": list, "low": str, "low_label": str, "url_prefix": str,
          "shape": str, "tag": str, "aliases": list}
SHAPES = {"square", "diamond", "triangle"}  # what web/graph.js can draw


@pytest.mark.parametrize("key", SOURCES)
def test_source_has_every_field(key):
    source = SOURCES[key]
    for field, kind in FIELDS.items():
        assert isinstance(source.get(field), kind), f"{key}: {field} missing or not a {kind.__name__}"
        assert source[field], f"{key}: {field} is empty"


@pytest.mark.parametrize("key", SOURCES)
def test_source_values_make_sense(key):
    import brain_server

    source = SOURCES[key]
    assert source["format"] in brain_index.PARSERS and source["format"] in brain_server.CATALOG_LINES
    if source["format"] == "post":
        assert key in brain_server.POST_IDENTITIES
    assert source["low"] in source["verdicts"] and len(set(source["verdicts"])) == len(source["verdicts"])
    assert re.fullmatch(r"https://[a-z.]+/", source["url_prefix"])
    assert source["shape"] in SHAPES
    assert re.fullmatch(r"[a-z]+", source["folder"]) and source["folder"] != "concepts"
    assert re.fullmatch(r"[a-z]+", key)


def test_sources_dont_collide():
    folders = [s["folder"] for s in SOURCES.values()]
    assert len(set(folders)) == len(folders)
    assert len(SOURCE_TAGS) == len(SOURCES)
    names = [n for key, s in SOURCES.items() for n in {key, s["many"], s["folder"], *s["aliases"]}]
    assert len(set(names)) == len(names), "two sources answer to the same type: name"
    assert not set(names) & {"concept", "concepts", "c", "claim", "claims"}
    assert FOLDERS == {k: s["folder"] for k, s in SOURCES.items()}
    assert KIND_OF_FOLDER == {s["folder"]: k for k, s in SOURCES.items()}
    assert [s["key"] for s in public()] == list(SOURCES)


def test_first_source_is_video():
    import brain_server

    assert brain_server.FIRST_SOURCE == "video"  # the catalog always lists it, and kind-less old runs are videos


@pytest.mark.parametrize("key", SOURCES)
def test_web_app_has_its_colours(key):
    css = (SERVER / "web" / "app.css").read_text(encoding="utf-8")
    assert f"--src-{key}:" in css
    for n in (1, 2, 3):
        assert f"--ramp-{key}-{n}:" in css
