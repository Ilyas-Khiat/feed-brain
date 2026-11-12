# Developing Feed Brain

[← Back to the README](../README.md)

What you need to know to change Feed Brain without breaking it: how to run it safely, why the Claude calls look the way they do, the platform traps already hit, and how the README's screenshots and numbers are made. [How it works](how-it-works.md) covers the architecture.

Commands below use `server/.venv/bin/python` (macOS and Linux). On Windows it's `server/.venv/Scripts/python`. The venv is the one `start.sh` or `start.cmd` creates.

## Run a dev server, never your real one

A capture run edits the vault, and an Ask question costs plan usage, so changes are tried on a copy:

```bash
server/.venv/bin/python tools/dev_server.py
```

```bash
server/.venv/bin/python tools/dev_server.py --vault ~/path/to/your/vault --with-data
```

The script copies the server code, the vault (the sample one in `examples/` by default, without its `.git`) and optionally `server/data/` into a new temp folder, writes that copy's own `config.json` (port **8766**, git sync off), and runs it. The dashboard, graph and search are free to use there. A capture costs the same as a real one; `--model sonnet` makes video runs cheaper.

- Your real server stays on 8765 and is never touched. The script refuses a port that's already taken.
- On Windows, Python's servers set `SO_REUSEADDR`, which there lets a second server share a port. Captures once went to the wrong server that way, so `Server.allow_reuse_address` is off on Windows: a second server refuses to start instead.
- Run the server with the venv's Python, not `python -I`: isolated mode drops the script's folder from the import path, and `brain_server.py` can't import `brain_index` and `sources`.

## The headless Claude contract

Every Claude call is a `claude -p` subprocess: capture runs in `run_claude`, questions in `ask_command`. Each flag is there for a reason found the hard way. Change them only on purpose.

| Flag or setting | Why |
|---|---|
| Prompt on **stdin**, stable instructions in `--system-prompt-file` | On Windows `claude` is an npm `.cmd` wrapper, so arguments go through `cmd.exe`, which breaks multi-line and special-character text. Never pass a prompt as an argument. |
| `--setting-sources project,local`, and `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` removed from the child's env (`claude_env`) | User-level settings can point Claude Code at a custom gateway or force a model. Runs must use the Claude Code subscription login, whatever the user's own setup. |
| `--tools Read,Edit,Write,Glob,Grep` (+ `WebSearch` when `web_check` is on); Ask gets `Read,Grep,Glob` | Without `--tools`, a headless run also gets Task, scheduling, messaging and other agent tools. Transcripts and posts are untrusted text, so a run gets only what `prompt.md` uses. If the prompt ever needs another tool, add it here too. |
| `--strict-mcp-config` | Even with built-in tools removed, the user's claude.ai connectors (Drive, Docs…) load as MCP tools. This flag removes them. |
| `cwd` = the vault, `--permission-mode acceptEdits` | In `-p` mode, Read/Grep/Glob work inside the working directory without approval and are refused outside it, and `acceptEdits` approves writes only inside it. That's the sandbox. |
| `--add-dir <folder>` | The one way a run reads outside the vault: a post's downloaded pictures, in `server/data/attachments/<run>/`, deleted afterwards. |
| `--max-turns N` (Ask) | Works although `--help` doesn't list it. Hitting it ends the run with `subtype: error_max_turns` and no answer, which the server turns into a readable error. `--max-budget-usd` exists too. |
| `--output-format json` (captures), `stream-json --verbose --include-partial-messages` (Ask) | Ask streams each tool call and the answer's text to the page as they happen. |

Two more Windows traps:
- **Stopping Claude**: killing the `Popen` only kills `cmd.exe`, and Claude keeps running. `kill_tree` uses `taskkill /T /F /PID`.
- **Claude's stdout mangles non-ASCII on Windows.** Anything shown to the user (the notification's spoiler, for one) is read back from the note file Claude wrote, not from its output.

## Prompt caching

Caching only hits when the beginning of the prompt is byte-for-byte the same as a recent call. Ask puts everything stable (the instructions in `ask.md` and the whole catalog) in the system prompt file, and only the keyword hints, the conversation so far and the question on stdin. Measured on real questions: follow-ups get 96–97% of their input from the cache and cost $0.02–0.04, against about $0.10 for a first question. The cache is lost when the catalog changes (every capture rebuilds it) and after a few minutes without a question.

## Git sync

