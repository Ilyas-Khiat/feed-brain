# Feed Brain

A Chrome extension and a local Python server that turn YouTube videos and LinkedIn and X posts into Obsidian notes by running headless Claude Code (`claude -p`) inside the user's vault, plus a no-build web app (dashboard, graph, search, Ask the brain). Read [docs/how-it-works.md](docs/how-it-works.md) for the architecture and [docs/development.md](docs/development.md) before changing anything.

## Map

- `server/brain_server.py`: HTTP server, job queue, capture runs (`run_claude`), checks, catalog, git sync, Ask (`ask_brain`).
- `server/brain_index.py`: reads the vault for the web app: stats, graph, Louvain clusters, BM25F search.
- `server/sources.py`: one table that defines every source (video, LinkedIn post, X post). Everything else reads it.
- `server/prompt.md`, `prompt_post.md`, `ask.md`, `schema.md`: what Claude is told. Read fresh on every run.
- `server/web/`: plain ES modules and SVG, no framework, no build.
- `extension/`: Manifest V3. `linkedin.js` and `x.js` know each site's page layout.
- `tools/dev_server.py`, `tools/screenshots/`: a throwaway server on a vault copy, and the README screenshots.
- `tools/ask_eval.py`, `evals/ask/`: the Ask evaluation (questions with gold facts, every answer and tool call, the report). Re-score saved answers with `--rescore` after a parser change; re-asking costs plan usage.
- `tests/`: pytest over the pure logic; `conftest.py` keeps `brain_server` away from the real config, data and vault.

## Rules

- **Never run or test against the user's real vault or real server.** The real server is on port 8765. Use `tools/dev_server.py` (port 8766, a copy of the vault, git sync off). Read-only pages are free; captures and Ask questions cost the user's plan usage, so keep them few and say so.
- **Keep the headless Claude flags.** `--setting-sources project,local`, the stripped `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, the `--tools` allowlist, `--strict-mcp-config`, prompts on stdin or in `--system-prompt-file`, `kill_tree` to stop Claude. Each one fixes a real failure (docs/development.md explains which). Transcripts and posts are untrusted input.
- **This repo is public; the vault is private.** Never commit notes, fixtures or screenshots from the real vault, or anything from `server/data/`, without the user's explicit OK. Never write the user's personal details (emails, account names, local paths) into files here.
- **Branches.** New work goes on a branch off `main`. Merge and push only when the user asks.
- **Claims must match data.** README numbers come from `server/data/*.jsonl` (medians, with the run count). Don't describe a capability as shown when the logs don't show it.
- **Windows first.** `.cmd` files keep CRLF. Run Python with `server/.venv/Scripts/python`, never `python -I`.

## Checking a change

`server/.venv/Scripts/python -m pytest` (no Claude calls, no network; `pip install -r server/requirements-dev.txt` first), `node --check` on changed JS, then the dev server: dashboard, graph, a search. For prompt or run changes, one cheap capture on the dev server (`--model sonnet`). New pure logic gets a test in `tests/`; never build a fixture from the real vault.
