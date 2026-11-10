"""brain_server.py helpers that need no Claude and no network: timestamp links, the catalog, the
vault's git rules, the checks after a run, and how a post from LinkedIn or X is cleaned."""

import re
from datetime import date, datetime, timedelta

import pytest

from vaultkit import concept, days_ago, post, video, write

VID = "LPZh9BOjkQs"


# ---------------------------------------------------------------- timestamp links

def test_link_timestamps(server, tmp_path):
    note = write(tmp_path / "note.md", "- **A claim.** [@01:10]\r\n- **Ranged.** [@1:02:03-1:05:00]\r\n"
                                       "- **En dash.** [@03:28–07:10]\r\n- Already linked [04:00](https://x)\r\n")
    server.link_timestamps(note, VID)
    text = note.read_bytes().decode("utf-8")
    assert text == (f"- **A claim.** [01:10](https://www.youtube.com/watch?v={VID}&t=70s)\r\n"
                    f"- **Ranged.** [1:02:03–1:05:00](https://www.youtube.com/watch?v={VID}&t=3723s)\r\n"
                    f"- **En dash.** [03:28–07:10](https://www.youtube.com/watch?v={VID}&t=208s)\r\n"
                    "- Already linked [04:00](https://x)\r\n")  # line endings kept


def test_link_timestamps_leaves_an_unmarked_note_alone(server, tmp_path):
    note = write(tmp_path / "note.md", "No markers here, just [01:10] and [@notatime].\n")
    before = note.stat().st_mtime_ns
    server.link_timestamps(note, VID)
    assert note.read_text(encoding="utf-8") == "No markers here, just [01:10] and [@notatime].\n"
    assert note.stat().st_mtime_ns == before


@pytest.mark.parametrize("seconds, label", [(0, "00:00"), (70, "01:10"), (3723, "1:02:03")])
def test_fmt_ts_round_trips(server, seconds, label):
    assert server.fmt_ts(seconds) == label
    assert server.ts_to_seconds(label) == seconds


# ---------------------------------------------------------------- names and labels

@pytest.mark.parametrize("title, name", [
    ('What "AI" can’t do: a/b test?', "What AI can't do a b test"),
    ("  ...  ", "untitled"),
    ("#tag [x] ^y|z", "tag x y z"),
    ("x" * 150, "x" * 100),
])
def test_safe_filename(server, title, name):
    assert server.safe_filename(title) == name


def test_link_label(server):
    assert server.link_label("a [b] | c#d") == "a b c d"
    long = server.link_label("word " * 30)
    assert long.endswith("…") and len(long) <= 71


def test_parse_video_id(server):
    for url in (f"https://www.youtube.com/watch?v={VID}&t=5s", f"https://youtu.be/{VID}",
                f"https://www.youtube.com/shorts/{VID}", f"https://m.youtube.com/live/{VID}?feature=x"):
        assert server.parse_video_id(url) == VID
    for url in ("https://www.youtube.com/watch?v=short", "https://evil.com/watch?v=" + VID, "not a url"):
        assert server.parse_video_id(url) is None


# ---------------------------------------------------------------- catalog

def test_catalog_of_an_empty_vault(server):
    server.write_catalog()
    text = server.CATALOG.read_text(encoding="utf-8")
    assert text.startswith(server.CATALOG_HEADER)
    assert "\n## Concepts (0)\nNone yet.\n" in text
    assert "\n## Videos (0)\nNone yet.\n" in text
    assert "LinkedIn posts" not in text and "X posts" not in text  # a source's section appears with its first note


