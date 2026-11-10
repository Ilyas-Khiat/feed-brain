# Schema

This vault is written by Feed Brain. When you send a YouTube video from the Chrome extension, a local server fetches its transcript and runs Claude Code inside this folder. Claude writes one note for the video and files the video's main ideas as concept notes that every later video can build on. Posts you keep on LinkedIn or X go through the same steps: one short note per post, linked to the same concept notes.

This file is the contract every run follows. The server gives it to Claude before each run, so if you edit it, future notes change with it.

## Layout

| Path | Contents | Written by |
|---|---|---|
| `videos/` | One note per video | Claude, once per video |
| `posts/` | One note per LinkedIn post | Claude, once per post; the server adds the post's text |
| `xposts/` | One note per X post, in the same format | Claude, once per post; the server adds the post's text |
| `concepts/` | One note per reusable idea, shared by every video and post that covers it | Claude: created once, then extended |
| `_catalog.md` | Every concept (name, aliases, one-line summary), every video (with its spoiler) and every post (with its gist) | The server, after each run |
| `_log.md` | What each run created and changed | The server, after each run |
| `schema.md` | This file | You |

Don't edit `_catalog.md` or `_log.md` by hand. The server rewrites them after every run.

## How notes connect

```
videos/<video>  ─┐
                  ├─links to──▶  concepts/<idea>  ──"Seen in" lists──▶  every video and post that covered it
posts/<post>    ─┘
```

A video or post note links to the concepts it teaches. A concept note keeps a "Seen in" entry for every video and post that covered it, recording what each one said. To see everything you know about an idea, open the concept note. To see what a single video said, open the video note.

## Video note: `videos/<video title>.md`

````markdown
---
type: video
title: "<video title>"
channel: "<channel>"
url: https://www.youtube.com/watch?v=<id>
video_id: <id>
published: YYYY-MM-DD
duration: "mm:ss"
captured: YYYY-MM-DD
verdict: watch | skim | skip
signal: 1-5
novelty: new | partial | known
tags: [youtube, <2-5 lowercase-kebab topic tags>]
---

# <video title>

> [!tldr] Spoiler
> <1-2 plain sentences, 35 words at most: what the video boils down to>

## Key claims
- **<a claim in plain words, 15 words at most>** [@mm:ss]
  - e.g. <a practical example from the video: a number, a case, a command, a result; 15 words at most>
- **<a claim>** [@mm:ss] ⚠ <contested | outdated>: <why, 10 words at most> ([source](url))
  - e.g. <example>

## Sources
- <a paper, repo, tool, dataset or person the video relies on>: <URL when known> [@mm:ss]

## Concepts
[[concepts/<Name>|<Name>]] (new) · [[concepts/<Name>|<Name>]] · [[concepts/<Name>|<Name>]]

## Verdict
**<Watch | Skim | Skip>** · signal <n>/5 · novelty <new | partial | known> · trust <solid | mixed | shaky>
<one sentence, 25 words at most: why, and for skim, which part to watch [@mm:ss-mm:ss]>
````

### How to write a video note
- **The note is short on purpose.** It should be read in about a minute. Each run gets a word budget and a claim limit scaled to the video's length; stay under both. The server counts the words after each run and flags notes over budget.
- **Word limits are hard limits.** A claim over 15 words is two claims or needs cutting. Detail belongs in the "e.g." line, and detail about a concept belongs in the concept note.
- **Keep only claims worth remembering:** surprising, practical, or backed by a number. Skip background, definitions everyone knows, and anything the video says only in passing.
- **A claim is a statement you could quote or check** ("Blind XSS pays 3x more than reflected XSS"), not a topic label ("About XSS payouts").
- **Plain words, short sentences.** No filler ("the video explains", "it's worth noting"). If a technical term is needed, it gets a few words of explanation or a link to its concept note.
- **Examples come from the video.** If the video gives none for a claim, leave the "e.g." line out rather than inventing one.
- **Sources** lists what the video cites or links (papers, repos, tools, people). If it cites nothing, write "None cited."
- **⚠ flags** mark only claims that the web check found contested or outdated. Claims that hold get no annotation, but they count toward `trust`.
- **verdict:** watch = the delivery or the visuals are the value. skim = only the segment named in the verdict is worth watching. skip = this note is enough, or the video is low signal.
- **novelty** is judged against this vault: new = none of the video's concepts existed before, known = all of them existed and the video adds little, partial = anything in between.

## Post note: `posts/<author> - <start of the post>.md` (`xposts/` for X)

A LinkedIn post and an X post get the same note. Only a few frontmatter fields differ, and each run gives the exact frontmatter to write: an X post has its `handle` instead of LinkedIn's `headline` and `urn`, and its `post_id` is the post's number on X.

````markdown
---
type: post
author: "<author>"
headline: "<the author's headline>"
url: <the post's link, or its author's profile when LinkedIn doesn't show the post's link>
post_id: <the key LinkedIn knows the post by: 43 characters>
urn: <urn:li:activity:<id>, when LinkedIn shows it>
published: YYYY-MM-DD
captured: YYYY-MM-DD
action: saved | like | celebrate | support | love | insightful | funny | manual
verdict: keep | noise
signal: 1-5
tags: [linkedin, <1-4 lowercase-kebab topic tags>]
---

# <Author>: <what the post is about, 8 words at most>

