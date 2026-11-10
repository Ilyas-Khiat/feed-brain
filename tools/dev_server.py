"""Run a throwaway Feed Brain server on a copy of a vault, never on the real one.

    server/.venv/Scripts/python tools/dev_server.py                      # the sample vault in examples/
    server/.venv/Scripts/python tools/dev_server.py --vault ~/my-vault   # a copy of your own vault
    server/.venv/Scripts/python tools/dev_server.py --vault ~/my-vault --with-data   # + run log and Ask history

The server code, the vault and server/data are copied into a fresh folder in the system temp
directory, with their own config.json (port 8766, git sync off). Captures and questions you run
there cost plan usage like real ones, but write only to the copy. The dashboard, graph and
search are free. Stop it with Ctrl+C; the copy is left in place for inspection.
"""
import argparse
import json
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "server"
CODE = ["*.py", "*.md", "requirements.txt"]


def port_in_use(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", type=Path, default=REPO / "examples", help="vault to copy (default: examples/)")
    ap.add_argument("--port", type=int, default=8766, help="default 8766, so it never meets a real server on 8765")
    ap.add_argument("--with-data", action="store_true", help="also copy server/data's run log and Ask history")
    ap.add_argument("--model", help="model for video runs in the copy (e.g. sonnet, to test cheaply)")
    args = ap.parse_args()

    source = args.vault.expanduser().resolve()
    if not source.is_dir():
        sys.exit(f"No vault at {source}")
    if port_in_use(args.port):
        sys.exit(f"Port {args.port} is taken. Is another dev server running? Pick another with --port.")

    root = Path(tempfile.mkdtemp(prefix="feed-brain-dev-"))
    vault, server = root / "vault", root / "server"
    shutil.copytree(source, vault, ignore=shutil.ignore_patterns(".git"))
    server.mkdir()
    for pattern in CODE:
        for f in SERVER.glob(pattern):
            shutil.copy2(f, server / f.name)
    shutil.copytree(SERVER / "web", server / "web")
    (server / "data").mkdir()
    if args.with_data:
        for name in ("captures.jsonl", "asks.jsonl"):
            if (SERVER / "data" / name).exists():
                shutil.copy2(SERVER / "data" / name, server / "data" / name)

    config = json.loads((SERVER / "config.example.json").read_text(encoding="utf-8"))
    config.update(vault_path=str(vault), vault_name=vault.name, port=args.port, git_sync=False)
    if args.model:
        config["model"] = args.model
    (server / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")

    print(f"Copy of {source}\n  in {root}\n  open http://127.0.0.1:{args.port}/\n", flush=True)
    try:
        subprocess.run([sys.executable, "brain_server.py"], cwd=server)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
