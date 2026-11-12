"""How the server starts, talks to and stops Claude Code, on macOS, Linux and Windows.

A fake `claude` CLI stands in for the real one: a Python script that reads its prompt from stdin
and answers like `claude -p` (JSON, or the stream-json events Ask reads), or hangs with a child
process of its own. On Windows it's wrapped in a .cmd file, like the npm install of Claude Code,
so these tests also cover the wrapper that made kill_tree necessary. No real Claude, no network.
"""

import json
import os
import subprocess
import sys
import textwrap
import time

import pytest

import vaultkit as vk

FAKE = textwrap.dedent(r'''
    import json, os, subprocess, sys, time

    mode = os.environ.get("FAKE_CLAUDE_MODE", "json")
    pids = os.environ.get("FAKE_CLAUDE_PIDS")
    prompt = sys.stdin.buffer.read().decode("utf-8")

    def out(event):
        sys.stdout.write(json.dumps(event) + "\n")
        sys.stdout.flush()

    if mode == "hang":
        # A child of its own, like the node process behind a wrapper, then wait to be stopped.
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        with open(pids, "w") as f:
            f.write(f"{os.getpid()} {child.pid}")
        time.sleep(120)
    elif mode == "stream":
        note = os.path.join(os.getcwd(), "videos", "Radar.md")
        out({"type": "stream_event", "event": {"type": "message_start"}})
        out({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": note}}]}})
        answer = "Radar sees through walls [[videos/Radar@01:10]]."
        for part in (answer[:10], answer[10:]):
            out({"type": "stream_event", "event": {"type": "content_block_delta",
                                                   "delta": {"type": "text_delta", "text": part}}})
        out({"type": "result", "subtype": "success", "is_error": False, "result": answer, "num_turns": 2,
             "total_cost_usd": 0.01, "usage": {"input_tokens": 100, "cache_read_input_tokens": 900,
                                               "output_tokens": 20}})
    else:
        out({"type": "result", "is_error": False, "result": "ok", "stdin": prompt, "argv": sys.argv[1:],
             "cwd": os.getcwd(), "env_keys": sorted(os.environ)})
''')


@pytest.fixture
def fake_claude(server, tmp_path, monkeypatch):
    """Point the server at the fake claude, launched the way the real one is on this OS."""
    script = tmp_path / "fake_claude.py"
    script.write_text(FAKE, encoding="utf-8")
    if os.name == "nt":
        launcher = tmp_path / "claude.cmd"
        launcher.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        launcher = tmp_path / "claude"
        launcher.write_text(f"#!{sys.executable}\n" + FAKE, encoding="utf-8")
        launcher.chmod(0o755)
    monkeypatch.setitem(server.CFG, "claude_path", str(launcher))
    monkeypatch.setitem(server.CFG, "web_check", False)
    return server


def alive(pid):
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie (exited, not yet reaped) counts as gone.
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(")")[-1].split()[0] != "Z"
    except OSError:
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout
        return bool(state.strip()) and not state.strip().startswith("Z")


