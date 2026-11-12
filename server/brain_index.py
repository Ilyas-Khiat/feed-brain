"""Note parsing, and the read side of the vault used by the web app (server/web/).

Every note is parsed into a record in one pass, redone only when a note changes.
The dashboard's numbers, the knowledge graph with its topic clusters, and the
search index all come from that pass. Nothing here writes to the vault: the
notes stay the only source of truth.

Which kinds of note there are (videos, LinkedIn posts…) comes from sources.py: every
source's notes become records of the same shape, with `kind` saying which source.
"""

import bisect
import hashlib
import json
import math
import re
import threading
import time
import unicodedata
import urllib.parse
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from sources import FOLDERS, KIND_OF_FOLDER, SOURCE_TAGS, SOURCES, public

FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)


def split_frontmatter(text):
    m = FRONTMATTER_RE.match(text)
    return (m.group(1), text[m.end():]) if m else ("", text)


def parse_frontmatter(text):
    """The flat `key: value` / `key: [a, b]` subset of YAML that schema.md uses."""
    fields = {}
    for line in split_frontmatter(text)[0].splitlines():
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if not m:
            continue
        key, value = m.group(1), m.group(2).strip()
        if value.startswith("[") and value.endswith("]"):
            fields[key] = [v.strip().strip("\"'") for v in value[1:-1].split(",") if v.strip()]
        else:
            fields[key] = value.strip("\"'")
    return fields


# ---------------------------------------------------------------- note parsing

SECTION_RE = re.compile(r"^##[ \t]+(.+?)[ \t]*$", re.MULTILINE)
BULLET_RE = re.compile(r"^([ \t]*)[-*][ \t]+(.*)$", re.MULTILINE)
# A link to any note: a source's folder ("videos", "posts"…) or "concepts".
NOTE_FOLDERS = "|".join(re.escape(folder) for folder in (*FOLDERS.values(), "concepts"))
WIKILINK_RE = re.compile(rf"\[\[({NOTE_FOLDERS})/([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]")
ORIGINAL_HEADING = "\n## Original post\n"  # a post note's copy of the post, written by the server
H1_RE = re.compile(r"^#[ \t]+(.+?)[ \t]*$", re.MULTILINE)
# Timestamps after the server linked them, and before (a run that failed half-way).
TS_LINK_RE = re.compile(r"\[(\d{1,2}(?::\d{2}){1,2})(?:\s*[–-]\s*(\d{1,2}(?::\d{2}){1,2}))?\]"
                        r"\((https://www\.youtube\.com/watch\?[^)\s]+)\)")
TS_RAW_RE = re.compile(r"\[@(\d{1,2}(?::\d{2}){1,2})(?:\s*[-–]\s*(\d{1,2}(?::\d{2}){1,2}))?\]")
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]*)\)")
URL_RE = re.compile(r"https?://[^\s)>\]]+")
SPOILER_RE = re.compile(r"^> \[!tldr\][^\n]*\n((?:>[^\n]*\n?)+)", re.MULTILINE)


def _seconds(ts):
    secs = 0
    for part in ts.split(":"):
        secs = secs * 60 + int(part)
    return secs


def sections(body):
    """{'key claims': text, ...}: the note's `## ` sections, by lowercase heading."""
    parts = SECTION_RE.split(body)
    return {name.strip().lower(): text.strip("\n") for name, text in zip(parts[1::2], parts[2::2])}


def first_timestamp(text, video_id):
    m = TS_LINK_RE.search(text)
    if m:
        start, end, url = m.groups()
        t = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("t", [""])[0].rstrip("s")
        seconds = int(t) if t.isdigit() else _seconds(start)
    else:
        m = TS_RAW_RE.search(text)
        if not m:
            return None
        start, end = m.groups()
        seconds = _seconds(start)
        url = f"https://www.youtube.com/watch?v={video_id}&t={seconds}s"
    return {"label": f"{start}–{end}" if end else start, "seconds": seconds, "url": url}


def drop_timestamps(text):
    return TS_RAW_RE.sub("", TS_LINK_RE.sub("", text))