def test_catalog_lists_every_note(server):
    v = server.VAULT
    video(v, "Old video", title="An old video", channel="Chan A", verdict="skip", signal=2, captured="2025-01-01",
          tags=["misc"], claims=["**A claim.**"], spoiler="Old news.")
    video(v, "New video", title="A new video", channel="Chan B", verdict="watch", signal=5, captured="2026-06-01",
          tags=["misc"], claims=["**A claim.**"], spoiler="Fresh news.", concepts=["Topic"])
    post(v, "First post", author="Sample Author", verdict="keep", signal=3, captured="2026-05-01", tags=["misc"],
         gist="A post about the topic.", concepts=["Topic"])
    concept(v, "Topic", aliases=["Subject"], summary="What it's about.",
            seen=[("videos/New video", "Chan B: A new video", []), ("posts/First post", "Sample Author", [])])
    concept(v, "Alone", summary="")
    server.write_catalog()
    text = server.CATALOG.read_text(encoding="utf-8")
    assert "## Concepts (2)" in text
    assert "- [[concepts/Alone|Alone]] · no summary · 0 videos\n" in text
    assert "- [[concepts/Topic|Topic]] (aka Subject) · What it's about. · 1 video · 1 post\n" in text
    videos = text.split("## Videos (2)\n")[1].split("\n\n")[0].splitlines()
    assert videos == ["- [[videos/New video|A new video]] · Chan B · watch · 2026-06-01 · Fresh news.",
                      "- [[videos/Old video|An old video]] · Chan A · skip · 2025-01-01 · Old news."]  # newest first
    assert ("## LinkedIn posts (1)\n- [[posts/First post|Sample Author (LinkedIn)]] · keep · saved · 2026-05-01 · "
            "A post about the topic.\n") in text
    assert "X posts" not in text


def test_catalog_for_prompt(server, monkeypatch):
    assert server.catalog_for_prompt("anything").startswith("(empty")
    concept(server.VAULT, "Sourdough", summary="Bread leavened by wild yeast.")
    concept(server.VAULT, "Router", summary="A box that forwards network packets.")
    assert server.catalog_for_prompt("x").startswith("All 2 concepts in the vault:")
    monkeypatch.setitem(server.CFG, "catalog_limit", 1)
    shown = server.catalog_for_prompt("my router drops packets, the router reboots")
    assert shown.startswith("The vault has 2 concepts. Showing the 1")
    assert "concepts/Router" in shown and "Sourdough" not in shown


# ---------------------------------------------------------------- the vault's git rules

