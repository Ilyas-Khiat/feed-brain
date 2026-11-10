"""Two computers syncing one vault through a remote (git_sync): both add a run-log entry at the
same place, the second pulls. With the rules ensure_vault_git_files adds, both entries are kept;
without them, the same pull conflicts. Everything happens in tmp_path, with no network."""

import os
import shutil
import subprocess

import pytest

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not on PATH")


@pytest.fixture
def git_env(tmp_path, monkeypatch):
    """git that ignores this computer's own settings (signing, hooks, autocrlf), with a test identity."""
    empty = tmp_path / "empty.gitconfig"
    empty.write_text("", encoding="utf-8")
    for key, value in {"GIT_CONFIG_GLOBAL": str(empty), "GIT_CONFIG_NOSYSTEM": "1",
                       "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
                       "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com"}.items():
        monkeypatch.setenv(key, value)


def git(cwd, *args):
    r = subprocess.run(["git", *args], cwd=cwd, env=os.environ, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout


@pytest.mark.parametrize("with_rules", [True, False], ids=["with-rules", "without-rules"])
def test_two_computers_log_at_once(tmp_path, git_env, use_vault, monkeypatch, with_rules):
    remote, a, b = tmp_path / "remote.git", tmp_path / "a", tmp_path / "b"
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(remote))

    # Computer A sets the vault up and pushes it.
    git(tmp_path, "init", "-q", "-b", "main", str(a))
    bs = use_vault(a)
    monkeypatch.setitem(bs.CFG, "git_sync", True)
    bs.bootstrap_vault()
    if not with_rules:
        (a / ".gitattributes").unlink()
    git(a, "remote", "add", "origin", str(remote))
    assert bs.git_sync("Set up") is None
    git(tmp_path, "clone", "-q", str(remote), str(b))

    # Both finish a run at the same time: each adds its entry at the top of _log.md.
    bs.append_log({"title": "Video from A", "verdict": "watch"}, "done")
    assert bs.git_sync("Add: Video from A") is None
    use_vault(b)
    bs.append_log({"title": "Video from B", "verdict": "skim"}, "done")
    problem = bs.git_sync("Add: Video from B")

    log = (b / "_log.md").read_text(encoding="utf-8")
    assert not (b / ".git" / "rebase-merge").exists() and not (b / ".git" / "rebase-apply").exists()
    if with_rules:
        assert problem is None
        assert "Video from A · watch" in log and "Video from B · skim" in log
        assert "<<<<<<<" not in log
        assert git(b, "status", "--porcelain") == ""
        assert git(b, "rev-parse", "HEAD") == git(remote, "rev-parse", "main")  # pushed
    else:
        assert problem.startswith("git pull hit a conflict")
        assert "Video from B" in log and "Video from A" not in log  # B's commit kept, nothing lost
        assert "Add: Video from B" in git(b, "log", "-1", "--format=%s")
