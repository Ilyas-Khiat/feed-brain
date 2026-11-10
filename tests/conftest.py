"""Test setup: the server's modules on the import path, and a server that can't reach a real vault.

brain_server.py reads its config and creates its data folder when it's imported. Before any test
imports it, FEED_BRAIN_CONFIG and FEED_BRAIN_DATA point it at a throwaway folder (a config with
a placeholder vault, git sync off), so importing it never reads server/config.json, never writes
to server/data/ and never knows where the real vault is. The `server` fixture then gives each
test its own empty vault in tmp_path.
"""

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "server"
EXAMPLES = REPO / "examples"
sys.path.insert(0, str(SERVER))

HOME = Path(tempfile.mkdtemp(prefix="feed-brain-tests-"))
(HOME / "vault").mkdir()
(HOME / "config.json").write_text(json.dumps({
    "vault_path": str(HOME / "vault"), "vault_name": "test-vault", "port": 8799, "git_sync": False,
}), encoding="utf-8")
os.environ["FEED_BRAIN_CONFIG"] = str(HOME / "config.json")
os.environ["FEED_BRAIN_DATA"] = str(HOME / "data")


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(HOME, ignore_errors=True)


@pytest.fixture
def use_vault(monkeypatch):
    """A function that points brain_server at a vault folder (created with its note folders).

    The module works out its vault paths at import; every one of them is patched here. (Two
    functions, find_existing_note and new_note_path, take the videos folder as a default
    argument fixed at import: tests pass `folder=` to them.)"""
    import brain_server as bs

    assert Path(bs.DATA).resolve().is_relative_to(HOME.resolve()), "brain_server must not use server/data in tests"
    assert Path(bs.VAULT).resolve().is_relative_to(HOME.resolve()), "brain_server must not see the real vault"
    monkeypatch.setattr(bs, "log", lambda msg: None)

    def point(vault):
        vault.mkdir(parents=True, exist_ok=True)
        note_dirs = {kind: vault / source["folder"] for kind, source in bs.SOURCES.items()}
        for folder in (*note_dirs.values(), vault / "concepts"):
            folder.mkdir(exist_ok=True)
        for name, value in {
            "VAULT": vault, "NOTE_DIRS": note_dirs, "VIDEOS": note_dirs["video"], "POSTS": note_dirs["post"],
            "CONCEPTS": vault / "concepts", "SCHEMA": vault / "schema.md", "CATALOG": vault / "_catalog.md",
            "LOG": vault / "_log.md", "SERVER_FILES": {vault / "_catalog.md", vault / "_log.md"},
        }.items():
            monkeypatch.setattr(bs, name, value)
        return bs

    return point


@pytest.fixture
def server(tmp_path, use_vault):
    """brain_server, pointed at an empty vault of this test's own (tmp_path / "vault")."""
    return use_vault(tmp_path / "vault")
