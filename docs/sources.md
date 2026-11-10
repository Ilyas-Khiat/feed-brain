# LinkedIn and X posts

[← Back to the README](../README.md)

> **Responsible use.** The extension reads only the page you're on and the posts you act on. It never crawls a feed, scrolls, clicks or types on LinkedIn or X. The one exception is an X article you just bookmarked, liked or right-clicked, which is opened in a background tab to be read in full. LinkedIn's and X's terms still restrict automated collection of their content: this is a personal tool, for your own account, provided as is.

## LinkedIn posts

The extension also reads LinkedIn, so the posts you keep end up next to your videos: same concepts, same catalog, same Ask the brain.

**Sending a post.** Nothing to remember: a post goes to your brain when you
- **save** it (the *Save* item in the post's `…` menu), or
- **react** to it (Like, or any reaction from the picker; taking a reaction back doesn't count), or
- **right-click** it and pick *Send this post to your brain*, or open the popup on a single post's page.

Saves and reactions can each be turned off in the popup, which only shows these settings on LinkedIn. Each time, a short message at the bottom of the LinkedIn page says what happened: sent, already in your brain, or why it couldn't be sent. Windows can hide Chrome's notifications, so this message is the one to watch. The badge counts the posts being written, and each finished post also gives a silent notification. A post you already sent isn't sent again.

**The post note** (`posts/<author> - <start of the post>.md`) is shorter than a video's, since you've already read the post:
- a one-line **gist**, naming the specific thing rather than the topic
- 0–3 **claims**, scaled to the post's length, with ⚠ flags if a web check disputes one
- the **links** the post shares
- **0–2 concepts**: an existing concept gets a "Seen in" entry for the post. A new concept is created only when the post explains the idea, not when it just names it.
- a **verdict**: *keep* (an idea, fact, resource or person worth finding again) or *noise* (job news, engagement bait, ads). Noise posts keep their gist, so you can still find them, but they file no concepts.
- what you did (`action: saved`, `like`, `celebrate`…), the date it was published, and the date you captured it
- the **original post**, in a collapsed block written by the server, since posts get edited and deleted

**How it works.** `linkedin.js` reads the post from the page you're on: author, headline, text, a reshared post, links, its pictures, and what else is attached. It never clicks or types anything on LinkedIn, and nothing crawls your feed or your saved items. LinkedIn's current layout often doesn't show a post's own link. The post is then known by the key LinkedIn gives it (SHA-256 of its id), so it's still recognised if you send it again. The note's `url` then points to the author's profile, and its publication date comes from the "1 j" or "25 oct." next to the author's name. The server checks what it receives and runs Claude with `prompt_post.md` on **Sonnet** (`post_model`), with at most one web search, and only when the post states a number or fact worth checking. Otherwise a post run is the same as a video run: the same sandbox, checks, catalog, log and git sync. A post takes about 20 seconds, around $0.10 of plan usage with this vault (a noise post a little less).

**Setup.** Reload the extension (`chrome://extensions` → reload icon). It adds itself to the LinkedIn and X tabs already open, so there's no need to reload them; if a right-click says "ready on this page now", right-click the post again. The popup on a LinkedIn tab says how many posts on the page it can read. If it says it found posts but can't read them, LinkedIn has changed its layout and `linkedin.js` needs updating.

A vault created before posts existed has no post template in its `schema.md`, so the server adds the one from `server/schema.md` to each post run. To change how post notes look, copy the *Post note* section from `server/schema.md` into the vault's `schema.md` and edit it there.

## X posts

X posts work like LinkedIn posts, in their own folder (`xposts/`) and colour (green). A post goes to your brain when you **bookmark** it, **like** it or **repost** it (each can be turned off in the popup on x.com), when you **right-click** it and pick *Send this post to your brain*, or from the popup on a post's own page. The same message at the bottom of the page says what happened.

The note is a post note, like LinkedIn's: a gist, 0–3 claims, the links, concepts, a keep/noise verdict, and the original text, including a quoted post. Only a few frontmatter fields differ. An X post has its `handle`, its `url` is always the post itself, its `post_id` is its number on X, and its publication date comes from that number. It runs on Sonnet, like LinkedIn posts (about 45 seconds and $0.15 with this vault).

**X articles** (long posts with a title) are read whole: title, headings, lists, quotes, tables, code blocks, embedded posts, and where each picture sits (`[Image 3]`). In a timeline an article shows only its title and a few lines, so when you bookmark, like or right-click one there, the extension opens the post in a **background tab**, reads the article and closes the tab (a tab flashes in the tab bar for a few seconds). If the page doesn't answer within 25 seconds, the title and the first lines are sent, marked as cut short. An article's note is written like a short video's: its budget grows with its length, up to 8 claims. An article of about 900 words with 8 pictures took 34 seconds and $0.21.

`x.js` reads both of X's layouts. Signed in, x.com still shows the older one (checked in November 2026); signed out, it shows a new one with no `data-testid`: a post is an `<article>`, its text the first `div[dir="auto"]`, its date a link to the post, a quoted post an `<article>` inside `[data-slot="embedded-tweet-frame"]`, and the buttons sit in `[data-engagement-action="like" | "bookmark" | "retweet"]` with `aria-pressed` saying whether you already pressed them. The older one is read through its `data-testid` attributes (`tweet`, `tweetText`, `User-Name`, `like`, `bookmark`), and its emojis are read back from their images. On some posts X leaves the bookmark button out of the row and puts *Bookmark* in the Share menu: that one counts too. A post X shortens behind *Show more* is captured with what's visible and marked as cut short: open the post's own page first to send it whole. A post with only a video can't be sent, since there's nothing to read; a picture alone is enough.

## Pictures and documents

A post's pictures are read too, on LinkedIn and X: a screenshot's text, a chart's numbers, a slide's points become part of the note like the post's text. On LinkedIn this includes **documents (carousels)**: LinkedIn draws their pages as pictures in the feed, each with the page's text as its description.

- The extension sends each picture's address (up to 8 on X, 10 on LinkedIn), not the picture: the biggest size the page offers up to 1280 px, `name=medium` on X.
- The server downloads them only from the platforms' own image servers (`pbs.twimg.com/media/`, `media.licdn.com/dms/image/`), checks that each is a real picture Claude will accept (under 3.75 MB, which is 5 MB once encoded, and at most 8000 px on a side; a bigger one is skipped instead of failing the run), and puts them in `server/data/attachments/<run>/`, outside the vault. The run can read that folder (`--add-dir`) and nothing else outside the vault. The folder is deleted when the run ends, and the whole `attachments` folder is cleared when the server starts (in case it was closed mid-run), so pictures never reach the notes or git.
- Video posters, link previews, profile pictures and pictures in comments are left out. A picture that fails to download is skipped and the note is written from the text.
- The original-post block says how many pictures were read. A picture costs about a cent of plan usage on Sonnet.

## Adding a source

Videos and LinkedIn posts are two *sources*, and every part of the app reads them from one table, `server/sources.py`: the vault folders, the verdicts and checks, the catalog, and the web app (dashboard, graph, search, Ask) through `/api/brain`. None of those pages names a source, so a new one (X posts, Instagram reels…) shows up in all of them once it's in the table. It gets a dashboard tile, a captures series and its low-verdict series, Quality rows, a part of the concept layer, a search type, a graph shape and a filter in *Recent captures*. To add one:

1. **Describe it** in `server/sources.py`: its folder, its note format (`"post"` for a short text post like an X post, `"video"` for something with a transcript), its names, its verdicts best first and which one means "not worth it", who's behind a note (channel, author), the start its links must have, and its graph shape.
2. **Give it colours** in `server/web/app.css`: `--src-<key>` from the next free palette slot (`--s4`, then `--s5`…), and a three-step ramp `--ramp-<key>-1..3` in that hue for its verdicts, in light and dark. Build the ramp with the same lightness steps as the video and post ramps, and check it with the dataviz palette validator (`--ordinal`). Until it has colours, a source is drawn grey.
3. **Capture it**: a way in (the extension), a prompt, and a process function in `brain_server.py`. A source in the post format can reuse `prompt_post.md` and the post note template.

Notes written before a source existed are untouched, and the catalog only gets a section for a source once it has a note.