def test_git_files_for_a_new_vault(server):
    server.ensure_vault_git_files()
    attributes = (server.VAULT / ".gitattributes").read_text(encoding="utf-8")
    lines = attributes.splitlines()
    assert "_log.md merge=union" in lines and "_catalog.md merge=union" in lines
    assert attributes.startswith("#")
    ignore = (server.VAULT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert {".obsidian/workspace*.json", ".trash/", ".obsidian/plugins/*/data.json"} <= set(ignore)


@pytest.mark.parametrize("existing", ["", "*.png binary\n", "*.png binary\n\n", "*.png binary\n_log.md merge=union",
                                      "_log.md merge=union\n"])
def test_git_files_keep_what_is_there(server, existing):
    path = write(server.VAULT / ".gitattributes", existing)
    before = path.read_text(encoding="utf-8")
    server.ensure_vault_git_files()
    after = path.read_text(encoding="utf-8")
    assert after.startswith(before)
    assert after.count("_log.md merge=union") == 1 and after.count("_catalog.md merge=union") == 1
    assert after.endswith("_catalog.md merge=union\n")
    assert "\n\n\n" not in after or existing.endswith("\n\n")  # a blank line already there is kept


def test_partial_file_without_final_newline(server):
    path = write(server.VAULT / ".gitattributes", "*.png binary")
    server.ensure_vault_git_files()
    assert path.read_text(encoding="utf-8").startswith("*.png binary\n\n# ")


def test_git_files_that_already_have_the_rules_are_left_alone(server):
    attributes = write(server.VAULT / ".gitattributes", "  _catalog.md merge=union  \n_log.md merge=union\n")
    ignore = write(server.VAULT / ".gitignore", ".obsidian/workspace*.json\n.trash/\n.obsidian/plugins/*/data.json\n")
    server.ensure_vault_git_files()
    server.ensure_vault_git_files()
    assert attributes.read_text(encoding="utf-8") == "  _catalog.md merge=union  \n_log.md merge=union\n"
    assert ignore.read_text(encoding="utf-8") == ".obsidian/workspace*.json\n.trash/\n.obsidian/plugins/*/data.json\n"


def test_git_files_are_idempotent(server):
    server.ensure_vault_git_files()
    first = (server.VAULT / ".gitattributes").read_text(encoding="utf-8")
    server.ensure_vault_git_files()
    assert (server.VAULT / ".gitattributes").read_text(encoding="utf-8") == first


# ---------------------------------------------------------------- run log

def test_append_log_puts_the_newest_entry_first(server):
    job = {"title": "First video", "verdict": "watch", "changes": None, "warnings": []}
    server.append_log(job, "done")
    server.append_log({"title": "Second [video]", "error": "boom", "warnings": ["A warning."]}, "failed")
    text = server.LOG.read_text(encoding="utf-8")
    assert text.startswith(server.LOG_HEADER)
    second, first = text[len(server.LOG_HEADER):].split("\n\n")[:2]
    assert re.fullmatch(r"## \d{4}-\d\d-\d\d \d\d:\d\d · Second video · failed\n- Failed: boom\n- ⚠ A warning\.", second)
    assert first.endswith(" · First video · watch")


# ---------------------------------------------------------------- checks after a run

def good_video(vault, name="Good", **kw):
    fields = dict(title="A good video", channel="Chan", verdict="watch", signal=4, captured=days_ago(0),
                  tags=["misc"], claims=["**One claim.** [@01:00]"], concepts=["Topic"], spoiler="Short.")
    return video(vault, name, **(fields | kw))


def topic(vault, seen_in="videos/Good", **kw):
    return concept(vault, "Topic", **({"summary": "A topic.", "seen": [(seen_in, "Chan: A good video", ["x"])]} | kw))


def run(server, write_notes, max_words=200, reprocess=False, kind="video", note="videos/Good.md"):
    """Snapshot, let write_notes() play Claude's part, then the server's checks."""
    before = server.snapshot()
    write_notes(server.VAULT)
    changes = server.collect_changes(before, server.snapshot())
    return changes, server.check_run(server.VAULT / note, changes, max_words, reprocess, kind)


def test_a_clean_run_has_no_warnings(server):
    changes, warnings = run(server, lambda v: (good_video(v), topic(v)))
    assert warnings == []
    assert [c["path"] for c in changes["created"]] == ["videos/Good.md", "concepts/Topic.md"]  # the note first


def test_missing_note(server):
    _, warnings = run(server, lambda v: None)
    assert warnings == ["The video note videos/Good.md wasn't written."]


def test_unfinished_wrong_verdict_and_too_long(server):
    def write_notes(v):
        path = good_video(v, verdict="maybe", claims=["**Claim.** " + "word " * 300])
        path.write_text(path.read_text(encoding="utf-8") + "\n%% pending %%\n", encoding="utf-8")
        topic(v)
    _, warnings = run(server, write_notes)
    assert "videos/Good.md: some sections were left unfinished." in warnings
    assert "videos/Good.md: verdict is 'maybe', expected watch, skim or skip." in warnings
    assert any(re.fullmatch(r"videos/Good\.md: \d+ words, well over its 200-word budget\.", w) for w in warnings)


def test_post_verdicts_are_its_own(server):
    def write_notes(v):
        post(v, "P", author="A", verdict="watch", signal=3, captured=days_ago(0), tags=["x"], gist="Gist.",
             original="%% pending %% in the post's own text is the post's business")
    _, warnings = run(server, write_notes, kind="post", note="posts/P.md")
    assert warnings == ["posts/P.md: verdict is 'watch', expected keep or noise."]


def test_concept_links_are_checked(server):
    def write_notes(v):
        good_video(v, concepts=["Topic", "Nowhere"])
        topic(v, seen_in="videos/Something else")
    _, warnings = run(server, write_notes)
    assert "videos/Good.md links to concepts/Nowhere, which doesn't exist." in warnings
    assert "concepts/Topic.md has no 'Seen in' entry for this video." in warnings


def test_concept_without_summary_and_reworded_lines(server):
    topic(server.VAULT, definition="Line one.\nLine two.")
    def write_notes(v):
        good_video(v)
        topic(v, summary="", definition="Something else entirely.")
    _, warnings = run(server, write_notes)
    assert "concepts/Topic.md: missing `type: concept` or `summary`, so the catalog can't list it." in warnings
    assert any(re.fullmatch(r"concepts/Topic\.md: \d+ existing line\(s\) were removed or reworded\.", w)
               for w in warnings)
    _, warnings = run(server, lambda v: topic(v, summary="", definition="Third version."), reprocess=True)
    assert not any("reworded" in w for w in warnings)  # a re-run replaces its own entry


def test_files_outside_the_note_folders_and_deletions(server):
    write(server.VAULT / "concepts" / "Old.md", "---\ntype: concept\nsummary: x\n---\n")
    def write_notes(v):
        good_video(v)
        topic(v)
        write(v / "notes" / "stray.md", "Claude wrote this somewhere else.\n")
        (v / "concepts" / "Old.md").unlink()
    _, warnings = run(server, write_notes)
    assert warnings == ["Changed a file outside videos/, posts/, xposts/ and concepts/: notes/stray.md",
                        "Deleted concepts/Old.md"]


def test_server_files_and_dot_folders_are_not_changes(server):
    def write_notes(v):
        good_video(v)
        topic(v)
        server.write_catalog()
        write(v / ".obsidian" / "workspace.md", "x")
    changes, warnings = run(server, write_notes)
    assert warnings == [] and len(changes["created"]) == 2


def test_finish_run_links_timestamps_and_rebuilds_the_catalog(server):
    before = server.snapshot()
    good_video(server.VAULT, video_id=VID)
    topic(server.VAULT)
    job = {"video_id": VID, "max_words": 200, "reprocess": False, "kind": "video"}
    changes, warnings = server.finish_run(server.VAULT / "videos" / "Good.md", before, job)
    assert warnings == [] and len(changes["created"]) == 2
    assert f"[01:00](https://www.youtube.com/watch?v={VID}&t=60s)" in (server.VAULT / "videos" / "Good.md").read_text(
        encoding="utf-8")
    assert "[[videos/Good|A good video]]" in server.CATALOG.read_text(encoding="utf-8")


def test_visible_words_skip_links_and_the_original_post(server):
    text = ("---\ntitle: x\n---\nOne two [three](https://example.com/a/b/c) [[concepts/Long name|four]] "
            "https://example.com/five [01:10]\n\n## Original post\n> six seven eight\n")
    assert server.visible_words(text) == 4


# ---------------------------------------------------------------- posts: identity

URN_ID = "7212345678901234567"
URN = f"urn:li:activity:{URN_ID}"


def test_parse_post_urn(server):
    assert server.parse_post_urn(URN) == URN
    assert server.parse_post_urn(f"https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A{URN_ID}/") == \
        f"urn:li:ugcPost:{URN_ID}"
    assert server.parse_post_urn(f"https://www.linkedin.com/posts/someone_slug-activity-{URN_ID}-abcd") == URN
    assert server.parse_post_urn("urn:li:activity:123") is None
    assert server.parse_post_urn(None) is None


def test_dates_from_ids(server):
    assert server.urn_date(URN) == datetime.fromtimestamp((int(URN_ID) >> 22) / 1000).date().isoformat()
    assert server.urn_date(URN).startswith("2024-")
    assert server.urn_date("urn:li:activity:999999999999999999999") == ""  # in the future
    assert server.urn_date("urn:li:activity:notanumber") == ""
    assert server.x_date("1790000000000000000").startswith("2024-")
    assert server.x_date("9" * 22) == ""  # in the future
    assert server.x_date("abc") == ""


@pytest.mark.parametrize("shown, days", [("3 h", 0), ("45 min", 0), ("1 j", 1), ("2 sem.", 14), ("5 mo", 150),
                                          ("1 an", 365), ("2d", 2), ("3w", 21), ("1yr", 365)])
def test_when_date_relative(server, shown, days):
    assert server.when_date(shown) == (date.today() - timedelta(days=days)).isoformat()


def test_when_date_absolute(server):
    assert server.when_date("3 mars 2025") == "2025-03-03"
    assert server.when_date("Oct 25, 2024") == "2024-10-25"
    assert server.when_date("25 déc. 2023") == "2023-12-25"
    no_year = server.when_date("25 oct.")
    assert no_year[5:] == "10-25" and no_year <= date.today().isoformat()
    assert server.when_date("31 feb 2024") == ""
    assert server.when_date("someday") == ""
    assert server.when_date("") == ""


def test_post_key(server):
    key = server.post_key(URN)
    assert len(key) == 43 and server.POST_KEY_RE.fullmatch(key)
    assert key == server.post_key(URN) != server.post_key(f"urn:li:activity:{int(URN_ID) + 1}")


def test_linkedin_identity_from_the_id(server):
    who = server.linkedin_identity({"urn": URN, "headline": "  Builds   things\n", "key": "ignored"})
    assert who["key"] == server.post_key(URN)
    assert who["url"] == f"https://www.linkedin.com/feed/update/{URN}/"
    assert who["published"] == server.urn_date(URN)
    assert who["headline"] == "Builds things"
    assert dict(who["fields"]) == {"headline": '"Builds things"', "url": who["url"], "post_id": who["key"],
                                   "urn": URN}


def test_linkedin_identity_from_the_key(server):
    key = server.post_key(URN)
    who = server.linkedin_identity({"key": key, "author_url": "https://www.linkedin.com/in/sample-author",
                                    "when": "2 sem."})
    assert who["key"] == key and who["url"] == "https://www.linkedin.com/in/sample-author"
    assert who["published"] == (date.today() - timedelta(days=14)).isoformat()
    assert dict(who["fields"])["urn"] == ""
    assert server.linkedin_identity({"key": key, "author_url": "https://evil.example/in/x"})["url"] == ""
    assert server.linkedin_identity({"key": key, "author_url": "https://www.linkedin.com/in/x?y=1"})["url"] == ""


@pytest.mark.parametrize("raw", [{}, {"key": "too-short"}, {"key": "x" * 42 + "!"}, {"urn": "urn:li:activity:1"}])
def test_linkedin_identity_needs_an_id(server, raw):
    assert server.linkedin_identity(raw) is None


def test_x_identity(server):
    who = server.x_identity({"id": "1790000000000000000", "handle": "@sample_user"})
    assert who["key"] == "1790000000000000000"
    assert who["url"] == "https://x.com/sample_user/status/1790000000000000000"
    assert who["headline"] == "@sample_user" and who["published"].startswith("2024-")
    assert dict(who["fields"]) == {"handle": '"@sample_user"', "url": who["url"], "post_id": who["key"]}


@pytest.mark.parametrize("raw", [{"id": "1790000000000000000", "handle": "two words"},
                                 {"id": "1790000000000000000", "handle": "a" * 16},
                                 {"id": "17900abc", "handle": "ok"}, {"id": "", "handle": "ok"},
                                 {"id": "1790000000000000000"}])
def test_x_identity_refuses_bad_ids_and_handles(server, raw):
    assert server.x_identity(raw) is None


# ---------------------------------------------------------------- posts: cleaning

def linkedin(**kw):
    return {"urn": URN, "author": "Sample Author", "text": "Hello.", **kw}


def test_clean_post_basics(server):
    p = server.clean_post(linkedin(author="  Sample\n Author ", text="Line one  \r\n\r\n\r\n\r\n  Line\t two"))
    assert p["kind"] == "post" and p["key"] == server.post_key(URN)
    assert p["author"] == "Sample Author"
    assert p["text"] == "Line one\n\nLine two"
    assert p["links"] == [] and p["media"] == [] and p["images"] == [] and p["truncated"] is False
    assert server.clean_post(linkedin(author=""))["author"] == "Unknown author"


@pytest.mark.parametrize("raw, kind", [(None, "post"), ("text", "post"), ([], "post"), ({"urn": URN, "text": "x"}, "video"),
                                       ({"urn": URN, "text": "x"}, "nope"), ({"text": "no id"}, "post")])
def test_clean_post_refuses(server, raw, kind):
    assert server.clean_post(raw, kind) is None


def test_clean_post_needs_something_to_read(server):
    assert server.clean_post(linkedin(text="  \n ")) is None
    assert server.clean_post(linkedin(text="", shared={"author": "B", "text": "Shared text."}))["shared_text"] == \
        "Shared text."
    pic = {"url": "https://media.licdn.com/dms/image/abc/pic.jpg", "alt": "A chart"}
    assert server.clean_post(linkedin(text="", images=[pic]))["images"] == [pic]


def test_clean_post_links(server):
    links = [{"url": "javascript:alert(1)", "text": "bad"}, {"url": "https://example.com/a", "text": " A\n link "},
             {"url": "https://example.com/a", "text": "duplicate"}, {"url": "https://exa mple.com", "text": "space"},
             {"url": "ftp://example.com", "text": "ftp"}, "not a dict", {"url": "https://x.com/" + "y" * 2000}]
    links += [{"url": f"https://example.com/{n}"} for n in range(30)]
    p = server.clean_post(linkedin(links=links))
    assert p["links"][0] == {"text": "A link", "url": "https://example.com/a"}
    assert len(p["links"]) == 15
    assert all(l["url"].startswith("https://example.com/") for l in p["links"])


def test_clean_post_images_only_from_the_platforms(server):
    images = [{"url": "https://pbs.twimg.com/media/one.jpg", "alt": "one"},
              {"url": "http://pbs.twimg.com/media/two.jpg"},  # not https
              {"url": "https://pbs.twimg.com/profile_images/three.jpg"},  # not a post picture
              {"url": "https://evil.example/media/four.jpg"},
              {"url": "https://pbs.twimg.com/media/one.jpg", "alt": "duplicate"},
              {"url": "https://media.licdn.com/dms/image/five.jpg"}]
    images += [{"url": f"https://pbs.twimg.com/media/{n}.jpg"} for n in range(20)]
    p = server.clean_post({"id": "1790000000000000000", "handle": "sample_user", "text": "Pictures.", "images": images},
                          "xpost")
    assert p["images"][:2] == [{"url": "https://pbs.twimg.com/media/one.jpg", "alt": "one"},
                               {"url": "https://media.licdn.com/dms/image/five.jpg", "alt": ""}]
    assert len(p["images"]) == server.MAX_POST_IMAGES


def test_clean_post_media_truncation_and_limits(server):
    p = server.clean_post(linkedin(media=["video", "image", "malware", "video"], truncated="true",
                                   text="x" * 20000, shared="not a dict"))
    assert p["media"] == ["image", "video"]
    assert p["truncated"] is False  # only a real true counts
    assert len(p["text"]) == 15000 and p["shared_text"] == ""
    assert server.clean_post(linkedin(truncated=True))["truncated"] is True
    article = server.clean_post({"id": "1790000000000000000", "handle": "a", "text": "y" * 90000,
                                 "article": {"title": "  An   article "}}, "xpost")
    assert article["article"] == "An article" and len(article["text"]) == 80000


def test_post_title_and_budget(server):
    p = server.clean_post(linkedin(author="Sample *Author*", text="𝗕𝗢𝗟𝗗 words then " + "more " * 20))
    assert server.post_title(p) == "Sample Author: BOLD words then more more more more more…"
    assert server.post_budget(50) == (1, 105)
    assert server.post_budget(100) == (2, 130)
    assert server.post_budget(400) == (3, 155)
    assert server.post_budget(30, images=2) == (2, 130)  # a picture counts as some text
    assert server.post_budget(2300, article=True) == server.note_budget(600)
