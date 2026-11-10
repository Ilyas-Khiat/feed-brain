# Dashboard, graph, search and Ask

[← Back to the README](../README.md)


While the server runs, open **http://127.0.0.1:8765/** (or click *Dashboard* in the popup, or type in its search box). The pages read the vault directly and refresh on their own after each run.

- **Dashboard:** every source side by side, each drawn the same way on every card: its own colour for its notes (videos blue, LinkedIn posts orange), the lightest shade of that colour for its low verdict (skipped videos, noise posts), and shades of it for its verdicts and trust. A date range at the top scopes every card, and every chart has a *Table* view. The cards:
  - hours of watching distilled vs. minutes of reading, and the key numbers: one tile per source (with how many got its low verdict), concepts, concepts shared by several sources, claims
  - captures per day/week by source and verdict, and the quality of each source: its verdicts and trust in its own colours, signal
  - **the concept layer**, where videos and posts meet: how many concepts only videos reached, how many only posts did, and how many both share. Below it is the list of shared concepts, the ideas you met in a video and again on LinkedIn. Click a part of the bar, or a filter, to list another group.
  - topic clusters (notes per topic, by source), how the vault grew, an activity calendar
  - channels and LinkedIn authors in one ranking, tags by source, and what needs attention (run warnings, failed runs, broken links)
  - recent captures, filtered to videos or posts (what did I save on LinkedIn lately?), a claim to rediscover, and the runs and their cost on this computer, by source
- **Graph:** every concept, video (square) and LinkedIn post (diamond), linked the way the notes link each other and coloured by topic cluster (clusters are found from those links). Each topic has its own area, placed so that linked topics sit close and their links cross as little as possible; links between two topics are drawn as one bundle through the gap between them. Hover a node to see its neighbours, click it to read the note, click a topic to isolate it. Drag a note to move it; when you let go it moves with the others again. Notes have no names on the map, to keep it readable: hover one to see its name. Views at the top pick what the graph shows: *Everything*; *Concepts only* (two concepts linked when a note covers both); one view per source, its notes and the concepts they cover (*Videos*, *Posts*); *Where they meet*, the concepts several sources share with the notes behind them; and *Last 30 days*. The view is kept in the address (`#/graph?view=shared`), so it can be bookmarked, and a new source gets its own view. Notes linked to no concept (noise posts, mostly) share one grey group, *Not linked to a concept*, rather than each making a topic of its own.
- **Search:** ranked search over videos, LinkedIn posts, concepts and every single claim, so you can jump straight to the moment in the video. Word endings, accents and small typos are forgiven, and filters go in the query itself:

  | Query | Finds |
  |---|---|
  | `wifi tracking` | notes with these words, best matches first |
  | `"signal rate" -xss` | an exact phrase, leaving out a word |
  | `type:claim is:contested` | claims the web check flagged |
  | `type:post verdict:keep action:saved` | the posts you saved that were worth keeping |
  | `verdict:watch,skim signal>=4` | the better videos |
  | `channel:nahamsec` `author:ruben` `tag:osint` `concept:bm25` | by channel or post author, tag, or linked concept |
  | `after:30d` `before:2026-10` `duration<15` | by capture date or video length (minutes) |
  | `sort:new` | newest first (also `old`, `signal`) |

- **Ask the brain** (the box at the top of the dashboard, or the second tab on the search page): ask in plain words, e.g. *"which video showed radar seeing through walls?"*, and Claude answers from your notes, videos and posts alike. Every point is cited: a numbered chip opens the video at that moment, or the post's note, and the sources are listed under the answer. When the notes don't cover something, it says so and points to the closest notes.
  - Sonnet (`ask_model`, on your subscription) starts from `_catalog.md`: one line per concept and one per video with its spoiler. From there it decides which notes to open, follows the links inside them (a concept's "Seen in" videos, a video's concepts), and can search every note for an exact word. The page shows each note as it's read, and under the answer the notes it read and the tokens and cost it took.
  - **Follow up** under an answer to keep digging ("which of those tools are free?"). The follow-up carries the last three questions and answers of the thread, so Claude knows what "those" means, and earlier answers show above the new one. Follow-ups are marked ↳ under *Earlier questions*.
  - It can only read: Read, Grep and Glob inside the vault, no writing, no web and no MCP connectors, since the notes come from untrusted transcripts. Answers take 10–20 s, more when a question needs many notes. With this vault the first question costs about $0.11 and follow-ups within a few minutes $0.02–0.05, because the catalog is cached. `ask_max_turns` (12 reading steps) stops a question that keeps reading without answering.
  - Typing never asks on its own: only *Ask* or Enter does. Only *Stop* ends a question, and it stops Claude within a second or two, even mid-thought. Opening an earlier answer, asking another question or leaving the page lets a running one finish. Answers are kept in `server/data/asks.jsonl` and listed under *Earlier questions*, so reading one again is free.

Notes open in a side panel with clickable timestamps, *Open in Obsidian* and *Show in graph*. Only this computer can reach the pages: the server listens on 127.0.0.1 and refuses requests addressed to any other host name. Other web pages and other Chrome extensions can't read your notes or trigger a question; the Feed Brain popup only uses the capture routes.
