"""Start Feed Brain the way a new user does, with start.sh (macOS, Linux) or start.cmd (Windows),
then check the server answers. Run from the repo root in CI:  python .github/scripts/launcher_smoke.py

1. macOS and Linux: the first run, with no config.json, creates it and exits cleanly.
2. With vault_path set to an empty folder, the launcher builds server/.venv, installs the
   requirements and starts the server, which must answer /health with this release's version,
   serve the dashboard and /api/brain, and set up the vault (folders, schema.md, git rules).
3. The server and everything the launcher started are stopped at the end.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SERVER = REPO / "server"
PORT = 8799  # not 8765, so it can never talk to a real server running on the same machine
BASE = f"http://127.0.0.1:{PORT}"


def fail(msg):
    print(f"FAIL: {msg}", flush=True)
    sys.exit(1)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return r.status, r.read()


def launcher():
    if os.name == "nt":
        # stdin from NUL, so start.cmd's closing "pause" can't wait for a key.
        return subprocess.Popen(["cmd", "/c", str(SERVER / "start.cmd")], stdin=subprocess.DEVNULL,
                                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    return subprocess.Popen(["bash", str(SERVER / "start.sh")], stdin=subprocess.DEVNULL, start_new_session=True)


def stop(proc):
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.wait(timeout=30)


def main():
    version = re.search(r'__version__ = "([^"]+)"', (SERVER / "brain_server.py").read_text(encoding="utf-8")).group(1)
    config = SERVER / "config.json"
    if config.exists():
        fail("server/config.json already exists: run this on a clean checkout")
    shutil.rmtree(SERVER / ".venv", ignore_errors=True)

    if os.name != "nt":  # start.cmd opens Notepad on its first run, which CI can't close
        first = subprocess.run(["bash", str(SERVER / "start.sh")], stdin=subprocess.DEVNULL, timeout=60)
        if first.returncode != 0 or not config.exists():
            fail(f"first run should create config.json and exit 0 (exit {first.returncode})")
        print("first run: config.json created", flush=True)

    vault = Path(tempfile.mkdtemp(prefix="feed-brain-smoke-")) / "My Vault"
    vault.mkdir()
    cfg = json.loads((SERVER / "config.example.json").read_text(encoding="utf-8"))
    cfg.update(vault_path=str(vault), git_sync=False, port=PORT)
    config.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    proc = launcher()
    try:
        deadline = time.time() + 300  # the first start creates the venv and installs the requirements
        health = None
        while time.time() < deadline:
            if proc.poll() is not None:
                fail(f"the launcher exited early with code {proc.returncode}")
            try:
                health = json.loads(get("/health")[1])
                break
            except OSError:
                time.sleep(2)
        if not health:
            fail("the server never answered /health")
        print("health:", health, flush=True)
        if health.get("version") != version:
            fail(f"/health says version {health.get('version')}, brain_server.py says {version}")
        if health.get("vault") != "My Vault":
            fail(f"vault_name should default to the vault folder's name, got {health.get('vault')!r}")
        for path in ("/", "/api/brain"):
            status, _ = get(path)
            if status != 200:
                fail(f"{path} answered {status}")
        for name in ("videos", "posts", "xposts", "concepts", "schema.md", "_catalog.md", "_log.md", ".gitattributes"):
            if not (vault / name).exists():
                fail(f"the vault has no {name}")
        venv_python = SERVER / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not venv_python.exists():
            fail("the launcher didn't create server/.venv")
        print(f"OK: the {'start.cmd' if os.name == 'nt' else 'start.sh'} launcher works on {sys.platform}", flush=True)
    finally:
        stop(proc)
        config.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
