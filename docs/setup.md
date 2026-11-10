# Setup and use

[← Back to the README](../README.md)

## What you need

- **Windows.** The server is plain Python and should run elsewhere, but `start.cmd` and the process handling have only been used on Windows 11.
- **Python 3.10+** on your PATH.
- **Google Chrome** (or another Chromium browser that loads unpacked extensions).
- **[Claude Code](https://docs.claude.com/en/docs/claude-code/overview)**, signed in (`claude`, then `/login`). Every run is a headless `claude -p` call on your own Claude subscription: there is no API key to set.
- **[Obsidian](https://obsidian.md)** to read the notes. It's optional: the vault is plain Markdown, and the web app reads it on its own.

## Setup (once)

1. **Make a folder for the vault**, empty or inside an Obsidian vault you already have, e.g. `Documents/feed-brain`.
2. **Start the server:** double-click `server/start.cmd`. The first time, it creates `server/config.json` and opens it in Notepad: set `vault_path` to that folder, save, and run `start.cmd` again. It creates a Python environment, installs the two dependencies (`youtube-transcript-api`, `yt-dlp`) and copies the default `schema.md` into the vault. Leave the window open. Only one server can run at a time; a second one refuses to start.
   To start it with Windows, press Win+R, type `shell:startup`, and put a shortcut to `start.cmd` in that folder.
3. **Load the extension:** open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked* and pick `extension/`. To update it later, click the reload icon on its card.
4. Open the vault folder in Obsidian, and **http://127.0.0.1:8765/** for the dashboard.

## Use

- On a video, click the icon and then **Spoil it into my vault**. You can add a focus first, e.g. *"only the eval part"*. You can also press **Alt+Shift+Y**.
- The badge counts running jobs. When a job is done, you get a notification with the verdict and something like "3 new concepts · 2 updated".
- The popup lists recent runs. Expand a run to see every note it created or updated, each with a link that opens it in Obsidian: a new concept shows its summary, an updated one shows `+N lines` and which fields changed. Warnings appear there in amber.
- `_log.md` in the vault keeps the same history permanently.
- **Shorts** work the same way: open one (`youtube.com/shorts/…`) and use the popup or Alt+Shift+Y. Its note is budgeted like a one-minute video (3 claims, ~125 words) and links to it as a normal video. A Short that's only music has almost no transcript, so its note has little to say.
- Sending a video that's already in the vault gives you its link, with a *process again* option. That rewrites the note from scratch and replaces the video's entries in the concept notes.
- LinkedIn and X posts go in when you save, like or right-click them: see [Sources](sources.md).

A 30-minute video takes about 3 minutes with Opus.

## Config (`server/config.json`)

| Key | Default | What it does |
|---|---|---|
| `vault_path` / `vault_name` | `~/Documents/feed-brain` / `feed-brain` | The vault folder / the name used in `obsidian://` links |
| `model` | `opus` | The model that writes video notes. `sonnet` is faster and uses less of your plan |
| `post_model` | `sonnet` | The model that writes LinkedIn and X post notes |
| `language` | `English` | Language the notes are written in, whatever the video's language |
| `transcript_languages` | `["en", "fr"]` | Transcript languages to look for, in order |
| `web_check` | `true` | `false` = no web search; claims are rated from Claude's own knowledge |
| `catalog_limit` | `300` | Maximum number of concepts put in the prompt |
| `timeout_minutes` | `20` | A run that takes longer is stopped |
| `claude_path` | `null` | Where the `claude` CLI is, if it isn't on your PATH |
| `git_sync` / `git_sync_minutes` | `true` / `10` | Commit, pull and push the vault (if it's a git repo with a remote), and how often while idle |
| `ask_model` | `sonnet` | The model that answers *Ask the brain* questions |
| `ask_max_turns` | `12` | How many reading steps an *Ask the brain* answer may take before it's stopped |

`prompt.md` (how a run proceeds), `ask.md` (how questions are answered) and the vault's `schema.md` (what the notes look like) are read fresh every time, so changes to them take effect without a restart.

## Sync across devices (optional)

If the vault folder is a git repo with a remote (keep it **private**: it's your reading history), the server syncs it while it runs:
- after every run, in a commit named after the video or post
- before every run, to pick up edits from other devices
- every `git_sync_minutes` while idle

On a conflict (the same note edited on two devices), it never forces anything. It keeps its commits locally, shows a warning in the popup and in the server window, and pushes again once you've resolved the conflict. Edits made while the server is off are synced the next time it starts.

**Reading on another laptop or a phone:** clone the vault repo and open it in Obsidian with the community **Git** plugin: turn on *Pull on startup*, and set *Auto pull interval* and *Auto commit-and-sync interval* to 10 minutes. On Android, give the plugin a GitHub fine-grained token limited to the vault repo, with *Contents: Read and write*.

**A second computer that also captures:** set it up like the first (Claude Code, Python, Chrome, this repo), with `vault_path` pointing to its clone of the vault. Both computers then push to the same vault. Run logs and the catalog merge automatically: on its first start the server adds `merge=union` rules for `_log.md` and `_catalog.md` to the vault's `.gitattributes` (and per-device Obsidian files to its `.gitignore`), and it rebuilds the catalog after every pull. Each commit names the computer that made it. The one real conflict is both computers updating the same concept within the same few minutes: you'd see it as a warning, and nothing gets overwritten.

Where the server runs, don't turn on the Git plugin's auto commit: the server already does it, and the two would collide.

## Tips

- In Obsidian's graph view, the filter `-path:_` hides the catalog and the log, which link to everything.
- If the vault is a git repo, `git diff` shows exactly what each run changed.

## Known limits

- Videos without captions fail with "no transcript".
- LinkedIn and X: a post's text and pictures are read, and a LinkedIn document's pages as far as the feed has loaded them. Videos are listed as attached, but not watched.
- LinkedIn and X change their page layouts from time to time. `linkedin.js` and `x.js` read both the current layouts (checked in October and November 2026) and the older ones, but a big redesign can still break them. You'd notice it in the popup's "can be read" line, or in the message at the bottom of the page.
- Jobs live in memory, so restarting the server mid-job loses that job. The extension tells you to resend it.
- Capturing works only from a computer running the server; there is no hosted version.