`git_sync` in `brain_server.py`: under a lock, commit everything (tagged with the computer's name), `pull --rebase`, rebuild the catalog from the notes and commit it, push. It never forces: a conflict aborts the rebase, keeps the commits local and returns a warning. It runs at startup, before and after each run, and every `git_sync_minutes` while no job is running.

On first start the server adds `_log.md merge=union` and `_catalog.md merge=union` to the vault's `.gitattributes` (`ensure_vault_git_files`). Without them, two computers that each finish a run at the same time conflict on both files and sync stops. To check it, make a bare repo with two clones, add a run-log entry at the same place in each, and `pull --rebase` the second: it conflicts without the rules and keeps both entries with them.

## Web app and server

- No build step: plain ES modules in `server/web/`, served by the Python server. Hand-written SVG charts, a hand-written force layout, Louvain clustering in `brain_index.py`, BM25F search in pure Python.
- The pages read `/api/brain` (stats, graph, the notes' metadata), `/api/search`, `/api/note` and `/api/asks`; a question is a `POST /api/ask` that streams its progress. The extension uses `/health`, `/jobs` and `POST /capture`.
- The server answers only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>` (`LOCAL_HOSTS`), which blocks DNS rebinding. Chrome extensions may call only the capture routes, never `/api/` (every note, and paid questions).
- The theme choice is `yb-theme` in `localStorage` (a name kept from the old project name, so saved choices survive).

## Repo hygiene

- `.cmd` files must keep CRLF line endings (`.gitattributes` says so). A batch file with LF endings misreads its `goto` labels.
- `server/config.json`, `server/data/` (run log, Ask history, attachments) and `server/.venv/` are per-computer and git-ignored.
- **This repo is public; your vault isn't.** Nothing from your real vault goes in a commit: not notes, not test fixtures copied from it, not `server/data/`. Screenshots are the exception you choose to make, so look at each one before committing it.
- Check `git config user.email` in every new clone. A global email (a work address, say) would be published with your commits.

## README screenshots

The README's images come from a dev server on a copy of a real vault, taken in both themes:

```bash
node tools/screenshots/shoot.mjs tools/screenshots/readme.json docs/images
```

`readme.json` lists each shot: the route, the theme, the viewport, an optional crop, and JavaScript steps such as clicking a search result. Two shots target things that exist only in the author's vault (a note about Claude skills and a saved Ask answer about WiFi). Change those steps for your own vault: a step that finds nothing logs it. `BASE` and `CHROME` env variables change the server address and Chrome's path.

The demo at the top of the README is recorded the same way, from a script of steps (open a route, click, type key by key, press Enter, wait until the page is ready, scroll). It captures Chrome's screencast frames with their real timing, then ffmpeg makes the GIF (12 fps, 960 px, 128 colours) and an MP4. Its last step is a live *Ask the brain* question, so a recording costs one question of plan usage.

```bash
node tools/screenshots/record.mjs tools/screenshots/demo.json FRAMES
```

```bash
ffmpeg -f concat -safe 0 -i FRAMES/frames.txt -vf "setpts=PTS/1.25,fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" docs/images/demo.gif
```

```bash
ffmpeg -f concat -safe 0 -i FRAMES/frames.txt -vf "setpts=PTS/1.25,fps=30,scale=1280:-2" -c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart docs/images/demo.mp4
```

## Evaluating Ask

`tools/ask_eval.py` runs questions with known answers against a dev server and records every tool call. It scores the gold facts found, the required notes cited (with the server's own citation parser), the notes opened, and the link hops: notes opened right after reading a note that links to them. The set in `evals/ask/` is written for the author's vault; [its report](../evals/ask/README.md) has the method, results and limits. Two habits:
- **Write the gold facts before the first run**, from the notes, never from the answers.
- **Read every answer.** The regexes are a first pass. Spot-check numbers and timestamps against the notes, because a fact can come from a concept note's summary of a source, not the source note itself.

After changing the citation parser or the scorer, score the saved answers again with `--rescore` rather than asking again.

## Numbers in the README

They come from `server/data/captures.jsonl` (one line per capture: kind, status, cost, seconds) and `asks.jsonl` (one per question: steps, notes read, tokens in and from cache, cost). Medians, not averages, and say how many runs. For example:

```bash
server/.venv/bin/python -c "import json,statistics as s; r=[json.loads(l) for l in open('server/data/captures.jsonl',encoding='utf-8')]; v=[x for x in r if x.get('kind') in (None,'video') and x.get('status')=='done']; print(len(v), s.median(x['cost_usd'] for x in v), s.median(x['seconds'] for x in v))"
```

## Running the tests

```bash
server/.venv/bin/python -m pip install -r server/requirements-dev.txt
```

```bash
server/.venv/bin/python -m pytest
```

The tests in `tests/` make no Claude calls and use no network, so they're free and take a few seconds. They cover search (BM25F ranking, stemming, completion, typo correction, every query filter), Louvain clusters, Ask's relevance ranking, note parsing, timestamp links, the catalog, the vault's git rules, the checks after a run, how LinkedIn and X posts are cleaned, the `sources.py` table, and git sync between two clones of one vault (skipped without `git`). `tests/conftest.py` sets `FEED_BRAIN_CONFIG` and `FEED_BRAIN_DATA` before importing `brain_server.py`, so the tests never read `server/config.json`, never write to `server/data/` and never see your vault; each test gets its own vault in a temp folder. GitHub Actions runs them on Ubuntu and Windows, Python 3.10 and 3.12, plus `node --check` on every script in `extension/` and `server/web/` ([`.github/workflows/tests.yml`](../.github/workflows/tests.yml)).

## Checking a change

Before committing:

1. `server/.venv/bin/python -m pytest`, `server/.venv/bin/python -m py_compile server/*.py` and `node --check` on any changed `.js` file.
2. Start a dev server and open the dashboard, the graph and a search.
3. For a change to a run or a prompt: capture one short video on the dev server (`--model sonnet` to keep it cheap), then read the note and the warnings in the popup.
4. For the extension: reload it in `chrome://extensions`, then send a video and a post.