def read_pids(path, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if path.exists() and path.read_text().strip():
            return [int(p) for p in path.read_text().split()]
        time.sleep(0.1)
    raise AssertionError("the fake claude never started")


def assert_all_stopped(pids, timeout=10):
    end = time.time() + timeout
    while time.time() < end and any(alive(p) for p in pids):
        time.sleep(0.2)
    assert not [p for p in pids if alive(p)], "Claude or a process it started was left running"


def test_run_claude_sends_the_prompt_on_stdin_and_drops_the_custom_endpoint(fake_claude, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "not-for-claude")
    prompt = "A prompt with \"quotes\", a % sign, a new\nline, & accents: é ✓"
    result = fake_claude.run_claude(prompt, "sonnet")
    assert result["stdin"] == prompt  # never through the command line, which cmd.exe would mangle
    assert {"--setting-sources", "project,local", "--strict-mcp-config", "--model", "sonnet"} <= set(result["argv"])
    assert "WebSearch" not in result["argv"][result["argv"].index("--tools") + 1]  # web_check is off
    assert os.path.samefile(result["cwd"], fake_claude.VAULT)
    assert "ANTHROPIC_BASE_URL" not in result["env_keys"] and "ANTHROPIC_AUTH_TOKEN" not in result["env_keys"]


def test_a_run_that_times_out_stops_claude_and_everything_it_started(fake_claude, tmp_path, monkeypatch):
    pids_file = tmp_path / "pids"
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "hang")
    monkeypatch.setenv("FAKE_CLAUDE_PIDS", str(pids_file))
    monkeypatch.setitem(fake_claude.CFG, "timeout_minutes", 0.1)  # 6 s, room for a slow CI machine to start it
    started = time.time()
    with pytest.raises(RuntimeError, match="still running"):
        fake_claude.run_claude("prompt", None)
    assert time.time() - started < 60
    assert_all_stopped(read_pids(pids_file))


def test_ask_streams_each_step_and_saves_the_cited_answer(fake_claude, tmp_path, monkeypatch):
    vault = fake_claude.VAULT
    vk.video(vault, "Radar", title="Radar", channel="Lab", verdict="watch", signal=4, captured=vk.days_ago(1),
             tags=["radar"], claims=["**Radar sees through walls.** [@01:10]"], spoiler="Radar through walls.")
    monkeypatch.setattr(fake_claude, "INDEX", fake_claude.BrainIndex(vault, tmp_path / "captures.jsonl",
                                                                     fake_claude.obsidian_uri))
    monkeypatch.setattr(fake_claude, "ASK_LOG", tmp_path / "asks.jsonl")
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "stream")
    events = []
    fake_claude.ask_brain("can radar see through walls?", events.append, lambda: False)

    assert {"type": "tool", "tool": "Read", "target": "videos/Radar.md"} in events
    assert "".join(e["text"] for e in events if e["type"] == "delta") == "Radar sees through walls [[videos/Radar@01:10]]."
    done = events[-1]
    assert done["type"] == "done" and done["read"] == ["videos/Radar.md"] and done["steps"] == 2
    assert list(done["refs"]) == ["videos/Radar.md"] and done["refs"]["videos/Radar.md"]["ts"] == ["01:10"]
    assert done["tokens_in"] == 1000 and done["tokens_cached"] == 900
    saved = [json.loads(line) for line in (tmp_path / "asks.jsonl").read_text(encoding="utf-8").splitlines()]
    assert saved[-1]["question"] == "can radar see through walls?"


def test_closing_the_page_stops_the_question_and_claude(fake_claude, tmp_path, monkeypatch):
    pids_file = tmp_path / "pids"
    monkeypatch.setattr(fake_claude, "ASK_LOG", tmp_path / "asks.jsonl")
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "hang")
    monkeypatch.setenv("FAKE_CLAUDE_PIDS", str(pids_file))
    page_closed = lambda: pids_file.exists() and bool(pids_file.read_text().strip())  # once Claude is going
    with pytest.raises(fake_claude.PageGone):
        fake_claude.ask_brain("a question", lambda event: None, page_closed)
    assert_all_stopped(read_pids(pids_file))
    assert not (tmp_path / "asks.jsonl").exists()  # a stopped question isn't saved


def test_claude_binary_finds_the_native_install_off_path(server, tmp_path, monkeypatch):
    home = tmp_path / "home"
    native = home / ".local" / "bin" / ("claude.exe" if os.name == "nt" else "claude")
    native.parent.mkdir(parents=True)
    native.write_text("", encoding="utf-8")
    native.chmod(0o755)
    monkeypatch.setattr(server.Path, "home", classmethod(lambda cls: home))
    monkeypatch.setitem(server.CFG, "claude_path", None)
    monkeypatch.setenv("PATH", "")
    assert server.claude_binary() == str(native)
