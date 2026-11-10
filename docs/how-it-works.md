# How it works

[← Back to the README](../README.md)

## A capture, step by step

```
extension ──url──▶ server: 1. metadata (yt-dlp, oEmbed fallback) + transcript
                           2. claude -p inside the vault, with the transcript, schema.md and the catalog:
                              step 1  write the video note from the transcript alone,
                                      within a word budget set by the video's length
                              step 2  file 2-5 concepts: update existing ones, create new ones
                              step 3  web-check at most 2 claims
                              step 4  finish the note: ⚠ flags on disputed claims, concepts, verdict
                           3. bookkeeping: timestamp links, catalog, run log,
                              change report, consistency checks
          ◀── notification + popup: verdict, new/updated notes, warnings
```

**Short notes.** Each run gets a budget scaled to the video's length: 4 claims and ~170 words for an 8-minute video, 6 claims and ~250 words for a 20-minute one, never more than 8 claims and 400 words. The server counts the words afterwards, shows the reading time in the popup, and flags a note that goes well over.

**Keeping Claude focused on the video.** The video note is written in step 1, before Claude opens any other note or searches anything. The web can only add ⚠ flags to claims and set the `trust` rating; the vault only feeds the "Concepts" line. Neither can add claims.

**Not flooding the context.** Claude never reads the whole vault. The catalog gives it one line per concept, and it opens only the few concept notes it's about to update. Once the vault passes `catalog_limit` concepts (300 by default), the server sends only the ones that share the most words with the video.

**Consistency.** `schema.md` defines every note type, and the server hands it to Claude on each run. After the run, the server checks the result and reports problems as warnings instead of silently fixing them. It checks for:
- unfinished sections
- an invalid verdict
- a note well over its word budget
- links to concepts that don't exist
- concepts missing a "Seen in" entry for this video or post
- rewording of existing text
- edits outside `videos/`, `posts/` and `concepts/`

**Sandboxing.** Claude runs on your Claude Code subscription login. It ignores your user-level `~/.claude/settings.json`, including any custom `ANTHROPIC_BASE_URL`. It can read and write only inside the vault folder, so the rest of your disk (and the rest of an Obsidian vault it lives in) is off limits. Its only tools are Read, Edit, Write, Glob and Grep, plus web search if `web_check` is on: no Bash, no WebFetch, and none of your MCP servers or claude.ai connectors. Transcripts and LinkedIn posts are treated as untrusted text.

## Project layout

```
feed-brain/                     (this folder: the code)
├─ extension/                   Chrome extension (Manifest V3)
│  ├─ background.js             sends videos and posts, polls jobs, badge + notifications
│  ├─ capture.js                shared by the sites' scripts: sending a post, the save/react clicks,
│  │                            the right-click menu, the message at the bottom of the page
│  ├─ linkedin.js, x.js         how LinkedIn's and X's pages are built: reading a post and what you did
│  ├─ popup.html/js/css         send button, focus field, LinkedIn settings, recent runs + what each changed
│  └─ shared.js                 constants and helpers used by both
├─ server/
│  ├─ brain_server.py           local HTTP server + worker (see above)
│  ├─ sources.py                the kinds of note (videos, LinkedIn and X posts): see sources.md
│  ├─ brain_index.py            reads the vault for the web app: stats, graph, clusters, search
│  ├─ web/                      the dashboard, graph and search pages (no build step)
│  ├─ prompt.md                 the run instructions given to Claude (edit freely)
│  ├─ prompt_post.md            the same for a LinkedIn or X post
│  ├─ ask.md                    how "Ask the brain" answers questions (edit freely)
│  ├─ schema.md                 default vault schema, copied into the vault on first start
│  ├─ config.json               this computer's settings (not in git; start.cmd creates it
│  │                            from config.example.json)
│  ├─ start.cmd                 double-click to run the server
│  └─ data/                     captures.jsonl: one line per capture (your usage log)
│                               asks.jsonl: every "Ask the brain" answer
├─ docs/                        these pages and the README screenshots
├─ examples/                    sample output from test runs
└─ discovery/                   product-discovery notes, written before the code
```

The vault has its own layout, documented inside it in `schema.md`:

```
feed-brain/                     (the Obsidian vault)
├─ schema.md                    how the vault is structured; Claude follows it on every run
├─ videos/                      one note per video
├─ posts/                       one note per LinkedIn post
├─ xposts/                      one note per X post
├─ concepts/                    one note per idea, shared by every video and post that covers it
├─ _catalog.md                  every concept + one-line summary, every video + its spoiler,
│                               every post + its gist
│                               (rebuilt by the server; Ask the brain starts from it)
└─ _log.md                      what each run created and changed (written by the server)
```
