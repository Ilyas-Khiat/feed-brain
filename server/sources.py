"""The kinds of note a capture makes (its sources), described in one place.

Everything else reads this table: the server (vault folders, verdicts, checks, the catalog),
the index the web app is built from (brain_index.py), and the web app itself, which receives
it through /api/brain. The dashboard, graph, search and Ask have no list of sources of their
own: a source added here shows up in all of them.

Adding a source (X posts, Instagram reels…):
1. Add an entry below. `format` says how its notes are laid out, which decides how they're
   parsed and listed in the catalog: "video" (spoiler, timestamped claims, verdict) or "post"
   (gist, claims, links, keep/noise verdict, the original text). Reuse one when it fits; an X
   post is a "post", a reel with a transcript is closer to a "video".
2. Give it its colours in server/web/app.css: --src-<key> (the next free palette slot) and
   an ordinal ramp --ramp-<key>-1..3 for its verdicts, best first, light and dark.
3. Capture it: a way in (the extension), a prompt, and a process function in brain_server.py.
"""

SOURCES = {
    "video": {
        "folder": "videos",            # where its notes live in the vault
        "format": "video",
        "one": "video",                # short names, as in "3 videos"
        "many": "videos",
        "label": "YouTube video",      # what one note is, in full
        "title": "Videos",             # heading for a list of them (catalog section, dashboard tile)
        "platform": "YouTube",
        "by": "channel",               # what the person behind a note is called
        "by_label": "YouTube channel",
        "verdicts": ["watch", "skim", "skip"],  # best first
        "low": "skip",                 # the verdict that means "not worth it"
        "low_label": "skipped",        # as in "7 skipped videos"
        "url_prefix": "https://www.youtube.com/",  # a note's link must start with this
        "shape": "square",             # its mark in the graph
        "tag": "youtube",              # the tag every note carries, left out of topic tags
        "aliases": ["v"],              # more names for it in search's type: filter
    },
    "post": {
        "folder": "posts",
        "format": "post",
        "one": "post",
        "many": "posts",
        "label": "LinkedIn post",
        "title": "LinkedIn posts",
        "platform": "LinkedIn",
        "by": "author",
        "by_label": "LinkedIn author",
        "verdicts": ["keep", "noise"],
        "low": "noise",
        "low_label": "noise",
        "url_prefix": "https://www.linkedin.com/",
        "shape": "diamond",
        "tag": "linkedin",
        "aliases": ["p"],
    },
    "xpost": {
        "folder": "xposts",
        "format": "post",
        "one": "X post",
        "many": "X posts",
        "label": "X post",
        "title": "X posts",
        "platform": "X",
        "by": "account",
        "by_label": "X account",
        "verdicts": ["keep", "noise"],
        "low": "noise",
        "low_label": "noise",
        "url_prefix": "https://x.com/",
        "shape": "triangle",
        "tag": "x",
        "aliases": ["x", "tweet", "tweets"],
    },
}

FOLDERS = {key: source["folder"] for key, source in SOURCES.items()}
KIND_OF_FOLDER = {folder: key for key, folder in FOLDERS.items()}
SOURCE_TAGS = {source["tag"] for source in SOURCES.values()}


def public():
    """The table as the web app gets it, in order."""
    return [{"key": key, **source} for key, source in SOURCES.items()]