def strip_md(text):
    """Markdown to the plain words a reader sees, for search, previews and Ask. Timestamps
    stay as "(03:28–07:10)": a verdict's "watch [03:28-07:10]" is the point of the line."""
    label = lambda m: f"({m.group(1)}–{m.group(2)})" if m.group(2) else f"({m.group(1)})"
    text = TS_LINK_RE.sub(label, text)
    text = TS_RAW_RE.sub(label, text)
    text = WIKILINK_RE.sub(lambda m: m.group(3) or m.group(2), text)
    text = MD_LINK_RE.sub(lambda m: m.group(1), text)
    text = URL_RE.sub(lambda m: urllib.parse.urlparse(m.group(0)).hostname or "", text)
    text = re.sub(r"\[!\w+\][^\n]*", "", text)
    text = re.sub(r"^[ \t]*[-*>][ \t]*", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*|__|`|^#+ ", "", text, flags=re.MULTILINE)
    text = re.sub(r"\(\s*\)", "", text)
    return re.sub(r"\s+", " ", text).strip()


def safe_url(url, kind):
    """A note's link, only if it points where its source lives: notes are written from
    untrusted transcripts and posts, so a `url: javascript:...` must never become a link."""
    url = str(url or "")
    prefix = SOURCES[kind]["url_prefix"]
    return url if url.startswith(prefix) and re.fullmatch(r"[^\s<>\"']+", url) else ""


def parse_video(rel_path, text, kind="video"):
    """A note in the "video" format (sources.py): spoiler, timestamped claims, sources, verdict."""
    fm = parse_frontmatter(text)
    body = split_frontmatter(text)[1]
    sec = sections(body)
    video_id = fm.get("video_id", "")

    claims = []
    for indent, content in BULLET_RE.findall(sec.get("key claims", "")):
        if not indent:
            bold = re.search(r"\*\*(.+?)\*\*", content)
            flag = re.search(r"⚠\s*(\w+)\s*:?\s*(.*)$", content)
            source = MD_LINK_RE.search(flag.group(2)) if flag else None
            claims.append({  # the claim's own timestamp is kept apart, in "ts"
                "text": strip_md(drop_timestamps(bold.group(1) if bold else content.split("⚠")[0])),
                "ts": first_timestamp(content, video_id),
                "flag": flag.group(1).lower() if flag else None,
                "flag_reason": strip_md(MD_LINK_RE.sub("", flag.group(2))) if flag else "",
                "flag_source": source.group(2) if source else None,
                "example": "",
            })
        elif claims:
            example = re.sub(r"^e\.g\.?,?\s*", "", strip_md(content), flags=re.IGNORECASE)
            claims[-1]["example"] = (claims[-1]["example"] + " " + example).strip()
    if not claims:  # notes written before schema.md had "Key claims": "### 1. <takeaway> [ts]" + a paragraph
        for block in re.split(r"^###[ \t]+", sec.get("takeaways", ""), flags=re.MULTILINE)[1:]:
            head, _, rest = block.partition("\n")
            claims.append({"text": strip_md(drop_timestamps(re.sub(r"^\d+\.\s*", "", head))),
                           "ts": first_timestamp(head, video_id),
                           "flag": None, "flag_reason": "", "flag_source": None, "example": strip_md(rest)[:300]})

    sources = []
    for indent, content in BULLET_RE.findall(sec.get("sources", "")):
        if indent or content.strip().lower().startswith("none cited"):
            continue
        url = next((u for u in URL_RE.findall(content) if "youtube.com/watch" not in u), None)
        sources.append({"text": strip_md(content), "url": url})

    verdict_text = sec.get("verdict", "")
    trust = re.search(r"trust\s+(solid|mixed|shaky)", verdict_text, re.IGNORECASE)
    spoiler = SPOILER_RE.search(body)
    signal = str(fm.get("signal", "")).strip()
    duration = str(fm.get("duration", "")).strip()
    tags = fm.get("tags") or []
    stem = rel_path.split("/", 1)[1][:-3]
    return {
        "id": rel_path,
        "kind": kind,
        "name": stem,
        "title": fm.get("title") or stem,
        "channel": fm.get("channel", ""),  # who it's from, whatever the source calls them (sources.py "by")
        "url": fm.get("url", ""),
        "video_id": video_id,
        "published": fm.get("published", ""),
        "captured": fm.get("captured", ""),
        "duration_s": _seconds(duration) if re.fullmatch(r"\d+(:\d{2}){1,2}", duration) else 0,
        "verdict": str(fm.get("verdict", "")).lower(),
        "signal": int(signal) if signal.isdigit() else None,
        "novelty": str(fm.get("novelty", "")).lower(),
        "trust": trust.group(1).lower() if trust else "",
        "tags": [t for t in (tags if isinstance(tags, list) else [tags]) if t and t not in SOURCE_TAGS],
        "action": "",
        "headline": "",
        "spoiler": strip_md(spoiler.group(1)) if spoiler else "",
        "claims": claims,
        "sources": sources,
        "concepts": sorted({m.group(2).strip() for m in WIKILINK_RE.finditer(body) if m.group(1) == "concepts"}),
        "reason": strip_md("\n".join(verdict_text.splitlines()[1:])),
        "words": len(re.findall(r"\w+", strip_md(drop_timestamps(body)))),
    }


def parse_post(rel_path, text, kind="post"):
    """A note in the "post" format (sources.py): gist, claims, links, keep/noise verdict, and
    the original text. Its record has a video's shape, with the author in the channel's place,
    so filters, facets and the dashboard treat every source alike."""
    text = text.split(ORIGINAL_HEADING)[0]  # the post's own text, copied in by the server, is not the note
    rec = parse_video(rel_path, text, kind)
    fm = parse_frontmatter(text)
    body = split_frontmatter(text)[1]
    links = []
    for indent, content in BULLET_RE.findall(sections(body).get("links", "")):
        if not indent:
            url = next(iter(URL_RE.findall(content)), None)
            links.append({"text": strip_md(content), "url": url})
    title = H1_RE.search(body)
    rec.update(
        title=strip_md(title.group(1)) if title else rec["name"],
        author=fm.get("author", ""),
        channel=fm.get("author", ""),
        headline=fm.get("headline") or fm.get("handle", ""),  # an X post has its @handle instead
        url=safe_url(fm.get("url"), kind),
        video_id="",
        duration_s=0,
        novelty="",
        action=str(fm.get("action", "")).lower(),
        published="" if fm.get("published") == "unknown" else fm.get("published", ""),
        sources=links,
    )
    return rec


PARSERS = {"video": parse_video, "post": parse_post}  # by note format (sources.py)


def parse_concept(rel_path, text):
    fm = parse_frontmatter(text)
    body = split_frontmatter(text)[1]
    sec = sections(body)

    seen = []
    for line in sec.get("seen in", "").splitlines():
        heading = re.match(r"^###[ \t]+(.*)$", line)
        bullet = re.match(r"^[ \t]*[-*][ \t]+(.*)$", line)
        if heading:
            link = WIKILINK_RE.search(heading.group(1))
            when = re.search(r"(\d{4}-\d{2}-\d{2})\s*$", heading.group(1))
            seen.append({"note": f"{link.group(1)}/{link.group(2).strip()}.md" if link and link.group(1) in KIND_OF_FOLDER else None,
                         "label": strip_md(heading.group(1).rsplit("·", 1)[0]),
                         "date": when.group(1) if when else "", "points": []})
        elif bullet and seen:
            seen[-1]["points"].append(strip_md(bullet.group(1)))

    related = []
    for _, content in BULLET_RE.findall(sec.get("related", "")):
        link = WIKILINK_RE.search(content)
        if link and link.group(1) == "concepts":
            note = content[link.end():].lstrip(" :–-")
            related.append({"name": link.group(2).strip(), "note": strip_md(note)})

    aliases = fm.get("aliases") or []
    tags = fm.get("tags") or []
    return {
        "id": rel_path,
        "kind": "concept",
        "name": rel_path[len("concepts/"):-3],
        "aliases": aliases if isinstance(aliases, list) else [aliases],
        "summary": fm.get("summary", ""),
        "tags": tags if isinstance(tags, list) else [tags],
        "created": fm.get("created", ""),
        "updated": fm.get("updated", "") or fm.get("created", ""),
        "definition": strip_md(sec.get("definition", "")),
        "seen": seen,
        "related": related,
        # The notes it links to ("Seen in"), as note ids: "videos/X.md", "posts/Y.md"…
        "note_links": sorted({f"{m.group(1)}/{m.group(2).strip()}.md" for m in WIKILINK_RE.finditer(body)
                              if m.group(1) in KIND_OF_FOLDER}),
    }


LOG_ENTRY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (.+) · (\S+)[ \t]*$")


def parse_log(text, limit=300):
    """The run log's entries, newest first: what each run created, changed and warned about."""
    entries = []
    for chunk in text.split("\n## ")[1:limit + 1]:
        lines = chunk.splitlines()
        head = LOG_ENTRY_RE.match(lines[0]) if lines else None
        if not head:
            continue
        when, target, status = head.groups()
        link = WIKILINK_RE.search(target)
        captured = link and link.group(1) in KIND_OF_FOLDER
        entry = {"time": when, "title": strip_md(target), "status": status.lower(),
                 "note": f"{link.group(1)}/{link.group(2).strip()}.md" if captured else None,
                 "new": 0, "updated": 0, "warnings": [], "error": None}
        for line in lines[1:]:
            if line.startswith("- New concepts:"):
                entry["new"] = line.count("[[concepts/")
            elif line.startswith("- Updated concepts:"):
                entry["updated"] = line.count("[[concepts/")
            elif line.startswith("- Failed:"):
                entry["error"] = line[len("- Failed:"):].strip()
            elif line.startswith("- ⚠"):
                entry["warnings"].append(line[len("- ⚠"):].strip())
        entries.append(entry)
    return entries


# ---------------------------------------------------------------- topic clusters

def louvain(n, weighted_edges):
    """Community index per node, by greedy modularity (the Louvain method).
    Deterministic: nodes are visited in index order, so the same vault gives the same clusters."""
    adj = [defaultdict(float) for _ in range(n)]
    for a, b, w in weighted_edges:
        if a != b:
            adj[a][b] += w
            adj[b][a] += w
    membership = list(range(n))  # original node -> current super-node
    while True:
        k = [sum(row.values()) for row in adj]
        m2 = sum(k)
        if not m2:
            break
        comm = list(range(len(adj)))
        tot = k[:]
        moved, improved = False, True
        while improved:
            improved = False
            for i in range(len(adj)):
                links = defaultdict(float)
                for j, w in adj[i].items():
                    if j != i:
                        links[comm[j]] += w
                current = comm[i]
                tot[current] -= k[i]
                best, best_gain = current, links.get(current, 0.0) - tot[current] * k[i] / m2
                for c in sorted(links):
                    gain = links[c] - tot[c] * k[i] / m2
                    if gain > best_gain + 1e-12:
                        best, best_gain = c, gain
                tot[best] += k[i]
                if best != current:
                    comm[i] = best
                    improved = moved = True
        if not moved:
            break
        renumber = {c: i for i, c in enumerate(sorted(set(comm)))}
        comm = [renumber[c] for c in comm]
        merged = [defaultdict(float) for _ in renumber]
        for i, row in enumerate(adj):
            for j, w in row.items():
                merged[comm[i]][comm[j]] += w
        adj = merged
        membership = [comm[m] for m in membership]
    return membership


# ---------------------------------------------------------------- search text

STOPWORDS = frozenset("""a an the and or but if of to in on at by for with from as is are was were be been
being it its this that these those there their they them then than so such not no nor too very can could
would should will shall may might must do does did done have has had having you he she we me my your our
his her what which who whom when where why how all any both each few more most other some own same just
also into over about after before between through during under again once here up down out off only don
now get got like le la les de des du un une et en est pour que qui dans sur pas plus par au aux ce ces se
sa son ses ou mais il elle nous vous ils elles je tu ne avec sont tout tous comme fait faire etre avoir""".split())
WORD_RE = re.compile(r"\w+(?:[-'’]\w+)*")
WORD_SPLIT_RE = re.compile(r"[-'’_]")


def fold(text):
    """Lowercase without accents, so 'Révèle' matches 'revele'."""
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)).lower()


def stem(word):
    """A light English stemmer: plurals and -ing/-ed, so 'tracking' and 'tracked' meet 'track'."""
    if word.isdigit() or len(word) <= 3:
        return word
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    if word.endswith("ing") and len(word) >= 7:
        return word[:-3]
    if word.endswith("ed") and len(word) >= 6:
        return word[:-2]
    return word


def word_parts(word):
    """The folded parts of one written word: 'Wi-Fi' -> ['wi', 'fi', 'wifi']."""
    folded = fold(word)
    parts = [p for p in WORD_SPLIT_RE.split(folded) if p]
    if len(parts) > 1 and "-" in folded:
        parts.append("".join(parts))
    return [p for p in parts if len(p) >= 2 and p not in STOPWORDS]


def terms_of(text):
    return [stem(p) for w in WORD_RE.findall(text) for p in word_parts(w)]


def segments(text, terms, window=0):
    """Text split into [piece, is_hit] pairs for highlighting; with a window, only the
    `window` words around the densest run of hits, with ellipses where it was cut."""
    words = list(WORD_RE.finditer(text))
    hits = [bool(terms) and any(stem(p) in terms for p in word_parts(m.group(0))) for m in words]
    start_char, end_char = 0, len(text)
    if window and len(words) > window:
        best = max(range(len(words) - window + 1), key=lambda i: (sum(hits[i:i + window]), -i))
        if not any(hits):
            best = 0
        start_char = words[best].start() if best else 0
        last = best + window - 1
        end_char = words[last].end() if last < len(words) - 1 else len(text)
    out, pos = [], start_char
    for m, hit in zip(words, hits):
        if m.start() < start_char or m.end() > end_char or not hit:
            continue
        if m.start() > pos:
            out.append([text[pos:m.start()], False])
        out.append([m.group(0), True])
        pos = m.end()
    if end_char > pos:
        out.append([text[pos:end_char], False])
    if start_char > 0:
        out.insert(0, ["…", False])
    if end_char < len(text):
        out.append(["…", False])
    return out


def edit_distance(a, b, limit):
    """Levenshtein distance, or limit + 1 as soon as it's sure to exceed the limit."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > limit:
            return limit + 1
        prev = cur
    return prev[-1]


# Field weights for BM25F: a hit in a title or an alias counts three times a hit in the body.
FIELD_WEIGHTS = {"title": 3.0, "aliases": 3.0, "summary": 2.0, "tags": 2.0, "channel": 2.0,
                 "body": 1.0, "context": 0.5}
TYPE_BOOST = {"concept": 1.2, "claim": 0.85}  # every source's notes: 1.0
K1, B = 1.2, 0.75

QUERY_TOKEN_RE = re.compile(r'(-?)(?:(\w+)(:|>=|<=|>|<|=)("[^"]*"?|[^\s"]*)|"([^"]*)"?|(\S+))')
FILTER_KEYS = {"type", "verdict", "channel", "author", "action", "tag", "novelty", "trust", "signal", "after",
               "before", "is", "concept", "sort", "duration"}
# type: values: a source by its key, plural, folder or alias (video, videos, v…), or concept / claim.
TYPE_NAMES = {name: key for key, source in SOURCES.items()
              for name in (key, source["many"], source["folder"], *source.get("aliases", []))}
TYPE_NAMES |= {"concept": "concept", "concepts": "concept", "c": "concept", "claim": "claim", "claims": "claim"}


def parse_query(q):
    """Free text, "exact phrases", -exclusions and key:value filters, e.g.
    `wifi tracking type:claim verdict:watch,skim signal>=4 after:30d -tag:privacy`."""
    words, phrases, excluded, filters, sort = [], [], [], [], None
    for neg, key, op, value, phrase, word in QUERY_TOKEN_RE.findall(q):
        if key and key.lower() in FILTER_KEYS:
            key, value = key.lower(), value.strip('"')
            if op == ":" and value[:1] and value[0] in "<>=":  # signal:>=4 reads like signal>=4
                op_len = 2 if value[1:2] == "=" else 1
                op, value = value[:op_len], value[op_len:]
            if not value:
                continue
            if key == "sort":
                sort = value.lower()
            else:
                filters.append((bool(neg), key, op, value))
        elif key:
            (excluded if neg else words).append(f"{key}{op}{value}")
        elif phrase.strip():
            (excluded if neg else phrases).append(phrase)
        elif word:
            (excluded if neg else words).append(word)
    return {"words": words, "phrases": phrases, "excluded": excluded, "filters": filters, "sort": sort}


def parse_when(value):
    """after:/before: values: 2026-10-01, 2026-10, 2026, 7d, 2w, 3m, today, yesterday."""
    value = value.lower()
    today = date.today()
    rel = re.fullmatch(r"(\d+)([dwmy])", value)
    if rel:
        n, unit = int(rel.group(1)), rel.group(2)
        return (today - timedelta(days=n * {"d": 1, "w": 7, "m": 30, "y": 365}[unit])).isoformat()
    if value in ("today", "yesterday"):
        return (today - timedelta(days=value == "yesterday")).isoformat()
    m = re.fullmatch(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", value)
    return f"{m.group(1)}-{m.group(2) or '01'}-{m.group(3) or '01'}" if m else None


def compare(actual, op, wanted):
    if actual is None:
        return False
    return {":": actual == wanted, "=": actual == wanted, ">": actual > wanted, ">=": actual >= wanted,
            "<": actual < wanted, "<=": actual <= wanted}[op]


def duration_minutes(value):
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(h|m|min)?", value.lower())
    return float(m.group(1)) * (60 if m.group(2) == "h" else 1) if m else None


def video_passes(v, key, op, value):
    """One filter against a video or post record (claims are checked against their note).
    A post's author is its channel, so channel: and author: find both."""
    folded = fold(value)
    if key in ("verdict", "novelty", "trust"):
        return v[key] in folded.split(",")
    if key in ("channel", "author"):
        return folded in fold(v["channel"])
    if key == "action":
        return v.get("action", "") in folded.split(",")
    if key == "signal":
        return value.isdigit() and compare(v["signal"], op, int(value))
    if key == "duration":
        minutes = duration_minutes(value)
        return minutes is not None and bool(v["duration_s"]) and compare(v["duration_s"] / 60, op, minutes)
    if key == "tag":
        return any(tag_matches(t, folded) for t in v["tags"])
    if key == "concept":
        return any(folded in fold(name) for name in v["concepts"])
    if key == "is":
        return any(c["flag"] and (folded == "flagged" or c["flag"] == folded) for c in v["claims"])
    if key in ("after", "before"):
        return date_passes(v["captured"], key, value)
    return True


def tag_matches(tag, folded):
    tag = fold(tag)
    return tag == folded or tag.startswith(folded) or folded in tag.split("-")


def date_passes(day, key, value):
    when = parse_when(value)
    if not when or not day:
        return False
    return day >= when if key == "after" else day < when


# ---------------------------------------------------------------- the index

class Snapshot:
    """Everything parsed from the vault at one moment. Never mutated once built."""

    def __init__(self, vault, captures_path, uri_for):
        self.version = None
        self.notes = {}  # every source's notes (sources.py), by id: "videos/X.md", "posts/Y.md"…
        self.concepts = {}
        for kind, source in SOURCES.items():
            parse = PARSERS[source["format"]]
            for p in sorted((vault / source["folder"]).glob("*.md")):
                rel_path = f"{source['folder']}/{p.name}"
                self.notes[rel_path] = parse(rel_path, p.read_text(encoding="utf-8", errors="replace"), kind)
        for p in sorted((vault / "concepts").glob("*.md"), key=lambda p: p.stem.lower()):
            rel_path = f"concepts/{p.name}"
            self.concepts[rel_path] = parse_concept(rel_path, p.read_text(encoding="utf-8", errors="replace"))
        for rec in self.records():
            rec["uri"] = uri_for(rec["id"])
        log_path = vault / "_log.md"
        self.log = parse_log(log_path.read_text(encoding="utf-8", errors="replace")) if log_path.exists() else []
        self.runs = self._read_runs(captures_path)
        self._link()
        self._cluster()
        self._build_search()

    @staticmethod
    def _read_runs(path):
        runs = []
        if not path.exists():
            return runs
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(r, dict):
                continue
            runs.append({k: r.get(k) for k in ("created", "status", "title", "verdict", "cost_usd", "seconds")}
                        | {"kind": r.get("kind") or "video"})  # runs from before posts are videos
        return runs

    def records(self):
        """Every note: the sources' notes, then concepts."""
        return (*self.notes.values(), *self.concepts.values())

    def get(self, note_id):
        return self.notes.get(note_id) or self.concepts.get(note_id)

    def count(self, kind):
        return sum(n["kind"] == kind for n in self.notes.values())

    def _link(self):
        """Edges between notes: a source's note <-> concept (either side's link counts) and concept <-> concept."""
        self.edges = {}
        self.broken = []

        def add(a, b, kind):
            key = (a, b) if a < b else (b, a)
            self.edges.setdefault(key, kind)

        for n in self.notes.values():
            for name in n["concepts"]:
                target = f"concepts/{name}.md"
                if target in self.concepts:
                    add(n["id"], target, "covers")
                else:
                    self.broken.append({"from": n["id"], "to": target})
        for c in self.concepts.values():
            for target in c["note_links"]:
                if target in self.notes:
                    add(c["id"], target, "covers")
                else:
                    self.broken.append({"from": c["id"], "to": target})
            for r in c["related"]:
                target = f"concepts/{r['name']}.md"
                if target in self.concepts:
                    if target != c["id"]:
                        add(c["id"], target, "related")
                else:
                    self.broken.append({"from": c["id"], "to": target})
        self.neighbors = defaultdict(set)
        for a, b in self.edges:
            self.neighbors[a].add(b)
            self.neighbors[b].add(a)
        for c in self.concepts.values():
            # The notes that cover it, per source: {"video": [...], "post": [...]}, every source listed.
            c["notes"] = sorted(n for n in self.neighbors[c["id"]] if n in self.notes)
            c["sources"] = {kind: [n for n in c["notes"] if self.notes[n]["kind"] == kind] for kind in SOURCES}

    def _cluster(self):
        ids = [*self.notes, *self.concepts]
        index = {node: i for i, node in enumerate(ids)}
        weights = {"covers": 1.0, "related": 0.6}
        membership = louvain(len(ids), [(index[a], index[b], weights[k]) for (a, b), k in self.edges.items()])

        # A note linked to nothing (a noise post files no concept) would be a topic of its own:
        # those all go in one last "not linked" group instead, drawn grey.
        loose = [node for node in ids if not self.neighbors[node]]
        groups = defaultdict(list)
        for node, m in zip(ids, membership):
            if self.neighbors[node]:
                groups[m].append(node)
        ordered = sorted(groups.values(), key=lambda g: (-len(g), min(g))) + ([loose] if loose else [])
        self.clusters = []
        for i, members in enumerate(ordered):
            records = [self.get(m) for m in members]
            concepts = [r for r in records if r["kind"] == "concept"]
            tags = Counter(t for r in records for t in r["tags"])
            hub = max(concepts, key=lambda r: (len(self.neighbors[r["id"]]), r["name"]), default=None)
            label = " · ".join(t for t, _ in tags.most_common(2)) or (hub["name"] if hub else records[0]["title"])
            is_loose = members is loose
            # The 8 largest clusters get the palette's 8 colours; the page generates one for each other cluster.
            slot = i + 1 if i < 8 and not is_loose else 0
            self.clusters.append({"id": i, "label": "Not linked to a concept" if is_loose else label,
                                  "hub": hub["name"] if hub else None, "slot": slot, "loose": is_loose,
                                  "size": len(members), "concepts": len(concepts),
                                  "notes": {kind: sum(r["kind"] == kind for r in records) for kind in SOURCES}})
            for r in records:
                r["cluster"] = i

    def _build_search(self):
        docs = []
        for n in self.notes.values():
            docs.append({"id": n["id"], "type": n["kind"], "rec": n, "fields": {
                "title": n["title"], "channel": n["channel"], "tags": " ".join(n["tags"]),
                "summary": n["spoiler"],
                "body": " ".join([*(f"{c['text']}. {c['example']}" for c in n["claims"]),
                                  *(s["text"] for s in n["sources"]), n["reason"], n["headline"]]),
                "context": " ".join(n["concepts"])}})
        for c in self.concepts.values():
            docs.append({"id": c["id"], "type": "concept", "rec": c, "fields": {
                "title": c["name"], "aliases": " ".join(c["aliases"]), "summary": c["summary"],
                "tags": " ".join(c["tags"]),
                "body": " ".join([c["definition"], *(p for s in c["seen"] for p in s["points"])]),
                "context": " ".join(f"{r['name']} {r['note']}" for r in c["related"])}})
        for n in self.notes.values():
            for i, claim in enumerate(n["claims"]):
                docs.append({"id": f"{n['id']}#claim-{i + 1}", "type": "claim", "rec": n, "claim": claim,
                             "fields": {"title": claim["text"],
                                        "body": f"{claim['example']} {claim['flag_reason']}",
                                        "context": n["title"]}})

        self.docs = docs
        self.postings = defaultdict(list)
        surfaces = {}
        lengths = defaultdict(list)
        for i, d in enumerate(docs):
            tf, length = Counter(), 0.0
            for field, text in d["fields"].items():
                w = FIELD_WEIGHTS[field]
                for word in WORD_RE.findall(text):
                    for part in word_parts(word):
                        term = stem(part)
                        surfaces[part] = term
                        tf[term] += w
                        length += w
            d["len"] = length
            d["terms"] = set(tf)
            d["folded"] = fold(" ".join(d["fields"].values()))
            lengths[d["type"]].append(length)
            for term, f in tf.items():
                self.postings[term].append((i, f))
        self.avgdl = {t: (sum(ls) / len(ls)) or 1.0 for t, ls in lengths.items()}
        self.surfaces = sorted(surfaces)
        self.surface_terms = surfaces

    # ------------------------------------------------------------ queries

    def overview(self):
        def light_note(n):
            return {k: n[k] for k in ("id", "kind", "name", "title", "channel", "url", "video_id", "published",
                                      "captured", "duration_s", "action", "verdict", "signal", "novelty", "trust",
                                      "tags", "spoiler", "concepts", "words", "uri", "cluster")} | {
                "claims": [{k: c[k] for k in ("text", "ts", "flag", "example")} for c in n["claims"]],
                "sources": len(n["sources"])}

        def light_concept(c):
            return {k: c[k] for k in ("id", "name", "aliases", "summary", "tags", "created", "updated", "notes",
                                      "sources", "uri", "cluster")} | {"related": [r["name"] for r in c["related"]]}

        return {
            "version": self.version,
            "generated": datetime.now().isoformat(timespec="seconds"),
            "sources": public(),
            "notes": [light_note(n) for n in self.notes.values()],
            "concepts": [light_concept(c) for c in self.concepts.values()],
            "edges": [[a, b, kind] for (a, b), kind in self.edges.items()],
            "clusters": self.clusters,
            "broken_links": self.broken,
            "log": self.log,
            "runs": self.runs,
        }

    def note(self, rel_path, vault):
        rec = self.get(rel_path)
        if not rec:
            return None
        text = (vault / rel_path).read_text(encoding="utf-8", errors="replace")
        links = []
        for n in sorted(self.neighbors[rel_path]):
            other = self.get(n)
            links.append({"id": n, "kind": other["kind"], "title": other.get("title") or other["name"],
                          "cluster": other["cluster"],
                          "relation": self.edges.get((rel_path, n) if rel_path < n else (n, rel_path))})
        return {"id": rel_path, "kind": rec["kind"], "uri": rec["uri"], "cluster": rec["cluster"],
                "fields": parse_frontmatter(text), "body": split_frontmatter(text)[1], "links": links}

    def _expand(self, word, complete):
        """Index terms for one query word, with weights: exact terms first, then (when typing,
        or when nothing matches exactly) completions of the prefix, then typo corrections."""
        weights, correction = {}, None
        for part in word_parts(word):
            term = stem(part)
            if term in self.postings:
                weights[term] = max(weights.get(term, 0), 1.0)
            if complete or term not in self.postings:
                lo = bisect.bisect_left(self.surfaces, part)
                for surface in self.surfaces[lo:lo + 40]:
                    if not surface.startswith(part):
                        break
                    completion = self.surface_terms[surface]
                    weights[completion] = max(weights.get(completion, 0), 0.6)
            if term not in self.postings and not weights and len(part) >= 4:
                limit = 1 if len(part) < 7 else 2
                near = [(edit_distance(term, t, limit), -len(self.postings[t]), t) for t in self.postings]
                near = sorted(x for x in near if x[0] <= limit)[:3]
                for _, _, t in near:
                    weights[t] = 0.7
                if near:
                    correction = (word, near[0][2])
        return weights, correction

    def _score(self, words, phrases=(), complete_last=False):
        """BM25F over every doc. Each query word is a group of weighted index terms (its
        completions and typo fixes included); returns the groups, the typo corrections, and
        per doc index its score, the groups it matched, and its matching terms."""
        groups, corrections = [], []
        for i, word in enumerate(words):
            weights, correction = self._expand(word, complete_last and i == len(words) - 1)
            if correction:
                corrections.append(correction)
            groups.append(weights)
        for phrase in phrases:
            groups += [{stem(p): 1.0} for w in WORD_RE.findall(phrase) for p in word_parts(w)]

        n = len(self.docs)
        scores, matched, hit_terms = defaultdict(float), defaultdict(set), defaultdict(set)
        for gi, weights in enumerate(groups):
            for term, weight in weights.items():
                postings = self.postings.get(term, ())
                idf = math.log(1 + (n - len(postings) + 0.5) / (len(postings) + 0.5))
                for di, tf in postings:
                    d = self.docs[di]
                    norm = K1 * (1 - B + B * d["len"] / self.avgdl[d["type"]])
                    scores[di] += weight * idf * tf * (K1 + 1) / (tf + norm)
                    matched[di].add(gi)
                    hit_terms[di].add(term)
        return groups, corrections, scores, matched, hit_terms

    def search(self, q, complete=False, limit=60):
        query = parse_query(q)
        words = [w for w in query["words"] if any(word_parts(x) for x in WORD_RE.findall(w))]
        # While typing, the last word is probably unfinished: complete it.
        typing_last = bool(complete and words and q.endswith(words[-1]))
        groups, corrections, scores, matched, hit_terms = self._score(words, query["phrases"], typing_last)
        has_text = bool(groups)

        n = len(self.docs)
        candidates = scores.keys() if has_text else range(n)
        excluded = {stem(p) for w in query["excluded"] for x in WORD_RE.findall(w) for p in word_parts(x)}
        phrases = [fold(p) for p in query["phrases"]]
        type_filters = [f for f in query["filters"] if f[1] == "type"]
        other_filters = [f for f in query["filters"] if f[1] != "type"]

        results, type_counts = [], Counter()
        for di in candidates:
            d = self.docs[di]
            if phrases and not all(p in d["folded"] for p in phrases):
                continue
            if excluded & d["terms"]:
                continue
            if not all(self._passes(d, f) for f in other_filters):
                continue
            type_counts[d["type"]] += 1
            if not all(self._passes(d, f) for f in type_filters):
                continue
            if has_text:
                coverage = len(matched[di]) / max(1, len(groups))
                score = scores[di] * (0.3 + 0.7 * coverage ** 2) * TYPE_BOOST.get(d["type"], 1.0)
            else:
                score = 0.0
            results.append((score, di))

        sort = query["sort"] or ("relevance" if has_text else "new")
        if sort in ("new", "old"):
            results.sort(key=lambda r: self._date(self.docs[r[1]]), reverse=sort == "new")
        elif sort == "signal":
            results.sort(key=lambda r: (self.docs[r[1]]["rec"].get("signal") or 0, r[0]), reverse=True)
        else:
            results.sort(key=lambda r: (r[0], self._date(self.docs[r[1]])), reverse=True)

        facets = {"type": dict(type_counts), "verdict": Counter(), "channel": Counter(), "tag": Counter()}
        for _, di in results:
            d = self.docs[di]
            if d["type"] == "concept":
                facets["tag"].update(set(d["rec"]["tags"]))
                continue
            v = d["rec"]  # a claim counts with its video's verdict, channel and tags
            facets["verdict"][v["verdict"] or "?"] += 1
            facets["channel"][v["channel"] or "?"] += 1
            facets["tag"].update(set(v["tags"]))
        for key in ("verdict", "channel", "tag"):
            facets[key] = facets[key].most_common(12)

        suggestion = q if corrections else None  # "did you mean", with each typo replaced
        for word, term in corrections:
            surface = term if term in self.surface_terms else next(
                (s for s in self.surfaces if self.surface_terms[s] == term), term)
            suggestion = re.sub(rf"(?<![\w:]){re.escape(word)}(?!\w)", surface, suggestion, count=1)

        return {
            "query": q,
            "total": len(results),
            "facets": facets,
            "suggestion": suggestion,
            "results": [self._result(self.docs[di], score, hit_terms[di]) for score, di in results[:limit]],
        }

    def _date(self, d):
        rec = d["rec"]
        return rec.get("captured") or rec.get("updated") or ""

    def _passes(self, d, f):
        neg, key, op, value = f
        if key == "type":
            ok = d["type"] in {TYPE_NAMES.get(t, t) for t in fold(value).split(",")}
        elif d["type"] == "concept":
            c = d["rec"]
            folded = fold(value)
            if key == "tag":
                ok = any(tag_matches(t, folded) for t in c["tags"])
            elif key == "concept":
                ok = any(folded in fold(n) for n in (c["name"], *c["aliases"]))
            elif key in ("after", "before"):
                ok = date_passes(c["updated"], key, value)
            elif key == "is":
                ok = False
            else:  # a video or post field: true when any note that covers the concept matches
                ok = any(video_passes(self.get(n), key, op, value) for n in c["notes"])
        elif d["type"] == "claim" and key == "is":
            flag = d["claim"]["flag"]
            ok = bool(flag) and (fold(value) == "flagged" or flag == fold(value))
        else:
            ok = video_passes(d["rec"], key, op, value)
        return ok != neg

    def _result(self, d, score, terms):
        rec = d["rec"]
        out = {"id": d["id"], "type": d["type"], "score": round(score, 3), "uri": rec["uri"],
               "cluster": rec["cluster"]}

        def best_of(texts):  # the passage with the most query words; the first one on a tie
            texts = [t for t in texts if t]
            return max(texts, key=lambda t: len(terms & set(terms_of(t))), default="")

        if d["type"] == "concept":
            body = best_of([rec["summary"], rec["definition"], *(p for s in rec["seen"] for p in s["points"])])
            out |= {"path": rec["id"], "title": segments(rec["name"], terms),
                    "snippet": segments(body, terms, 32), "aliases": rec["aliases"],
                    "sources": {kind: len(ids) for kind, ids in rec["sources"].items()}, "updated": rec["updated"]}
        elif d["type"] in SOURCES:
            best = best_of([rec["spoiler"], *(f"{c['text']}. {c['example']}" for c in rec["claims"]), rec["reason"]])
            out |= {"path": rec["id"], "title": segments(rec["title"], terms), "snippet": segments(best, terms, 32),
                    "channel": rec["channel"], "captured": rec["captured"], "verdict": rec["verdict"],
                    "signal": rec["signal"], "video_id": rec["video_id"], "duration_s": rec["duration_s"],
                    "action": rec.get("action", "")}
        else:
            claim = d["claim"]
            out |= {"path": rec["id"], "title": segments(claim["text"], terms),
                    "snippet": segments(claim["example"], terms, 32), "ts": claim["ts"], "flag": claim["flag"],
                    "flag_reason": claim["flag_reason"], "video_title": rec["title"], "channel": rec["channel"],
                    "captured": rec["captured"], "verdict": rec["verdict"], "video_id": rec["video_id"],
                    "source": rec["kind"]}
        return out


    # ------------------------------------------------------------ ask the brain

    def relevance(self, text):
        """How related each video and concept is to a free-text question (a claim counts for its video)."""
        words = [w for w in WORD_RE.findall(text) if word_parts(w)]
        groups, _, scores, matched, _ = self._score(words)
        out = defaultdict(float)
        for di, score in scores.items():
            d = self.docs[di]
            coverage = len(matched[di]) / max(1, len(groups))
            out[d["rec"]["id"]] += score * (0.3 + 0.7 * coverage ** 2) * (0.5 if d["type"] == "claim" else 1.0)
        return out

    def note_refs(self):
        """What a page needs to show a cited note, by note id ("videos/X.md")."""
        refs = {}
        for rec in self.records():
            refs[rec["id"]] = {"id": rec["id"], "kind": rec["kind"], "title": rec.get("title") or rec["name"],
                               "cluster": rec["cluster"]}
            if rec["kind"] in SOURCES:
                refs[rec["id"]] |= {"video_id": rec["video_id"], "channel": rec["channel"]}
        return refs


# A cited moment: 04:23, 1:02:03 or a range 03:28–07:10 (the same pattern as TS_CITED in web/ui.js).
TS_CITED = r"\d{1,2}(?::\d{2}){1,2}(?:\s*[–-]\s*\d{1,2}(?::\d{2}){1,2})?"
# How Ask answers cite: [[videos/Some title]], [[videos/Some title@04:23]], [[posts/Author - start]], [[concepts/Name]].
CITE_LINK_RE = re.compile(rf"\[\[((?:{NOTE_FOLDERS})/[^\]|#]+?)(?:@({TS_CITED}))?(?:\|[^\]]*)?\]\]")


def cited(answer, notes):
    """The notes an answer cites, in order of first use, with the moments it cites them at.
    `notes` is Snapshot.note_refs(); links to notes that don't exist are left out."""
    out = {}
    for path, ts in CITE_LINK_RE.findall(answer):
        # Claude often cites a note by its title, and a title can end with "." while the note's
        # file name doesn't ("Your WiFi Can See You. Here's How." is "…Here's How.md"): the server
        # strips trailing dots from file names on every OS. Exact names still win.
        note = f"{path.strip()}.md"
        if note not in notes:
            note = f"{path.strip().rstrip('. ')}.md"
        if note in notes:
            entry = out.setdefault(note, dict(notes[note], ts=[]))
            if ts and ts not in entry["ts"]:
                entry["ts"].append(ts)
    return out


class BrainIndex:
    """The current Snapshot, rebuilt when a note, the run log or the capture log changes."""

    def __init__(self, vault, captures_path, uri_for, check_every=2.0):
        self.vault = vault
        self.captures_path = captures_path
        self.uri_for = uri_for
        self.check_every = check_every
        self._lock = threading.Lock()
        self._snapshot = None
        self._checked = 0.0
        self._overview_json = None

    def _signature(self):
        h = hashlib.sha1()
        folders = (*FOLDERS.values(), "concepts")
        files = [*(p for folder in folders for p in sorted((self.vault / folder).glob("*.md"))),
                 self.vault / "_log.md", self.captures_path]
        for p in files:
            try:
                st = p.stat()
            except OSError:
                continue
            h.update(f"{p.name}|{st.st_mtime_ns}|{st.st_size}\n".encode("utf-8"))
        return h.hexdigest()[:16]

    def _current(self):
        """The snapshot, rebuilt first if the vault changed. Called with the lock held."""
        now = time.monotonic()
        if self._snapshot is None or now - self._checked >= self.check_every:
            self._checked = now
            version = self._signature()
            if self._snapshot is None or version != self._snapshot.version:
                snap = Snapshot(self.vault, self.captures_path, self.uri_for)
                snap.version = version
                self._snapshot = snap
                self._overview_json = json.dumps(snap.overview(), ensure_ascii=False).encode("utf-8")
        return self._snapshot

    def get(self):
        with self._lock:
            return self._current()

    def overview_json(self):
        """(version, JSON bytes) of one snapshot, for /api/brain and its ETag."""
        with self._lock:
            return self._current().version, self._overview_json
