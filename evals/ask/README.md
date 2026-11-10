# Ask the brain: multi-hop evaluation

[← Back to the README](../../README.md)

Can *Ask the brain* answer questions whose answer is spread across several notes, when the catalog it starts from doesn't say which notes those are? Twelve questions with known answers, run on November 10, 2026 against a copy of my vault (53 videos, 14 LinkedIn posts, 17 X posts, 158 concepts), on Claude Sonnet through Claude Code.

## Results

| | |
|---|---|
| Gold facts in the answers | **41 / 41** |
| Source notes cited, of those a complete answer needs | **22 / 25** (the 3 misses named the right video but cited the concept note that summarises it) |
| Multi-source questions answered from 2+ notes | **10 / 10** |
| Questions solved by following the vault's links | **4**, with **7** link hops (concept note → the videos and posts it lists) |
| Questions that needed a text search to find the second source | **1** (the two sources share no concept) |
| "Not in the vault" control | refused correctly after one search, nothing invented |
| Details spot-checked against the notes | 15 numbers, names and timestamps: none invented |
| Cost | **$0.63** for all 12; median **$0.044** per question (the first, with a cold cache, $0.16) |
| Time | median **10 s** (7.5–14 s) |
| Input served from the prompt cache | median **92%** after the first question |

| Question | Kind | Facts | Notes cited | Path |
|---|---|---|---|---|
| `heretic` | bridge: a tool the catalog never names | 4/4 | 2/2 | post → *Abliteration* concept → the video's entry |
| `html-medium` | two sources with no shared concept | 4/4 | 2/2 | grep "HTML" → post; grep "HTML" → video |
| `claude-md-rules` | contradiction between an X post and a LinkedIn post | 4/4 | 2/2 | X post → LinkedIn post (from the catalog) |
| `decision-models` | three sources, one concept | 5/5 | 3/3 | *Decision model* concept → X post → video → video |
| `wifi-walls` | chain from one video to the others on its topic | 4/4 | 3/3 | video → video → video |
| `adsb` | two uses of the same data | 4/4 | 2/2 | *ADS-B* concept (its entries were enough) |
| `satellite` | two uses of the same technique | 4/4 | 1/2 | *Satellite change detection* concept → video |
| `rea` | do two videos agree on a tool | 4/4 | 2/2 | video → video |
| `subagents` | compare a video and an X post | 4/4 | 2/2 | video → X post |
| `osint-graph` | which videos share an idea | 3/3 | 2/4 | *OSINT* concept → video → video |
| `control-catalog` | control: answerable from the catalog | 1/1 | 1/1 | one note, to quote it |
| `absent` | control: not in the vault | — | — | one search, then "no video covers this" |

## Three answers, step by step

**Three sources, found through a concept note.** *"Three things I saved are about cheap models that can only pick from a fixed list of answers. What is each one, what does it cost or how fast is it, and what does the trading desk use it for?"*
Claude opened the *Decision model* concept note, followed its "Seen in" links to an X article and two videos, and answered with all five gold facts:
- Jev at about $20 per million calls, against roughly $11,000 on a frontier model;
- OpenAI's Decisions API answering in a few hundred milliseconds;
- the trading desk using Jev to pick which seat acts next and to gate closed trades.

It also said which source gives no price. Cost: 4 notes, 5 steps, $0.08, 12 s.

**A bridge the catalog can't see.** *"There's a tool that shows up both in a video and in a post I saved about removing refusals from AI models. What is it…?"*
The tool, Heretic, appears nowhere in the catalog. Claude opened the LinkedIn post, followed its link to the *Abliteration* concept note, found Heretic in the video's entry there, and answered: Heretic, about 5½ minutes and $5 on an A6000. It added that these figures are self-reported. Cost: 2 notes, 3 steps.

**A contradiction across platforms.** *"The X course about running a company with 50 agents says to put hard rules in CLAUDE.md. Does anything else I saved disagree?"*
The two posts share no concept. Claude read the X course, recognised the LinkedIn post from its one-line summary in the catalog, and set them against each other. The course says to put "Never send an email without my approval" in CLAUDE.md. The post says CLAUDE.md rules are requests Claude may ignore, and that hooks make them hold; its author found 9 unprotected "never" rules in his own 181-line file. Cost: 2 notes, 3 steps.

## A bug it found

The `wifi-walls` answer cited all three videos, but two of the citations didn't resolve. Their titles end with a period ("Your WiFi Can See You. Here's How."), Windows drops a trailing period from file names, and Claude cites notes by title. The page showed those citations as a red "?". Fixed in `brain_index.cited()` and `server/web/ui.js`, with a test (`test_cited_finds_a_note_cited_by_a_title_ending_with_a_dot`). The scores above are after the fix: the answers were scored again, not asked again.

## Limits

- **12 questions, one run each.** The answers would vary from run to run, and a bigger set would give tighter numbers.
- **I wrote the questions knowing the vault**, to need specific hops. They test whether Ask can combine notes, not how often real questions need it. On real use so far, most questions were answered from the catalog plus at most one note.
- **Facts are checked with regular expressions**, which can miss a correct paraphrase or accept a wrong sentence that contains the right word. I also read all 12 answers, and spot-checked 15 specific details against the notes.
- **Concept notes summarise their sources**, so an answer can be right without opening every source note. The "notes cited" column counts that as a miss.

## Reproduce

Run a dev server on a copy of your vault, then the questions:

```bash
server/.venv/Scripts/python tools/dev_server.py --vault PATH/TO/VAULT
```

```bash
server/.venv/Scripts/python tools/ask_eval.py evals/ask/questions.json --vault DEV_COPY/vault --out evals/ask/results.json
```

The questions in [`questions.json`](questions.json) are written for my vault. For your own, keep the format: the question, the notes a full answer must cite, and the facts it must contain. [`results.json`](results.json) holds every answer, tool call and score.