> [!tldr] Gist
> <one plain sentence, 30 words at most: what the post says or announces>

## Key claims
- **<a claim in plain words, 15 words at most>**
  - e.g. <a number, case or result from the post, 15 words at most>
- **<a claim>** ⚠ <contested | outdated>: <why, 10 words at most> ([source](url))

## Links
- <what the post links to or shares: an article, a repo, a tool, a person>: <URL>

## Concepts
[[concepts/<Name>|<Name>]] (new) · [[concepts/<Name>|<Name>]]

## Verdict
**<Keep | Noise>** · signal <n>/5 · trust <solid | mixed | shaky>
<one sentence, 25 words at most: what's worth remembering, or why it's noise>

## Original post
> [!quote]- <Author> · YYYY-MM-DD
> <the post's text, added by the server after the run>
````

### How to write a post note
- **You already read the post.** The note is for finding it again and remembering what it said, in under 30 seconds (about a minute for an article). Each run gets a budget of claims scaled to the post's length.
- **The gist names the specific thing:** "Mistral's 3B model beats Llama 3 8B on MMLU", not "a post about small models".
- **Claims come from the post alone,** like a video's. A post that only announces something or shares an opinion gets "None." under Key claims.
- **Pictures are part of the post.** Its photos and the pages of the document it shares are given to the run as images: a screenshot's text, a chart's numbers or a slide's points count as the post's own content. A picture that only decorates adds nothing.
- **An X article** is a long post with a title. Its note is written like a short video's: the gist says what it argues, the claims are its main points, and its budget grows with its length (up to 8 claims).
- **Links** lists what the post links to or shares. If nothing, write "None."
- **verdict:** keep = an idea, a fact, a resource or a person worth finding again. noise = personal or job news, engagement bait, an ad, or nothing new. A noise post still gets its gist, so you can find it, but no concepts.
- **trust:** an unsourced number, an opinion stated as fact, or a post selling the thing it praises lowers it.
- **action** is what you did on the platform: saved the post (a LinkedIn save or an X bookmark), reacted to it (the reaction's name, `like`, `repost`), or sent it by hand (manual).
- **Original post** is written by the server, never by Claude: the post's text as it was when you captured it, since posts get edited and deleted.

## Concept note: `concepts/<Concept name>.md`

````markdown
---
type: concept
aliases: [<other names and abbreviations>]
summary: "<one sentence, 25 words at most, that defines it>"
tags: [<1-3 lowercase-kebab topic tags>]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# <Concept name>

## Definition
<1-3 short sentences in plain words: what it is and when it's used>

## Seen in
### [[videos/<video file name>|<Channel>: <short title>]] · YYYY-MM-DD
- <what this video says about it, 20 words at most> [@mm:ss]
- **vs before:** <agrees, adds or contradicts, 12 words at most; leave this line out on the first entry>

## Related
- [[concepts/<Name>|<Name>]]: <how the two relate, 10 words at most>
````

A "Seen in" entry has one or two bullets. A post's entry links `[[posts/<post file name>|<Author> (LinkedIn): <short title>]]` instead, and its bullets have no timestamp. The concept note is a quick reference: its detail lives in the video and post notes it links to.

## Rules

### What counts as a concept
- A concept is a reusable idea, technique, method or tool that other videos could also cover, such as "Attention (QKV)", "Spaced repetition" or "BM25". A one-off claim, a person, a paper or a product announcement is not a concept; those belong in the video note.
- Name concepts by their common name, in the singular and in sentence case: "Spaced repetition", not "Spaced Repetitions". Use an acronym only when that's what people call it ("BM25"). Never put `\ / : * ? " < > | # ^ [ ]` in a name.
- Each video gets 2-5 concepts, and each post 0-2 (a noise post gets none). Pick the ideas a future search would look for, not every term the video or post mentions. A post that only names an idea links to its concept if it exists, but doesn't create it.
- Before creating a concept, check the catalog's names and aliases. If the idea already exists under another name, link to it and add the new name to its `aliases` instead of creating a duplicate.
- `aliases` are other names for the same idea: synonyms, abbreviations, spelling variants. Give at most 5. Variants, parts and related ideas are not aliases: "Cross-attention" and "Attention head" are not aliases of "Attention (QKV)". Link those under "Related" instead.
- `summary` is the concept's line in the catalog, so it has to define the idea on its own.

### Updating an existing concept
- Add a new entry at the end of "Seen in", add any missing links under "Related", add any new `aliases`, and set `updated`.
- Never delete or reword existing text. If the video disagrees with an earlier entry or with the definition, say so in the new entry's **vs before** line.

### Links and timestamps
- Always link with the folder and a display name, e.g. `[[concepts/Attention (QKV)|Attention (QKV)]]`, `[[videos/<file name>|<Channel>: <short title>]]` or `[[posts/<file name>|<Author> (LinkedIn): <short title>]]`.
- In video notes, write timestamps as `[@mm:ss]`, `[@h:mm:ss]` or `[@mm:ss-mm:ss]`. After each run, the server turns them into links that open YouTube at that moment. Posts have no timestamps.

### Where content comes from
- Claims, examples and "Seen in" entries come from the video or post alone.
- The vault is used to place the video or post: which concepts it touches, and what's new or contradicts earlier notes.
- The web is used only for the ⚠ flags on claims and the verdict's `trust`.
