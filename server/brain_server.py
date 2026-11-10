"""Feed Brain: local server that turns YouTube videos and LinkedIn and X posts into Obsidian notes.

The Chrome extension POSTs a video URL here, or a LinkedIn post it read from the page.
A single worker thread fetches the video's metadata + transcript, then runs Claude Code
headless (`claude -p`) inside the vault. Claude writes the video or post note and files
its concepts; this server does the deterministic bookkeeping: catalog, run log,
timestamp links, a post's original text, change report and consistency checks. The
vault layout itself is defined in schema.md.
"""

import base64
import difflib
import hashlib
import json
import math
import os
import queue
import re
import select
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
import urllib.parse
import urllib.request
import uuid
from collections import Counter
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from youtube_transcript_api import YouTubeTranscriptApi

from brain_index import BrainIndex, cited, parse_frontmatter, split_frontmatter
from sources import KIND_OF_FOLDER, SOURCES

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

DEFAULTS = {
    "vault_path": str(Path.home() / "Documents" / "feed-brain"),
    "vault_name": None,  # defaults to the vault folder name
    "port": 8765,
    "model": "opus",
    "post_model": "sonnet",  # LinkedIn posts are short: Sonnet is plenty, and uses far less of the plan
    "language": "English",
    "transcript_languages": ["en", "fr"],
    "web_check": True,
    "catalog_limit": 300,  # above this many concepts, only the most related ones go in the prompt
    "timeout_minutes": 20,
    "claude_path": None,
    "git_sync": True,  # commit + pull + push the vault, if it is a git repo with a remote
    "git_sync_minutes": 10,  # also sync edits from other devices this often while idle
    "ask_model": "sonnet",  # answers "Ask the brain" questions in the web app
    "ask_max_turns": 12,  # how many reading steps an answer may take before it's stopped
}


def load_config():
    cfg = dict(DEFAULTS)
    path = ROOT / "config.json"
    if path.exists():
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
    cfg["vault_path"] = str(Path(cfg["vault_path"]).expanduser())
    cfg["vault_name"] = cfg["vault_name"] or Path(cfg["vault_path"]).name
    return cfg


CFG = load_config()
VAULT = Path(CFG["vault_path"])
NOTE_DIRS = {kind: VAULT / source["folder"] for kind, source in SOURCES.items()}  # every source's folder
FIRST_SOURCE = next(iter(SOURCES))
VIDEOS = NOTE_DIRS["video"]
POSTS = NOTE_DIRS["post"]
CONCEPTS = VAULT / "concepts"
SCHEMA = VAULT / "schema.md"
CATALOG = VAULT / "_catalog.md"
LOG = VAULT / "_log.md"
SERVER_FILES = {CATALOG, LOG}  # rewritten by this server, so never reported as Claude's changes

PENDING = "%% pending %%"
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
# A LinkedIn post's id: the URN in its data-urn attribute and its /feed/update/ link,
# or the "activity-<id>" at the end of a /posts/ link.
POST_URN_RE = re.compile(r"urn:li:(activity|ugcPost|share):(\d{15,22})")
POST_SLUG_RE = re.compile(r"activity-(\d{15,22})")
POST_KEY_RE = re.compile(r"[A-Za-z0-9_-]{43}")
PROFILE_URL_RE = re.compile(r"https://www\.linkedin\.com/(in|company|showcase|school)/[^\s<>\"?#]{1,200}")
X_HANDLE_RE = re.compile(r"[A-Za-z0-9_]{1,15}")
X_ID_RE = re.compile(r"\d{5,20}")
X_EPOCH_MS = 1288834974657  # an X post's id counts milliseconds from this moment (its top bits)

JOBS = {}
POST_TEXTS = {}  # job id -> the post the extension read, until the worker takes it (kept out of /jobs)
JOB_QUEUE = queue.Queue()
GIT_LOCK = threading.Lock()
MACHINE = socket.gethostname()  # tags commits, since several computers can push to one vault


# ---------------------------------------------------------------- helpers

def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def parse_video_id(url):
    u = urllib.parse.urlparse(url.strip())
    host = (u.hostname or "").lower()
    candidate = None
    if host.endswith("youtu.be"):
        candidate = u.path.strip("/").split("/")[0]
    elif host.endswith("youtube.com"):
        qs = urllib.parse.parse_qs(u.query)
        if "v" in qs:
            candidate = qs["v"][0]
        else:
            parts = [p for p in u.path.split("/") if p]
            if len(parts) >= 2 and parts[0] in ("shorts", "live", "embed"):
                candidate = parts[1]
    if candidate and VIDEO_ID_RE.match(candidate):
        return candidate
    return None


def parse_post_urn(text):
    text = urllib.parse.unquote(text or "")
    m = POST_URN_RE.search(text)
    if m:
        return f"urn:li:{m.group(1)}:{m.group(2)}"
    m = POST_SLUG_RE.search(text)
    return f"urn:li:activity:{m.group(1)}" if m else None


def urn_date(urn):
    """The day a post was published: the top bits of a LinkedIn id are its creation time in ms."""
    try:
        day = datetime.fromtimestamp((int(urn.rsplit(":", 1)[1]) >> 22) / 1000).date()
    except (ValueError, OverflowError, OSError):
        return ""
    return day.isoformat() if date(2003, 1, 1) <= day <= date.today() else ""


def x_date(status_id):
    """The day an X post was published, read from its id."""
    try:
        day = datetime.fromtimestamp(((int(status_id) >> 22) + X_EPOCH_MS) / 1000).date()
    except (ValueError, OverflowError, OSError):
        return ""
    return day.isoformat() if date(2006, 3, 1) <= day <= date.today() else ""


def post_key(urn):
    """The key LinkedIn's current layout knows a post by (in its componentkey attributes):
    SHA-256 of its id, base64url. It names every post note, whether or not the id is known."""
    return base64.urlsafe_b64encode(hashlib.sha256(urn.encode("utf-8")).digest()).rstrip(b"=").decode("ascii")


MONTHS = {"jan": 1, "janv": 1, "feb": 2, "fev": 2, "fevr": 2, "mar": 3, "mars": 3, "apr": 4, "avr": 4, "may": 5,
          "mai": 5, "jun": 6, "juin": 6, "jul": 7, "juil": 7, "aug": 8, "aou": 8, "aout": 8, "sep": 9, "sept": 9,
          "oct": 10, "nov": 11, "dec": 12}
AGE_DAYS = {"mois": 30, "min": 0, "mo": 30, "m": 0, "sem": 7, "ans": 365, "an": 365, "yr": 365, "s": 0, "h": 0,
            "j": 1, "d": 1, "w": 7, "y": 365}
AGE_RE = re.compile(r"\s*(\d+)\s*(" + "|".join(AGE_DAYS) + r")\b")
DAY_MONTH_RE = re.compile(r"\s*(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{4}))?")
MONTH_DAY_RE = re.compile(r"\s*([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?")


def when_date(text):
    """The day in the date LinkedIn shows next to a post when its id isn't on the page:
    "3 h", "1 j", "2 sem.", "5 mo", "1 an", "25 oct.", "3 mars 2025", "Oct 25". "" if unreadable."""
    t = "".join(c for c in unicodedata.normalize("NFKD", text or "") if not unicodedata.combining(c)).lower()
    today = date.today()
    m = AGE_RE.match(t)
    if m:
        return (today - timedelta(days=int(m.group(1)) * AGE_DAYS[m.group(2)])).isoformat()
    m = DAY_MONTH_RE.match(t)
    day, month, year = (m.group(1), m.group(2), m.group(3)) if m else (None, None, None)
    if not (m and month in MONTHS):
        m = MONTH_DAY_RE.match(t)
        day, month, year = (m.group(2), m.group(1), m.group(3)) if m else (None, None, None)
    if not (m and month in MONTHS):
        return ""
    for y in ([int(year)] if year else [today.year, today.year - 1]):  # no year: the last time it was that day
        try:
            when = date(y, MONTHS[month], int(day))
        except ValueError:
            continue
        if when <= today:
            return when.isoformat()
    return ""


def job_ref(job):
    """What a job is about: a video id or a post URN."""
    return job.get("video_id") or job.get("post_id") or "?"


def fmt_ts(seconds):
    s = int(seconds)
    h, m, s = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def ts_to_seconds(ts):
    secs = 0
    for part in ts.split(":"):
        secs = secs * 60 + int(part)
    return secs


