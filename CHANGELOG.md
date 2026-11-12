# Changelog

Versions follow [semantic versioning](https://semver.org). The server (`__version__` in `server/brain_server.py`) and the extension (`extension/manifest.json`) always share one version, and a release tag must match it.

## [1.0.0] - 2026-11-12

First public release.

### Runs on macOS, Linux and Windows
- `server/start.sh` starts the server on macOS and Linux, and `server/start.command` lets you double-click it in Finder. `start.cmd` is unchanged on Windows.
- Claude Code is found where the native installer puts it (`~/.local/bin`) even when that folder isn't on the PATH.
- CI runs the tests, and starts the server with each launcher like a new user would, on Ubuntu, macOS and Windows.

### Capture
- One click on a YouTube video (or a Short) turns it into a note sized to the video: a spoiler, 3 to 8 key claims with an example and a timestamp link each, the sources it cites, and a verdict.
- LinkedIn and X posts go in when you save, like, repost or right-click them, including X articles and the pictures and documents in posts.
- Ideas are filed into shared concept notes, and the main claims are checked on the web.
- Every run is checked afterwards: unfinished sections, word budget, broken links, rewording, edits outside the allowed folders.

### Web app
- A dashboard, a topic graph (Louvain clusters, bundled links between topics), and BM25F search down to single claims, with filters in the query.
- *Ask the brain*: answers from your notes only, with every point cited, by reading the vault's own links instead of an embeddings index. [Evaluated](evals/ask/README.md) on 12 multi-hop questions: 41/41 gold facts, 22/25 required notes cited.

### Sync
- Several computers can capture into one vault through a private git repo. The server adds the merge rules this needs to new vaults.

### Fixed in this release
- On a timeout, a capture run could hang forever on Windows, with Claude left running: only the `.cmd` wrapper was stopped, and the server then waited on Claude's output. Claude and everything it started are now stopped, on every OS.
- *Ask the brain* dropped citations to notes whose title ends with a period.
- `vault_name` now defaults to the vault folder's name, so "Open in Obsidian" links work whatever the folder is called.

[1.0.0]: https://github.com/Ilyas-Khiat/feed-brain/releases/tag/v1.0.0
