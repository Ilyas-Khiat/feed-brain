# Roadmap

What's next, in the order it would pay off. Done so far: video capture, the dashboard, graph,
search and Ask the brain, LinkedIn and X capture (posts you save, react to or right-click),
YouTube Shorts, X articles, the pictures and LinkedIn documents in posts, and posts in the web
app next to videos (dashboard, graph, search, Ask).

## 1. Check LinkedIn capture on the real site

The layout `linkedin.js` reads was measured on the real feed (2026-10-28), and right-click
capture works: 10 posts came in by 2026-11-01. Two things are still open:
- **Saves and reactions.** All 10 posts were sent by right-click. What opens on a click (the "…"
  menu with Save, the reactions picker) hasn't been seen on LinkedIn itself; if saving or
  reacting sends nothing, those two need checking.
- **Publication dates.** A post whose id isn't on the page (4 of the 10) gets its date from the
  "1 j" / "25 oct." next to its author, and that comes back empty on the real feed. Find where
  the current layout puts that text.

## 2. Check X capture on the real site

`x.js` was measured on x.com on 2026-11-05, both signed out (a new layout, with no
`data-testid`: 5 of 5 posts read on a profile, quoted posts and X articles, t.co links) and
signed in (the older `data-testid` layout: 7 of 7 on the home timeline, emojis, quoted posts,
"Show more"). Reposting works: 2 of the first 4 X posts came in that way (2026-11-09). Still
open:
- **Bookmark in the Share menu.** About half the posts have no bookmark button in their row, and
  X puts "Bookmark" in their Share menu instead. `x.js` recognises that item by its text, a
  guess: the menu was never seen.

## 3. Older saves and reactions

Posts saved or liked before the extension existed aren't in the vault. Do it without crawling:
LinkedIn's data export (Settings → Data privacy → Get a copy of your data) lists reactions with
their dates and links. Check whether it includes saved posts. An import would queue those links,
and each post would still need its text: open it, then right-click to send it.

## 4. Smaller things

- A post you liked and later saved keeps only its first `action`. Record every action instead,
  with no new Claude run.
- A LinkedIn document is read from the pages the feed shows (5 on the one checked, 2026-11-09).
  A long document may have more pages than that: check whether the feed loads them all.
- The X timeline's article card has no cover picture in its HTML; the background tab reads the
  article's own pictures instead. Signed-out X (the new layout) isn't read as an article yet.
- A noise post still pays for the full catalog in its prompt. A cheap first pass could decide
  noise vs keep before the catalog is sent.