def safe_filename(title, max_len=100):
    # Typographic quotes become plain ones: Claude tends to retype the path with
    # ASCII quotes, and the run would then miss the note it just wrote.
    name = title.translate(str.maketrans({"‘": "'", "’": "'", "“": " ", "”": " "}))
    name = re.sub(r'[\\/:*?"<>|#^\[\]]', " ", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name[:max_len].rstrip(" .") or "untitled"


def link_label(text, max_len=70):
    """Display text that is safe inside [[target|label]]."""
    label = re.sub(r"\s+", " ", re.sub(r"[|\[\]#^]", " ", text or "")).strip()
    if len(label) > max_len:
        label = label[:max_len].rsplit(" ", 1)[0] + "…"
    return label


def yaml_str(s):
    return (s or "").replace("\\", "\\\\").replace('"', '\\"')


def rel(path):
    return path.relative_to(VAULT).as_posix()


def obsidian_uri(rel_path):
    file_arg = rel_path[:-3] if rel_path.endswith(".md") else rel_path
    return "obsidian://open?" + urllib.parse.urlencode(
        {"vault": CFG["vault_name"], "file": file_arg}, quote_via=urllib.parse.quote)


def write_text(path, text):
    with path.open("w", encoding="utf-8", newline="") as f:  # keep LF, like Claude's notes
        f.write(text)


def read_frontmatter(path):
    try:
        return parse_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return {}


def find_existing_note(ref, folder=VIDEOS, key="video_id"):
    for p in folder.glob("*.md"):
        if read_frontmatter(p).get(key) == ref:
            return p
    return None


def new_note_path(title, ref, folder=VIDEOS):
    path = folder / f"{safe_filename(title)}.md"
    return folder / f"{safe_filename(title)} ({ref[-11:]}).md" if path.exists() else path


# ---------------------------------------------------------------- vault

CATALOG_HEADER = ("# Catalog\n\n> Rebuilt by Feed Brain after every run from the notes' frontmatter and spoilers. "
                  "Don't edit it by hand.\n")
LOG_HEADER = "# Run log\n\n> Written by Feed Brain after every run, newest first. Don't edit it by hand.\n\n"
STOPWORDS = set("""the and for with that this from are was you your not but can its into how what when
which they their have has more than one all use using also just like about there them then these
those will would could should been being some such only other over very""".split())
WORD_RE = re.compile(r"[a-z0-9]{3,}")


def bootstrap_vault():
    """Create the layout on first start. Never overwrites schema.md once it exists."""
    for folder in (*NOTE_DIRS.values(), CONCEPTS):
        folder.mkdir(exist_ok=True)
    if not SCHEMA.exists():
        shutil.copyfile(ROOT / "schema.md", SCHEMA)
    if not LOG.exists():
        write_text(LOG, LOG_HEADER)
    write_catalog()


def concept_entries():
    entries = []
    for p in sorted(CONCEPTS.glob("*.md"), key=lambda p: p.stem.lower()):
        text = p.read_text(encoding="utf-8", errors="replace")
        fm = parse_frontmatter(text)
        aliases = fm.get("aliases") or []
        entries.append({
            "name": p.stem,
            "aliases": aliases if isinstance(aliases, list) else [aliases],
            "summary": fm.get("summary", ""),
            # How many notes of each source link to it in "Seen in".
            "counts": {kind: len(set(re.findall(rf"\[\[{re.escape(s['folder'])}/([^\]|#]+)", text)))
                       for kind, s in SOURCES.items()},
        })
    return entries


def concept_line(entry):
    aka = f" (aka {', '.join(entry['aliases'])})" if entry["aliases"] else ""
    # The first source is always counted ("0 videos"), as before there were others; the others once they have one.
    counts = [f"{n} {s['one'] if n == 1 else s['many']}" for kind, s in SOURCES.items()
              if (n := entry["counts"][kind]) or kind == FIRST_SOURCE]
    return (f"- [[concepts/{entry['name']}|{entry['name']}]]{aka} · "
            f"{entry['summary'] or 'no summary'} · " + " · ".join(counts))


def video_line(fm, path, source):
    # The spoiler is what "Ask the brain" goes by to decide which notes to open.
    spoiler = read_spoiler(path)
    return (f"- [[{source['folder']}/{path.stem}|{link_label(fm.get('title') or path.stem)}]] · "
            f"{fm.get('channel', '?')} · {fm.get('verdict', '?')} · {fm.get('captured', '?')}"
            f"{f' · {spoiler}' if spoiler else ''}")


def post_line(fm, path, source):
    gist = read_spoiler(path)
    return (f"- [[{source['folder']}/{path.stem}|{link_label(plain(fm.get('author') or path.stem))} ({source['platform']})]] · "
            f"{fm.get('verdict', '?')} · {fm.get('action', '?')} · {fm.get('captured', '?')}"
            f"{f' · {gist}' if gist else ''}")


CATALOG_LINES = {"video": video_line, "post": post_line}  # by note format (sources.py)


def write_catalog():
    concepts = concept_entries()
    newest = lambda folder: sorted(((read_frontmatter(p), p) for p in folder.glob("*.md")),
                                   key=lambda item: item[0].get("captured", ""), reverse=True)
    lines = [CATALOG_HEADER, f"\n## Concepts ({len(concepts)})\n"]
    lines += [concept_line(e) + "\n" for e in concepts] or ["None yet.\n"]
    for kind, source in SOURCES.items():
        notes = newest(NOTE_DIRS[kind])
        # The first source's section is always there; the others from their first note, so a
        # vault with only videos keeps the catalog it had.
        if notes or kind == FIRST_SOURCE:
            line = CATALOG_LINES[source["format"]]
            lines.append(f"\n## {source['title']} ({len(notes)})\n")
            lines += [line(fm, p, source) + "\n" for fm, p in notes] or ["None yet.\n"]
    write_text(CATALOG, "".join(lines))


def rank_concepts(entries, video_text, limit):
    """Keep the concepts whose distinctive words the video uses most (IDF x log TF)."""
    words = [set(WORD_RE.findall(concept_line(e).lower())) - STOPWORDS for e in entries]
    df = Counter(w for ws in words for w in ws)
    tf = Counter(WORD_RE.findall(video_text.lower()))
    n = len(entries)

    def score(ws):
        return sum(math.log(n / df[w]) * math.log1p(tf[w]) for w in ws if tf[w])

    ranked = sorted(zip(entries, words), key=lambda pair: score(pair[1]), reverse=True)
    return sorted((e for e, _ in ranked[:limit]), key=lambda e: e["name"].lower())


def catalog_for_prompt(video_text):
    entries = concept_entries()
    if not entries:
        return "(empty: this is the first note, so every concept is new)"
    limit = CFG["catalog_limit"]
    if len(entries) <= limit:
        return f"All {len(entries)} concepts in the vault:\n" + "\n".join(map(concept_line, entries))
    shown = rank_concepts(entries, video_text, limit)
    return (f"The vault has {len(entries)} concepts. Showing the {limit} that share the most words with this "
            f"video; the full list is in _catalog.md.\n" + "\n".join(map(concept_line, shown)))


# ---------------------------------------------------------------- fetching

def fetch_metadata(video_id):
    url = f"https://www.youtube.com/watch?v={video_id}"
    meta = {"title": None, "channel": None, "published": "", "duration": "",
            "duration_s": 0, "chapters": [], "description": ""}
    # PATH first, then this venv's Scripts folder (requirements.txt installs it there)
    ytdlp = shutil.which("yt-dlp") or shutil.which("yt-dlp", path=str(Path(sys.executable).parent))
    if ytdlp:
        try:
            out = subprocess.run(
                [ytdlp, "--dump-single-json", "--skip-download", "--no-warnings",
                 "--no-playlist", url],
                capture_output=True, timeout=90, encoding="utf-8", errors="replace",
            )
            if out.returncode == 0 and out.stdout.strip():
                d = json.loads(out.stdout)
                up = d.get("upload_date") or ""
                meta.update(
                    title=d.get("title"),
                    channel=d.get("channel") or d.get("uploader"),
                    published=f"{up[:4]}-{up[4:6]}-{up[6:]}" if len(up) == 8 else "",
                    duration_s=int(d.get("duration") or 0),
                    chapters=d.get("chapters") or [],
                    description=(d.get("description") or "")[:4000],
                )
        except Exception as e:  # yt-dlp is a nice-to-have, oEmbed is the fallback
            log(f"yt-dlp metadata failed: {e}")
    if not meta["title"]:
        oembed = ("https://www.youtube.com/oembed?format=json&url="
                  + urllib.parse.quote(url, safe=""))
        with urllib.request.urlopen(oembed, timeout=20) as r:
            d = json.load(r)
        meta.update(title=d.get("title"), channel=d.get("author_name"))
    if meta["duration_s"]:
        meta["duration"] = fmt_ts(meta["duration_s"])
    return meta


def fetch_transcript(video_id, languages, block_seconds=20):
    api = YouTubeTranscriptApi()
    tlist = api.list(video_id)
    transcript = None
    for finder in (tlist.find_manually_created_transcript, tlist.find_generated_transcript):
        try:
            transcript = finder(languages)
            break
        except Exception:
            continue
    if transcript is None:
        transcript = next(iter(tlist), None)
    if transcript is None:
        raise RuntimeError("This video has no transcript/captions available.")

    fetched = transcript.fetch()
    kind = f"{fetched.language} ({'auto-generated' if fetched.is_generated else 'manual'})"

    lines, block_start, block_text = [], None, []
    for snip in fetched.snippets:
        text = snip.text.replace("\n", " ").strip()
        if not text:
            continue
        if block_start is None:
            block_start = snip.start
        block_text.append(text)
        if snip.start + snip.duration - block_start >= block_seconds:
            lines.append(f"[{fmt_ts(block_start)}] {' '.join(block_text)}")
            block_start, block_text = None, []
    if block_text:
        lines.append(f"[{fmt_ts(block_start)}] {' '.join(block_text)}")
    return "\n".join(lines), kind


# ---------------------------------------------------------------- prompt

WEB_RULE_ON = """Use WebSearch at most twice, on the one or two claims that matter most and that you're least sure of.
A claim that turns out to be contested or outdated gets a ⚠ flag in step 4, with its source inline. Claims that hold get no annotation, but they count toward `trust`.
Don't add claims, examples or concept content from search results. Don't list the search results under "Sources" either: that section is for what the video itself cites."""

WEB_RULE_OFF = """Don't search the web. In step 4, flag with ⚠ only the claims you know to be contested or outdated."""

REPROCESS_NOTE = """This video was processed before, and its note is being written again from scratch. In each concept note that already has a "Seen in" entry for this video, replace that entry instead of adding a second one."""


def note_budget(duration_s):
    """(claims, words) allowed in a video note: about a minute of reading, scaled to the video."""
    minutes = max(1.0, duration_s / 60)
    return min(8, max(3, round(3 + minutes / 8))), min(400, round(120 + 6 * minutes))


def visible_words(text):
    """Words a reader sees: frontmatter, link targets, bare URLs and timestamps don't count."""
    body = split_frontmatter(text)[1].split(ORIGINAL_HEADING)[0]  # a post's own text is not the note
    body = re.sub(r"\]\([^)]*\)", "]", body)
    body = re.sub(r"https?://\S+", "", body)  # a post's Links section: the eye skips the address
    body = re.sub(r"\[\[[^\]|]*\|", "", body)
    body = re.sub(r"\[[\d:\u2013-]+\]", "", body)
    return len(re.findall(r"\w+", body))


def short_title(meta):
    return link_label(f"{meta['channel'] or 'YouTube'}: {meta['title'] or ''}")


def build_prompt(job, meta, transcript, transcript_kind, note_path):
    template = (ROOT / "prompt.md").read_text(encoding="utf-8")
    schema = (SCHEMA if SCHEMA.exists() else ROOT / "schema.md").read_text(encoding="utf-8")
    chapters = "\n".join(f"[{fmt_ts(c.get('start_time', 0))}] {c.get('title', '')}"
                         for c in meta["chapters"]) or "(none)"
    focus = job.get("focus", "").strip()
    focus_block = (f"**My focus for this video:** {focus}\nPrioritise it in the claims and the verdict."
                   if focus else "")
    captured = date.today().isoformat()
    catalog = catalog_for_prompt(f"{meta['title']}\n{chapters}\n{transcript}")
    # Placeholders are replaced in order: fixed values first, untrusted text (notes,
    # description, transcript) last, so nothing inside them gets expanded.
    subs = [
        ("{{web_rule}}", WEB_RULE_ON if CFG["web_check"] else WEB_RULE_OFF),
        ("{{focus}}", focus_block),
        ("{{reprocess}}", REPROCESS_NOTE if job["reprocess"] else ""),
        ("{{max_claims}}", str(job["max_claims"])),
        ("{{max_words}}", str(job["max_words"])),
        ("{{note_path}}", rel(note_path)),
        ("{{seen_in_heading}}", f"### [[videos/{note_path.stem}|{short_title(meta)}]] · {captured}"),
        ("{{language}}", CFG["language"]),
        ("{{title_yaml}}", yaml_str(meta["title"])),
        ("{{channel_yaml}}", yaml_str(meta["channel"])),
        ("{{title}}", meta["title"] or ""),
        ("{{channel}}", meta["channel"] or ""),
        ("{{url}}", f"https://www.youtube.com/watch?v={job['video_id']}"),
        ("{{video_id}}", job["video_id"]),
        ("{{published}}", meta["published"] or "unknown"),
        ("{{duration}}", meta["duration"] or "unknown"),
        ("{{captured}}", captured),
        ("{{transcript_kind}}", transcript_kind),
        ("{{schema}}", schema),
        ("{{catalog}}", catalog),
        ("{{chapters}}", chapters),
        ("{{description}}", meta["description"] or "(none)"),
        ("{{transcript}}", transcript),
    ]
    for key, value in subs:
        template = template.replace(key, value)
    return template


POST_WEB_RULE_ON = """Use WebSearch at most once, and only if the post states a fact or a number that matters and that you doubt. Opinions, advice and personal stories need no search, and neither does a noise post.
A claim that turns out to be contested or outdated gets a ⚠ flag in step 4, with its source inline. Claims that hold get no annotation, but they count toward `trust`.
Don't add claims or concept content from search results, and don't list the search results under "Links": that section is for what the post itself links to."""

POST_REPROCESS_NOTE = """This post was processed before, and its note is being written again from scratch. In each concept note that already has a "Seen in" entry for this post, replace that entry instead of adding a second one."""

POST_ACTIONS = {"saved": "saved", "manual": "sent to my brain", "repost": "reposted"}
POST_MEDIA = {"article", "carousel", "document", "image", "video", "poll", "event"}
MAX_POST_IMAGES = 10  # a document's pages are pictures too


def post_budget(words, article=False, images=0):
    """(claims, words) allowed in a post note: under half a minute of reading, scaled to the post.
    An article is read like a video of the same reading time (230 words a minute); a picture or
    a document page counts as some text, since a screenshot or a slide often holds the content."""
    words += 40 * images
    if article:
        return note_budget(words / 230 * 60)
    claims = 1 if words < 80 else 2 if words < 250 else 3
    return claims, 80 + 25 * claims


def post_words(post):
    return len(re.findall(r"\w+", f"{post['text']} {post['shared_text']}"))


def plain(text):
    """Text for a file name or a link label: without the characters Obsidian's Markdown acts on
    (%% opens a comment, <b> is HTML, *_`~$ format, # tags), and with the "bold" and "italic"
    Unicode letters LinkedIn posts use for emphasis (𝗕𝗢𝗡𝗡𝗘𝗦) turned back into plain ones."""
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", re.sub(r"[<>%*_`~$#\\]", " ", text)).strip()


def post_start(post, n=8):
    """The first words of a post: an article's title, its text, the post it shares, or what its
    first picture says (a post can be a picture alone)."""
    first = post.get("article") or post["text"] or post["shared_text"] or next((i["alt"] for i in post.get("images", []) if i["alt"]), "")
    words = plain(first).split() or ["picture"]
    return " ".join(words[:n]) + ("…" if len(words) > n else "")


def post_title(post):
    """"Author: first words of the post", for the run list, the log, file names and labels."""
    return f"{plain(post['author'])}: {post_start(post)}"


def schema_with_posts():
    """The vault's schema.md. A vault set up before posts existed has no post template:
    the default one's is added for the run (schema.md itself is yours, so it's left alone)."""
    schema = (SCHEMA if SCHEMA.exists() else ROOT / "schema.md").read_text(encoding="utf-8")
    if "## Post note" in schema:
        return schema
    section, fence = [], False
    for line in (ROOT / "schema.md").read_text(encoding="utf-8").splitlines(keepends=True):
        if line.startswith("## ") and not fence:
            if section:
                break
            if line.startswith("## Post note"):
                section.append(line)
            continue
        if section:
            fence = fence != line.startswith("```")
            section.append(line)
    return schema.rstrip() + "\n\n" + "".join(section).rstrip() + "\n"


def build_post_prompt(job, post, note_path):
    template = (ROOT / "prompt_post.md").read_text(encoding="utf-8")
    source = SOURCES[job["kind"]]
    captured = date.today().isoformat()
    action = job["action"]
    # The note's frontmatter, as the run must write it: the platform's own fields (clean_post) in the middle.
    fields = [("type", "post"), ("author", f'"{yaml_str(post["author"])}"'), *post["fields"],
              ("published", post["published"] or "unknown"), ("captured", captured), ("action", action),
              ("verdict", "pending"), ("signal", "pending"), ("tags", f"[{source['tag']}]")]
    frontmatter = "---\n" + "".join(f"{key}: {value}\n" for key, value in fields) + "---"
    kept = [f"{s['label']}s" for s in SOURCES.values()]
    media = ", ".join(post["media"]) or "none"
    if post["truncated"]:
        media += f"; the text is cut short: {source['platform']} showed only its start"
    images = "\n".join(f"{n}. {path}" + (f" (the page says it shows: {alt})" if alt else "")
                       for n, (path, alt) in enumerate(job.get("image_files", []), 1)) or "(none)"
    seen_label = f"{plain(post['author'])} ({source['platform']}): {post_start(post)}"
    shared = (f"by {post['shared_author'] or 'unknown'}:\n{post['shared_text']}" if post["shared_text"] else "(none)")
    links = "\n".join(f"- {l['text'] or 'link'}: {l['url']}" for l in post["links"]) or "(none)"
    catalog = catalog_for_prompt(f"{post['text']}\n{post['shared_text']}")
    # Same order as build_prompt: fixed values first, the post's own text last.
    subs = [
        ("{{web_rule}}", POST_WEB_RULE_ON if CFG["web_check"] else WEB_RULE_OFF),
        ("{{reprocess}}", POST_REPROCESS_NOTE if job["reprocess"] else ""),
        ("{{action_text}}", POST_ACTIONS.get(action, f"reacted to ({action})")),
        ("{{platform}}", source["platform"]),
        ("{{kept}}", ", ".join(kept[:-1]) + f" and {kept[-1]}" if len(kept) > 1 else kept[0]),
        ("{{post_words}}", str(job["post_words"])),
        ("{{max_claims}}", str(job["max_claims"])),
        ("{{max_words}}", str(job["max_words"])),
        ("{{read_time}}", "about a minute" if post.get("article") else "under 30 seconds"),
        ("{{note_path}}", rel(note_path)),
        ("{{seen_in_heading}}",
         f"### [[{source['folder']}/{note_path.stem}|{link_label(seen_label)}]] · {captured}"),
        ("{{language}}", CFG["language"]),
        ("{{url}}", post["url"]),
        ("{{published}}", post["published"] or "unknown"),
        ("{{media}}", media),
        ("{{article}}", post["article"] or "(not an article)"),
        ("{{images}}", images),
        ("{{frontmatter}}", frontmatter),
        ("{{schema}}", schema_with_posts()),
        ("{{catalog}}", catalog),
        ("{{author}}", post["author"]),
        ("{{headline}}", post["headline"] or "(none)"),
        ("{{links}}", links),
        ("{{shared}}", shared),
        ("{{text}}", post["text"] or "(no text of its own: it only shares the post below)"),
    ]
    for key, value in subs:
        template = template.replace(key, value)
    return template


# ---------------------------------------------------------------- claude

def claude_binary():
    if CFG["claude_path"]:
        return CFG["claude_path"]
    native = Path.home() / ".local" / "bin" / "claude.exe"
    if native.exists():
        return str(native)
    found = shutil.which("claude")
    if not found:
        raise RuntimeError("Claude Code CLI not found. Set claude_path in config.json.")
    return found


def claude_env():
    # Always run on the Claude Code subscription login, never a custom endpoint:
    # drop gateway variables here, and skip the user settings that could set them
    # (--setting-sources below).
    env = dict(os.environ)
    for key in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"):
        env.pop(key, None)
    return env


def run_claude(prompt, model, read_dirs=()):
    # Transcripts and posts are untrusted text, so a run gets only the tools prompt.md uses: no
    # Bash, no WebFetch, no other built-in tools, and (--strict-mcp-config) no MCP servers,
    # not even the claude.ai connectors (Drive, Docs) that load with user settings skipped.
    # Read/Grep/Glob are deliberately not pre-approved: inside the vault (the cwd) they
    # need no approval, and outside it they are denied in -p mode. acceptEdits likewise
    # only auto-approves writes inside the vault.
    tools = "Read,Edit,Write,Glob,Grep" + (",WebSearch" if CFG["web_check"] else "")
    cmd = [claude_binary(), "-p", "--output-format", "json", "--setting-sources", "project,local",
           "--tools", tools, "--strict-mcp-config", "--permission-mode", "acceptEdits"]
    if CFG["web_check"]:
        cmd += ["--allowedTools", "WebSearch"]
    if model:
        cmd += ["--model", model]
    for folder in read_dirs:  # a post's pictures, downloaded for this run (fetch_images)
        cmd += ["--add-dir", str(folder)]
    proc = subprocess.run(
        cmd, input=prompt.encode("utf-8"), cwd=VAULT, env=claude_env(), capture_output=True,
        timeout=CFG["timeout_minutes"] * 60,
    )
    stdout = proc.stdout.decode("utf-8", errors="replace")
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError:
        err = proc.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"claude exited {proc.returncode}: {(err or stdout)[-800:]}")
    if result.get("is_error"):
        raise RuntimeError(f"claude error: {str(result.get('result'))[-800:]}")
    return result


# ---------------------------------------------------------------- after a run

TS_RE = re.compile(r"\[@(\d{1,2}(?::\d{2}){1,2})(?:\s*[-–]\s*(\d{1,2}(?::\d{2}){1,2}))?\]")


def link_timestamps(path, video_id):
    """Turn [@mm:ss] / [@mm:ss-mm:ss] markers into clickable YouTube links."""
    with path.open(encoding="utf-8", newline="") as f:  # keep the note's line endings
        text = f.read()

    def repl(m):
        start, end = m.group(1), m.group(2)
        label = f"{start}–{end}" if end else start
        return f"[{label}](https://www.youtube.com/watch?v={video_id}&t={ts_to_seconds(start)}s)"

    new = TS_RE.sub(repl, text)
    if new != text:
        write_text(path, new)


ORIGINAL_HEADING = "\n## Original post\n"


def quote_post_text(text):
    """A post's text, inert inside a callout: no HTML, wikilinks, comments or tags of its own."""
    text = text.replace("<", "&lt;").replace("[[", "\\[\\[").replace("%%", "%\\%")
    text = re.sub(r"(?<!\w)#(?=\w)", r"\\#", text)  # #AI would become an Obsidian tag
    return "\n".join(f"> {line}".rstrip() for line in text.splitlines())


def add_original(path, post, job):
    """Append the post as it was captured: posts get edited and deleted. Written here,
    not by Claude, so it's the exact text and costs no output tokens."""
    with path.open(encoding="utf-8", newline="") as f:
        text = f.read()
    text = text.split(ORIGINAL_HEADING)[0].rstrip("\n")  # a run that wrote one anyway
    published = post["published"]
    parts = [f"> [!quote]- {plain(post['author'])}{f' · {published}' if published else ''} · "
             f"{job['action']} {date.today().isoformat()}"]
    if post.get("article"):
        parts.append(f"> **{quote_post_text(post['article'].replace('*', ''))[2:]}**")  # an X article's title
    if post["text"]:
        parts.append(quote_post_text(post["text"]))
    if post["shared_text"]:
        parts += [">", f"> **Shared post by {post['shared_author'] or 'unknown'}:**",
                  quote_post_text(post["shared_text"])]
    read = job.get("images_read", 0)
    if post["media"] or post.get("images"):
        seen = f"{read} picture{'' if read == 1 else 's'} read" if read else "not read"
        parts += [">", f"> *Attached: {', '.join(post['media']) or 'picture'} ({seen}).*"]
    if post["truncated"]:
        parts += [">", f"> *{SOURCES[job['kind']]['platform']} showed only the start of this post: open it for the rest.*"]
    write_text(path, text + "\n" + ORIGINAL_HEADING + "\n".join(parts) + "\n")


def read_spoiler(path):
    """First lines of the note's tldr callout, used as the notification text.
    (claude's own stdout is unreliable on Windows: it mangles non-ASCII.)"""
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^> \[!tldr\][^\n]*\n((?:>[^\n]*\n?)+)", text, re.MULTILINE)
    if not m:
        return ""
    return " ".join(line.lstrip("> ").strip() for line in m.group(1).splitlines())[:300]


def snapshot():
    """Text of every note, so a run's changes can be diffed afterwards."""
    notes = {}
    for p in VAULT.rglob("*.md"):
        if p in SERVER_FILES or any(part.startswith(".") for part in p.relative_to(VAULT).parts):
            continue
        notes[p] = p.read_text(encoding="utf-8", errors="replace")
    return notes


def kind_of(path):
    """A source's key (sources.py) for a note in its folder, "concept", or "other"."""
    folder = path.relative_to(VAULT).parts[0]
    return KIND_OF_FOLDER.get(folder) or ("concept" if folder == "concepts" else "other")


def line_delta(old, new):
    added = removed = 0
    matcher = difflib.SequenceMatcher(None, old.splitlines(), new.splitlines(), autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return added, removed


def describe_change(path, old, new):
    fm = parse_frontmatter(new)
    item = {"path": rel(path), "kind": kind_of(path), "name": path.stem, "uri": obsidian_uri(rel(path))}
    if item["kind"] == "concept":
        item["summary"] = fm.get("summary", "")
    if old is not None:
        # Body lines and frontmatter fields are reported apart: bumping `updated:`
        # is expected, rewording existing text is not.
        item["added"], item["removed"] = line_delta(split_frontmatter(old)[1], split_frontmatter(new)[1])
        old_fm = parse_frontmatter(old)
        item["fields"] = sorted(k for k in set(fm) | set(old_fm) if fm.get(k) != old_fm.get(k))
    return item


def collect_changes(before, after):
    order = {"concept": 1, "other": 2}  # a source's note first
    ordered = sorted(after, key=lambda p: (order.get(kind_of(p), 0), p.stem.lower()))
    return {
        "created": [describe_change(p, None, after[p]) for p in ordered if p not in before],
        "updated": [describe_change(p, before[p], after[p]) for p in ordered
                    if p in before and before[p] != after[p]],
        "deleted": [rel(p) for p in sorted(before) if p not in after],
    }


VERDICTS = {kind: tuple(source["verdicts"]) for kind, source in SOURCES.items()}


def check_run(note_path, changes, max_words, reprocess, kind="video"):
    """Consistency checks against schema.md. Problems are reported, not fixed."""
    if not note_path.exists():
        return [f"The {kind} note {rel(note_path)} wasn't written."]
    warnings = []
    note_rel = rel(note_path)
    text = note_path.read_text(encoding="utf-8")
    fm = parse_frontmatter(text)
    if PENDING in text.split(ORIGINAL_HEADING)[0]:
        warnings.append(f"{note_rel}: some sections were left unfinished.")
    if fm.get("verdict") not in VERDICTS[kind]:
        *rest, last = VERDICTS[kind]
        warnings.append(f"{note_rel}: verdict is '{fm.get('verdict')}', expected {', '.join(rest)} or {last}.")
    words = visible_words(text)
    if words > max_words * 1.25:
        warnings.append(f"{note_rel}: {words} words, well over its {max_words}-word budget.")

    backlink = f"[[{note_path.parent.name}/{note_path.stem}|"
    for name in sorted(set(re.findall(r"\[\[concepts/([^\]|#]+)", text))):
        concept = CONCEPTS / f"{name}.md"
        if not concept.exists():
            warnings.append(f"{note_rel} links to concepts/{name}, which doesn't exist.")
        elif backlink not in concept.read_text(encoding="utf-8"):
            warnings.append(f"concepts/{name}.md has no 'Seen in' entry for this {kind}.")

    for item in changes["created"] + changes["updated"]:
        if item["kind"] == "concept":
            cfm = read_frontmatter(VAULT / item["path"])
            if cfm.get("type") != "concept" or not cfm.get("summary"):
                warnings.append(f"{item['path']}: missing `type: concept` or `summary`, so the catalog can't list it.")
            if item.get("removed") and not reprocess:  # a re-run replaces its own old entry
                warnings.append(f"{item['path']}: {item['removed']} existing line(s) were removed or reworded.")
        elif item["kind"] == "other":
            folders = ", ".join(f"{s['folder']}/" for s in SOURCES.values())
            warnings.append(f"Changed a file outside {folders} and concepts/: {item['path']}")
    warnings += [f"Deleted {path}" for path in changes["deleted"]]
    return warnings


def finish_run(note_path, before, job):
    """Deterministic bookkeeping after Claude's run, whether it succeeded or not."""
    if job.get("video_id"):
        for p, text in snapshot().items():
            if before.get(p) != text:
                link_timestamps(p, job["video_id"])
    changes = collect_changes(before, snapshot())
    warnings = check_run(note_path, changes, job["max_words"], job["reprocess"], job.get("kind", "video"))
    write_catalog()
    return changes, warnings


def append_log(job, status):
    note = job.get("note")
    label = link_label(job.get("title") or job_ref(job))
    target = f"[[{note[:-3]}|{label}]]" if note and (VAULT / note).exists() else label
    lines = [f"## {datetime.now():%Y-%m-%d %H:%M} · {target} · {job.get('verdict') or status}"]
    changes = job.get("changes") or {"created": [], "updated": []}
    new = [c for c in changes["created"] if c["kind"] == "concept"]
    updated = [c for c in changes["updated"] if c["kind"] == "concept"]
    if new:
        lines.append("- New concepts: " + ", ".join(f"[[concepts/{c['name']}|{c['name']}]]" for c in new))
    if updated:
        lines.append("- Updated concepts: " + ", ".join(
            f"[[concepts/{c['name']}|{c['name']}]] (+{c['added']})" for c in updated))
    if status == "failed":
        lines.append(f"- Failed: {job.get('error')}")
    lines += [f"- ⚠ {w}" for w in job.get("warnings") or []]
    entry = "\n".join(lines) + "\n\n"
    text = LOG.read_text(encoding="utf-8") if LOG.exists() else LOG_HEADER
    i = text.find("\n## ")
    write_text(LOG, text + entry if i == -1 else text[:i + 1] + entry + text[i + 1:])


# ---------------------------------------------------------------- git sync

def git(*args):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")  # never hang waiting for a password
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    return subprocess.run(["git", *args], cwd=VAULT, env=env, capture_output=True,
                          encoding="utf-8", errors="replace", timeout=120)


def git_sync(message):
    """Commit local changes, rebase onto GitHub, push. Returns a problem to report, or None.
    Never forces anything: on a conflict it backs off and leaves the commits local."""
    if not (CFG["git_sync"] and (VAULT / ".git").exists()):
        return None
    def commit(msg):
        git("add", "-A")
        if git("diff", "--cached", "--quiet").returncode:
            r = git("commit", "-q", "-m", f"{msg} [{MACHINE}]")
            if r.returncode:
                return f"git commit failed: {r.stderr.strip()[-300:]}"
        return None

    with GIT_LOCK:
        try:
            problem = commit(message)
            if problem:
                return problem
            if not git("remote").stdout.strip():
                return None  # local history only, no GitHub repo yet
            branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
            remote = git("ls-remote", "--exit-code", "--heads", "origin", branch)
            if remote.returncode not in (0, 2):  # 2 = branch not on GitHub yet
                return f"GitHub unreachable, changes kept locally: {remote.stderr.strip()[-200:]}"
            if remote.returncode == 0:
                r = git("pull", "--rebase", "-q", "origin", branch)
                if r.returncode:
                    git("rebase", "--abort")
                    return ("git pull hit a conflict (the same note edited on two devices); "
                            f"nothing pushed until it's resolved: {r.stderr.strip()[-200:]}")
                if LOG.exists():  # vault is set up: other machines may have added concepts
                    write_catalog()
                    problem = commit("Rebuild catalog")
                    if problem:
                        return problem
            r = git("push", "-q", "-u", "origin", branch)
            return f"git push failed: {r.stderr.strip()[-300:]}" if r.returncode else None
        except (OSError, subprocess.TimeoutExpired) as e:
            return f"git sync failed: {e}"


def periodic_sync():
    """Bring in edits from other devices (and push this PC's) while no video is running."""
    while True:
        time.sleep(CFG["git_sync_minutes"] * 60)
        if JOB_QUEUE.unfinished_tasks == 0:
            problem = git_sync("Sync edits")
            if problem:
                log(problem)


# ---------------------------------------------------------------- worker

def record(job):
    changes = job.get("changes") or {}
    keep = {k: job.get(k) for k in ("id", "kind", "video_id", "post_id", "action", "title", "status", "verdict",
                                    "note", "error", "warnings", "note_words", "cost_usd", "seconds", "focus",
                                    "images_read", "created")}
    keep["created_notes"] = [c["path"] for c in changes.get("created", [])]
    keep["updated_notes"] = [c["path"] for c in changes.get("updated", [])]
    with (DATA / "captures.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(keep, ensure_ascii=False) + "\n")


def write_note(job, note_path, prompt, model, started, after_write=None, read_dirs=()):
    """Run Claude to write note_path (from scratch when re-processing), then the bookkeeping.
    after_write() runs once the note exists, before the changes are collected."""
    job.update(note=rel(note_path), status="analyzing")
    before = snapshot()
    if job["reprocess"]:
        note_path.unlink()  # write it again from the source, not from the old note
    written = False
    try:
        result = run_claude(prompt, model, read_dirs)
    finally:
        written = note_path.exists()
        if job["reprocess"] and not written:
            write_text(note_path, before[note_path])  # the run produced nothing: keep the old note
        elif written and after_write:
            after_write()
        job["changes"], job["warnings"] = finish_run(note_path, before, job)
    if not written:
        raise RuntimeError(f"Claude finished without writing {job['note']}.")

    job.update(
        obsidian_uri=obsidian_uri(job["note"]),
        verdict=read_frontmatter(note_path).get("verdict"),
        summary=read_spoiler(note_path),
        note_words=visible_words(note_path.read_text(encoding="utf-8")),
        cost_usd=result.get("total_cost_usd"),
        seconds=round(time.time() - started),
    )
    counts = {k: len(v) for k, v in job["changes"].items()}
    log(f"{job_ref(job)}: done in {job['seconds']}s, verdict={job['verdict']}, "
        f"{job['note_words']}/{job['max_words']} words, {counts}, "
        f"{len(job['warnings'])} warning(s)")


def process_video(job):
    vid = job["video_id"]
    started = time.time()

    job["status"] = "transcript"
    meta = fetch_metadata(vid)
    job["title"] = meta["title"]
    transcript, kind = fetch_transcript(vid, CFG["transcript_languages"])
    log(f"{vid}: '{meta['title']}' / {len(transcript):,} chars of transcript ({kind})")

    problem = git_sync("Sync edits")  # start from the latest notes from every device
    if problem:
        log(problem)
    existing = find_existing_note(vid)
    note_path = existing or new_note_path(meta["title"], vid)
    marks = re.findall(r"^\[([\d:]+)\]", transcript, re.MULTILINE)
    duration_s = meta["duration_s"] or (ts_to_seconds(marks[-1]) if marks else 600)
    job["max_claims"], job["max_words"] = note_budget(duration_s)
    job["reprocess"] = existing is not None
    write_note(job, note_path, build_prompt(job, meta, transcript, kind, note_path), CFG["model"], started)


IMAGE_HOSTS = {"pbs.twimg.com": "/media/", "media.licdn.com": "/dms/image/"}  # where post pictures may come from
IMAGE_TYPES = {b"\xff\xd8\xff": ".jpg", b"\x89PNG": ".png", b"GIF8": ".gif"}
# Claude refuses a picture over 5 MB once base64-encoded (raw bytes x 4/3) or over 8000 px on a
# side, and that fails the whole run: such a picture is skipped instead. The extension asks for
# ~1200 px versions, usually 100-300 KB, so these are only a safety net.
MAX_IMAGE_BYTES = 5 * 1024 * 1024 * 3 // 4
MAX_IMAGE_SIDE = 8000


def image_size(data):
    """(width, height) read from a JPG, PNG, GIF or WebP header, or None when it can't be read."""
    try:
        if data.startswith(b"\x89PNG") and data[12:16] == b"IHDR":
            return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        if data.startswith(b"GIF8"):
            return int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8X":
                return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
            if chunk == b"VP8L":
                bits = int.from_bytes(data[21:25], "little")
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            if chunk == b"VP8 ":
                return int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF
            return None
        if data.startswith(b"\xff\xd8"):
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    return None
                marker = data[i + 1]
                if marker == 0xFF:  # fill byte
                    i += 1
                    continue
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:  # markers with no length
                    i += 2
                    continue
                length = int.from_bytes(data[i + 2:i + 4], "big")
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):  # start of frame
                    return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
                i += 2 + length
    except (IndexError, ValueError):
        pass
    return None


def image_url_ok(url):
    u = urllib.parse.urlparse(url)
    return u.scheme == "https" and u.hostname in IMAGE_HOSTS and u.path.startswith(IMAGE_HOSTS[u.hostname])


def fetch_images(job, post):
    """Download a post's pictures into data/attachments/<job>/, outside the vault, so the run can
    Read them (run_claude's --add-dir) and they never end up in the notes or in git. Only from
    the platforms' own image servers (clean_post), only real images Claude accepts (under
    MAX_IMAGE_BYTES, both sides at most MAX_IMAGE_SIDE, size readable). A picture
    that fails is skipped: the post is still written from its text. Returns the folder."""
    folder = DATA / "attachments" / job["id"]
    files = []
    for n, image in enumerate(post["images"], 1):
        try:
            req = urllib.request.Request(image["url"], headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                if not image_url_ok(r.geturl()):  # a redirect elsewhere
                    raise ValueError(f"redirected to {urllib.parse.urlparse(r.geturl()).hostname}")
                data = r.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError(f"over {MAX_IMAGE_BYTES / 1024 / 1024:.2f} MB")
            ext = next((e for magic, e in IMAGE_TYPES.items() if data.startswith(magic)), None)
            if not ext and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
                ext = ".webp"
            if not ext:
                raise ValueError("not a picture")
            size = image_size(data)
            if not size or not all(size):
                raise ValueError("its size can't be read")
            if max(size) > MAX_IMAGE_SIDE:
                raise ValueError(f"{size[0]}x{size[1]} px, over {MAX_IMAGE_SIDE} px")
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / f"{n}{ext}"
            path.write_bytes(data)
            files.append((str(path), image["alt"]))
        except Exception as e:
            log(f"{job['kind']} {post['key']}: picture {n} skipped ({e})")
    job["image_files"] = files
    job["images_read"] = len(files)
    return folder


def process_post(job):
    """A note in the post format, for any source that has it (LinkedIn, X…)."""
    post = POST_TEXTS.pop(job["id"])
    folder = NOTE_DIRS[job["kind"]]
    started = time.time()
    log(f"{job['kind']} {post['key']}: '{job['title']}' ({job['action']}, {len(post['images'])} picture(s))")
    problem = git_sync("Sync edits")  # start from the latest notes from every device
    if problem:
        log(problem)
    existing = find_existing_note(post["key"], folder, "post_id")
    note_path = existing or new_note_path(f"{plain(post['author'])} - {post_start(post, 10).rstrip('…')}", post["key"], folder)
    attachments = fetch_images(job, post) if post["images"] else None
    try:
        job["post_words"] = post_words(post)
        job["max_claims"], job["max_words"] = post_budget(job["post_words"], bool(post["article"]), job.get("images_read", 0))
        job["reprocess"] = existing is not None
        write_note(job, note_path, build_post_prompt(job, post, note_path), CFG["post_model"], started,
                   after_write=lambda: add_original(note_path, post, job),
                   read_dirs=[attachments] if job.get("image_files") else [])
    finally:
        job.pop("image_files", None)  # local paths: not for /jobs
        if attachments:
            shutil.rmtree(attachments, ignore_errors=True)


def commit_message(job, status):
    title = job.get("title") or job_ref(job)
    if status == "failed":
        return f"Failed run: {title}"
    return f"{'Re-process' if job.get('reprocess') else 'Add'}: {title} ({job.get('verdict') or '?'})"


def finish_job(job, status, error=None):
    """Log the run, sync it to GitHub, then publish the final status to the extension."""
    job["error"] = error
    try:
        append_log(job, status)
    except OSError as e:
        log(f"could not write _log.md: {e}")
    problem = git_sync(commit_message(job, status))
    if problem:
        log(problem)
        job.setdefault("warnings", []).append(problem)
    job["status"] = status  # last, so the extension never sees a half-finished job
    record(job)


def worker():
    while True:
        job = JOB_QUEUE.get()
        try:
            fmt = SOURCES.get(job.get("kind"), {}).get("format", "video")
            (process_post if fmt == "post" else process_video)(job)
            finish_job(job, "done")
        except Exception as e:
            log(f"{job_ref(job)}: FAILED {e}")
            traceback.print_exc()
            finish_job(job, "failed", str(e))
        finally:
            JOB_QUEUE.task_done()


# ---------------------------------------------------------------- ask the brain

ASK_PROMPT = ROOT / "ask.md"  # how questions are answered (edit freely, read on every question)
ASK_LOG = DATA / "asks.jsonl"  # every answer, so it can be read again without asking again
ASK_SLOTS = threading.BoundedSemaphore(2)  # a double click shouldn't start a third paid run
ASK_TIMEOUT_SECONDS = 300  # an answer takes 15-60 s; a stuck one shouldn't hold a slot for long
ASK_HINTS = 8  # keyword matches listed with the question, next to the catalog
ASK_THREAD_TURNS = 3  # earlier exchanges a follow-up question carries
ASK_THREAD_CHARS = 4000  # of each earlier answer


class PageGone(Exception):
    """The page that asked closed or stopped the question."""


def kill_tree(proc):
    """Stop a process and its children: on Windows, claude is a .cmd wrapper around node,
    and killing only the wrapper would leave Claude running."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.kill()
    proc.wait()


def ask_command(system_file):
    # Sonnet explores the vault itself, read-only: Read, Grep and Glob, which -p mode only
    # allows inside the cwd (the vault). No writing, no Bash, no web, and no MCP servers, not
    # even the claude.ai connectors: the notes come from transcripts and are untrusted.
    cmd = [claude_binary(), "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
           "--setting-sources", "project,local", "--system-prompt-file", str(system_file),
           "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--no-session-persistence",
           "--max-turns", str(CFG["ask_max_turns"])]
    if CFG["ask_model"]:
        cmd += ["--model", CFG["ask_model"]]
    return cmd


def vault_path(path):
    """A tool's file path, as the vault-relative note id ("videos/X.md") when it's inside the vault."""
    try:
        return Path(path).resolve().relative_to(VAULT.resolve()).as_posix()
    except (OSError, ValueError):
        return str(path)


def ask_thread(parent_id):
    """The saved exchanges a follow-up continues, oldest first (the last ASK_THREAD_TURNS)."""
    by_id = {e.get("id"): e for e in read_asks(limit=None)}
    chain = []
    while parent_id in by_id and len(chain) < ASK_THREAD_TURNS:
        chain.append(by_id[parent_id])
        parent_id = by_id[parent_id].get("parent")
    return chain[::-1]


def thread_block(thread):
    """The earlier questions and answers, so "the second video" or "and in practice?" make sense."""
    if not thread:
        return ""
    out = ["# Conversation so far\n\nThis question follows up on the exchange below.\n"]
    for i, e in enumerate(thread, 1):
        answer = e.get("answer") or ""
        if len(answer) > ASK_THREAD_CHARS:
            answer = answer[:ASK_THREAD_CHARS] + "…"
        out.append(f"\n## Earlier question {i}\n\n{e.get('question', '')}\n\n## Your answer {i}\n\n{answer}\n\n"
                   f"Notes you read for it: {', '.join(e.get('read') or []) or 'none'}\n")
    return "".join(out) + "\n"


def ask_brain(question, emit, page_closed, parent=None):
    """Answer a question from the notes, streaming events to emit(dict) as Claude works.
    `parent` is the id of the saved answer this question follows up on, if any.
    Raises PageGone, with Claude stopped, as soon as page_closed() says the asker left."""
    snap = INDEX.get()
    if not CATALOG.exists():
        write_catalog()
    thread = ask_thread(parent) if parent else []
    # A follow-up like "and the second one?" has few words of its own: rank with the last question too.
    about = f"{thread[-1]['question']} {question}" if thread else question
    hints = sorted(snap.relevance(about).items(), key=lambda item: -item[1])[:ASK_HINTS]
    emit({"type": "start", "model": CFG["ask_model"], "notes": {kind: snap.count(kind) for kind in SOURCES},
          "concepts": len(snap.concepts)})
    started = time.time()
    # The catalog is the system prompt: the same for every question until a run rebuilds it,
    # so Claude caches it and questions asked within a few minutes of each other pay a fraction for it.
    system_file = DATA / f"ask-{uuid.uuid4().hex[:8]}.md"
    write_text(system_file, ASK_PROMPT.read_text(encoding="utf-8").rstrip() + "\n\n# The catalog (_catalog.md)\n\n"
               + CATALOG.read_text(encoding="utf-8", errors="replace"))
    hint_block = ("# Keyword matches\n\nNotes whose words match the question best (a hint: the catalog may point "
                  "elsewhere):\n" + "".join(f"- {note}\n" for note, _ in hints) + "\n") if hints else ""
    result, other, read = None, [], []
    try:
        proc = subprocess.Popen(ask_command(system_file), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, cwd=VAULT, env=claude_env())
    except OSError:
        system_file.unlink(missing_ok=True)
        raise
    timer = threading.Timer(ASK_TIMEOUT_SECONDS, kill_tree, [proc])
    timer.start()
    left = threading.Event()

    def feed():  # in its own thread, like communicate(), so a chatty start can't deadlock the pipes
        try:
            proc.stdin.write(f"{thread_block(thread)}{hint_block}# Question\n\n{question}\n".encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass

    def watch():  # nothing is written while Claude thinks, so Stop is noticed here, not on the next write
        while proc.poll() is None:
            if page_closed():
                left.set()
                kill_tree(proc)
                return
            time.sleep(0.5)

    threading.Thread(target=feed, daemon=True).start()
    threading.Thread(target=watch, daemon=True).start()
    try:
        for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                if line:
                    other.append(line)
                continue
            if event.get("type") == "result":
                result = event
            elif event.get("type") == "assistant":  # a finished step: say which notes it opens
                for block in (event.get("message") or {}).get("content") or []:
                    if block.get("type") != "tool_use":
                        continue
                    args = block.get("input") or {}
                    target = vault_path(args["file_path"]) if args.get("file_path") else args.get("pattern", "")
                    if block.get("name") == "Read":
                        read.append(target)
                    emit({"type": "tool", "tool": block.get("name"), "target": target})
            elif event.get("type") == "stream_event":
                e = event.get("event") or {}
                if e.get("type") == "message_start":  # a new step: text from the last one was thinking aloud
                    emit({"type": "step"})
                elif e.get("type") == "content_block_start" and (e.get("content_block") or {}).get("type") == "thinking":
                    emit({"type": "status", "text": "Thinking…"})
                elif e.get("type") == "content_block_delta" and (e.get("delta") or {}).get("type") == "text_delta":
                    emit({"type": "delta", "text": e["delta"]["text"]})
        proc.wait()
    finally:
        timer.cancel()
        kill_tree(proc)  # still running only if the page went away, or the timeout hit
        system_file.unlink(missing_ok=True)
    if left.is_set():
        raise PageGone
    if result and result.get("subtype") == "error_max_turns":
        raise RuntimeError(f"Claude read for {CFG['ask_max_turns']} steps without finishing an answer. Ask something "
                           "narrower, or raise ask_max_turns in server/config.json.")
    if not result or result.get("is_error"):
        reason = (result or {}).get("result") or " ".join(other)[-400:] or f"claude exited {proc.returncode}"
        raise RuntimeError(f"Claude couldn't answer: {reason}")

    answer = result.get("result") or ""
    usage = result.get("usage") or {}
    tokens = sum(usage.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    entry = {"id": uuid.uuid4().hex[:12], "time": datetime.now().isoformat(timespec="seconds"),
             "question": question, "parent": parent, "answer": answer, "refs": cited(answer, snap.note_refs()),
             "read": list(dict.fromkeys(read)), "steps": result.get("num_turns"), "model": CFG["ask_model"],
             "cost_usd": result.get("total_cost_usd"), "seconds": round(time.time() - started, 1),
             "tokens_in": tokens, "tokens_cached": usage.get("cache_read_input_tokens") or 0,
             "tokens_out": usage.get("output_tokens") or 0}
    with ASK_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    log(f"ask: {question[:60]!r} answered in {entry['seconds']}s, {entry['steps']} steps, "
        f"{len(entry['read'])} notes read, {tokens:,} tokens in ({entry['tokens_cached']:,} from cache), "
        f"{entry['tokens_out']:,} out, ${entry['cost_usd'] or 0:.3f}")
    emit({"type": "done", **entry})


def read_asks(limit=100):
    """Earlier answers, newest first (all of them with limit=None)."""
    if not ASK_LOG.exists():
        return []
    entries = []
    for line in ASK_LOG.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries[::-1][:limit]


# ---------------------------------------------------------------- http

WEB = ROOT / "web"  # the dashboard, graph and search pages, served at http://127.0.0.1:<port>/
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}
# The pages show note text that came from transcripts, so scripts only ever come from this server.
CSP = ("default-src 'self'; img-src 'self' data: https://i.ytimg.com; style-src 'self' 'unsafe-inline'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
LOCAL_HOSTS = {f"127.0.0.1:{CFG['port']}", f"localhost:{CFG['port']}"}
LOCAL_ORIGINS = {f"http://{host}" for host in LOCAL_HOSTS}
INDEX = BrainIndex(VAULT, DATA / "captures.jsonl", obsidian_uri)


class Server(ThreadingHTTPServer):
    # Python enables SO_REUSEADDR by default, which on Windows lets a second server
    # bind the same port and silently steal requests. One server per port.
    allow_reuse_address = os.name != "nt"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _origin_ok(self):
        # Only requests addressed to this computer: otherwise a web page could point its
        # own domain at 127.0.0.1 (DNS rebinding) and read the notes through /api/.
        if self.headers.get("Host") not in LOCAL_HOSTS:
            return False
        # Browsers always send Origin on cross-site POSTs, so this blocks random
        # web pages from queueing jobs. Local tools (curl) send no Origin.
        origin = self.headers.get("Origin")
        if origin is None or origin in LOCAL_ORIGINS:
            return True
        # The extension popup only needs /health, /jobs and /capture. /api/ (every note, and
        # paid questions) is for this server's own pages, not for any installed extension.
        return origin.startswith("chrome-extension://") and not self.path.startswith("/api/")

    def _send(self, code, payload):
        self._send_bytes(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                         "application/json; charset=utf-8")

    def _send_bytes(self, code, body, content_type, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        if content_type.startswith("text/html"):
            self.send_header("Content-Security-Policy", CSP)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        origin = self.headers.get("Origin")
        if origin and origin.startswith("chrome-extension://") and not self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.end_headers()
        self.wfile.write(body)

    def _page_closed(self):
        """True once the browser has closed this request's connection (a stopped fetch)."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and not self.connection.recv(1, socket.MSG_PEEK)
        except OSError:
            return True

    def _api(self, path, params):
        """The web app's read-only endpoints. False when the path isn't one of them."""
        arg = lambda key: params.get(key, [""])[0]
        if path == "/api/brain":
            # The page polls this; an unchanged vault answers 304 with no body.
            version, body = INDEX.overview_json()
            etag = f'"{version}"'
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
            else:
                self._send_bytes(200, body, "application/json; charset=utf-8", {"ETag": etag})
        elif path == "/api/search":
            self._send(200, INDEX.get().search(arg("q")[:500], complete=arg("complete") == "1"))
        elif path == "/api/note":
            note = INDEX.get().note(arg("path"), VAULT)
            self._send(*((200, note) if note else (404, {"error": "No such note."})))
        elif path == "/api/asks":
            self._send(200, {"asks": read_asks(), "model": CFG["ask_model"]})
        else:
            return False
        return True

    def _ask(self, body):
        """POST /api/ask: the answer streams back as one JSON event per line."""
        question = str(body.get("question") or "").strip()[:1000]
        if not question:
            return self._send(400, {"error": "Type a question first."})
        parent = str(body.get("parent") or "")[:40] or None
        if parent and not ask_thread(parent):
            return self._send(400, {"error": "The answer this follows up on isn't saved anymore."})
        if not ASK_SLOTS.acquire(blocking=False):
            return self._send(429, {"error": "Two questions are already being answered. Wait for one to finish."})
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            def emit(event):
                try:
                    self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
                except OSError as e:
                    raise PageGone from e

            try:
                ask_brain(question, emit, self._page_closed, parent)
            except PageGone:
                log("ask: the page stopped the question, so Claude was stopped too.")
            except Exception as e:
                log(f"ask failed: {e}")
                try:
                    emit({"type": "error", "message": str(e)})
                except PageGone:
                    pass
        finally:
            ASK_SLOTS.release()

    def do_OPTIONS(self):
        if not self._origin_ok():
            return self._send(403, {"error": "forbidden origin"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if not self._origin_ok():
            return self._send(403, {"error": "forbidden origin"})
        u = urllib.parse.urlparse(self.path)
        if u.path == "/health":
            return self._send(200, {"ok": True, "vault": CFG["vault_name"], "queued": JOB_QUEUE.qsize(),
                                    # "videos": 37, "posts": 10, … one count per source
                                    **{s["many"]: len(list(NOTE_DIRS[k].glob("*.md"))) for k, s in SOURCES.items()},
                                    "concepts": len(list(CONCEPTS.glob("*.md")))})
        if u.path == "/jobs":
            ids = urllib.parse.parse_qs(u.query).get("ids", [""])[0].split(",")
            return self._send(200, {"jobs": [JOBS[i] for i in ids if i in JOBS]})
        if u.path.startswith("/api/"):
            try:
                if self._api(u.path, urllib.parse.parse_qs(u.query)):
                    return
            except Exception as e:  # a note the parser chokes on shouldn't take the page down
                log(f"{u.path} failed: {e}")
                traceback.print_exc()
                return self._send(500, {"error": str(e)})
        name = u.path.lstrip("/") or "index.html"
        if re.fullmatch(r"[\w-]+\.\w+", name) and Path(name).suffix in STATIC_TYPES and (WEB / name).is_file():
            return self._send_bytes(200, (WEB / name).read_bytes(), STATIC_TYPES[Path(name).suffix])
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._origin_ok():
            return self._send(403, {"error": "forbidden origin"})
        if self.path not in ("/capture", "/api/ask"):
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._send(400, {"error": "invalid JSON"})
        if not isinstance(body, dict):
            return self._send(400, {"error": "expected a JSON object"})
        if self.path == "/api/ask":
            return self._ask(body)
        if body.get("kind") == "post":
            return self._capture_post(body)

        vid = parse_video_id(str(body.get("url", "")))
        if not vid:
            return self._send(400, {"error": "Not a YouTube video URL."})

        for job in JOBS.values():
            if job["video_id"] == vid and job["status"] in ("queued", "transcript", "analyzing"):
                return self._send(200, job)

        if not body.get("force"):
            existing = find_existing_note(vid)
            if existing:
                fm = read_frontmatter(existing)
                return self._send(200, {
                    "id": None, "video_id": vid, "status": "exists", "note": rel(existing),
                    "obsidian_uri": obsidian_uri(rel(existing)),
                    "title": fm.get("title"), "verdict": fm.get("verdict"),
                })

        job = {
            "id": uuid.uuid4().hex[:12], "video_id": vid, "status": "queued",
            "title": str(body.get("title") or "")[:200] or None,
            "focus": str(body.get("focus") or "")[:1000],
            "created": datetime.now().isoformat(timespec="seconds"),
        }
        JOBS[job["id"]] = job
        JOB_QUEUE.put(job)
        log(f"{vid}: queued ({job['title']})")
        self._send(202, job)

    def _capture_post(self, body):
        """POST /capture with kind=post: a post the extension read from the page. `source` says
        which source it is (sources.py: "post" for LinkedIn, "xpost" for X), any in the post format."""
        kind = str(body.get("source") or "post")
        if SOURCES.get(kind, {}).get("format") != "post":
            return self._send(400, {"error": f"Not a kind of post this server knows: {kind[:40]}."})
        post = clean_post(body.get("post"), kind)
        if not post:
            return self._send(400, {"error": f"Couldn't read this post's text. Reload the {SOURCES[kind]['platform']} tab and try again."})
        key = post["key"]  # a post's identity on its platform
        for job in JOBS.values():
            if job.get("kind") == kind and job.get("post_id") == key and job["status"] in ("queued", "transcript", "analyzing"):
                return self._send(200, job)
        if not body.get("force"):
            existing = find_existing_note(key, NOTE_DIRS[kind], "post_id")
            if existing:
                fm = read_frontmatter(existing)
                return self._send(200, {
                    "id": None, "kind": kind, "post_id": key, "status": "exists", "note": rel(existing),
                    "obsidian_uri": obsidian_uri(rel(existing)), "title": post_title(post), "verdict": fm.get("verdict"),
                })
        action = str(body.get("action") or "").lower()
        job = {
            "id": uuid.uuid4().hex[:12], "kind": kind, "post_id": key, "status": "queued",
            "title": post_title(post)[:200], "action": action if re.fullmatch(r"[a-z]{2,20}", action) else "manual",
            "created": datetime.now().isoformat(timespec="seconds"),
        }
        POST_TEXTS[job["id"]] = post
        JOBS[job["id"]] = job
        JOB_QUEUE.put(job)
        log(f"{kind} {key}: queued ({job['title']}, {job['action']})")
        self._send(202, job)


def line(value, limit):
    """A name or a headline from a page: one line, bounded."""
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


# What differs between platforms in the post format: how a post is known, where it lives, when it
# was published, and the frontmatter fields only that platform has. One function per source.

def linkedin_identity(raw):
    # LinkedIn's current layout often shows only the post's key (SHA-256 of its id), not the id.
    # With the id, the key is computed here, so a post is the same note whichever was on the page.
    urn = parse_post_urn(str(raw.get("urn") or ""))
    key = post_key(urn) if urn else str(raw.get("key") or "")
    if not POST_KEY_RE.fullmatch(key):
        return None
    author_url = str(raw.get("author_url") or "")
    if not PROFILE_URL_RE.fullmatch(author_url):
        author_url = ""
    # The post's own page when its id is known; otherwise its author's profile, where it's listed.
    url = f"https://www.linkedin.com/feed/update/{urn}/" if urn else author_url
    headline = line(raw.get("headline"), 220)
    return {"key": key, "url": url, "headline": headline,
            "published": urn_date(urn) if urn else when_date(line(raw.get("when"), 60)),
            "fields": [("headline", f'"{yaml_str(headline)}"'), ("url", url), ("post_id", key), ("urn", urn or "")]}


def x_identity(raw):
    status = str(raw.get("id") or "")
    handle = str(raw.get("handle") or "").lstrip("@")
    if not (X_ID_RE.fullmatch(status) and X_HANDLE_RE.fullmatch(handle)):
        return None
    url = f"https://x.com/{handle}/status/{status}"
    return {"key": status, "url": url, "headline": f"@{handle}", "published": x_date(status),
            # Quoted: YAML doesn't allow a bare value to start with "@" (the handle is only
            # letters, digits and "_", so nothing in it needs escaping).
            "fields": [("handle", f'"@{handle}"'), ("url", url), ("post_id", status)]}


POST_IDENTITIES = {"post": linkedin_identity, "xpost": x_identity}  # by source key (sources.py)


def clean_post(raw, kind="post"):
    """The post the extension sent, checked and trimmed, or None if it has no id or no text.
    It comes from a web page, so every field is bounded and links must be http(s)."""
    if not isinstance(raw, dict) or kind not in POST_IDENTITIES:
        return None
    identity = POST_IDENTITIES[kind](raw)
    if not identity:
        return None
    shared = raw.get("shared") if isinstance(raw.get("shared"), dict) else {}

    def text(value, limit):  # a post's text: keep its line breaks, drop the runs of blank lines
        value = re.sub(r"[ \t ]+", " ", str(value or "").replace("\r", ""))
        return re.sub(r"\n\s*\n\s*\n+", "\n\n", re.sub(r" *\n *", "\n", value)).strip()[:limit]

    links = []
    for item in raw.get("links") if isinstance(raw.get("links"), list) else []:
        url = str(item.get("url") or "") if isinstance(item, dict) else ""
        if re.match(r"https?://[^\s<>\"]+$", url) and len(url) <= 2000 and url not in (l["url"] for l in links):
            links.append({"text": line(item.get("text"), 150), "url": url})
        if len(links) == 15:
            break
    media = raw.get("media") if isinstance(raw.get("media"), list) else []
    images = []
    for item in raw.get("images") if isinstance(raw.get("images"), list) else []:
        url = str(item.get("url") or "") if isinstance(item, dict) else ""
        if image_url_ok(url) and len(url) <= 2000 and re.fullmatch(r"[^\s<>\"]+", url) and url not in (i["url"] for i in images):
            images.append({"url": url, "alt": line(item.get("alt"), 500)})
        if len(images) == MAX_POST_IMAGES:
            break
    article = raw.get("article") if isinstance(raw.get("article"), dict) else {}
    post = {
        "kind": kind,
        **identity,  # key, url, published, headline, and the platform's own frontmatter fields
        "author": line(raw.get("author"), 120) or "Unknown author",
        # An X article runs to thousands of words: it gets more room than a post.
        "text": text(raw.get("text"), 80000 if article else 15000),
        "article": line(article.get("title"), 300),  # an X article's title, "" for a post
        "truncated": raw.get("truncated") is True,  # the page showed only the start of the text
        "shared_author": line(shared.get("author"), 120),
        "shared_text": text(shared.get("text"), 15000),
        "links": links,
        "media": sorted({m for m in media if m in POST_MEDIA}),
        "images": images,  # the post's pictures and document pages, downloaded for the run
    }
    return post if post["text"] or post["shared_text"] or post["images"] else None


def main():
    if not VAULT.is_dir():
        raise SystemExit(f"Vault not found: {VAULT}. Edit server/config.json.")
    bootstrap_vault()
    problem = git_sync("Sync edits")
    log(problem or ("git sync: up to date" if (VAULT / ".git").exists() else "git sync: vault is not a git repo"))
    threading.Thread(target=worker, daemon=True).start()
    if CFG["git_sync"] and (VAULT / ".git").exists():
        threading.Thread(target=periodic_sync, daemon=True).start()
    try:
        server = Server(("127.0.0.1", CFG["port"]), Handler)
    except OSError:
        raise SystemExit(f"Port {CFG['port']} is taken: a Feed Brain server is probably already running. "
                         "Close its window first.")
    # Pictures left by a run that was cut short (the server closed mid-run). Only once the port is
    # ours, so a second copy started by mistake never deletes a running server's pictures.
    shutil.rmtree(DATA / "attachments", ignore_errors=True)
    log(f"Feed Brain listening on http://127.0.0.1:{CFG['port']}")
    log(f"vault: {VAULT}  model: {CFG['model']} (posts: {CFG['post_model']})  web check: {CFG['web_check']}")
    log(f"dashboard, graph and search: http://127.0.0.1:{CFG['port']}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
