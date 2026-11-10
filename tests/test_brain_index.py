"""brain_index.py: note parsing, the search index (BM25F, stemming, completion, typo fixes, filters),
Ask's relevance ranking and the Louvain topic clusters."""

from datetime import date, timedelta

import pytest

import brain_index as bi
from conftest import EXAMPLES
from vaultkit import concept, days_ago, post, video


def snapshot(vault):
    return bi.Snapshot(vault, vault / "no-captures.jsonl", lambda rel: f"obsidian://{rel}")


def ids(result):
    return [r["id"] for r in result["results"]]


# ---------------------------------------------------------------- a small vault with known answers

@pytest.fixture(scope="module")
def vault(tmp_path_factory):
    v = tmp_path_factory.mktemp("index") / "vault"
    video(v, "WiFi sensing", title="WiFi signals can see through walls", channel="Signal Lab",
          verdict="watch", signal=5, captured=days_ago(5), tags=["privacy", "wifi-sensing"], video_id="AAAAAAAAAAA",
          spoiler="Radio reflections from bodies let WiFi tracking locate people in another room.",
          claims=["**WiFi tracking locates people through walls using reflected signals.** [@01:10]",
                  "  - e.g. two access points found a person behind drywall.",
                  "**Consumer access points already ship the sensing firmware.** ⚠ contested: only a few models do "
                  "([source](https://example.com/firmware))"],
          concepts=["Wi-Fi sensing"], reason="Worth it for the privacy angle.")
    video(v, "Bread", title="Baking sourdough bread at home", channel="Kitchen Corner",
          verdict="skip", signal=2, captured="2025-01-10", tags=["cooking"], video_id="BBBBBBBBBBB",
          spoiler="A slow recipe for a crusty loaf.",
          claims=["**Tracking dough temperature matters more than timing.** [@02:00]"],
          concepts=["Fermentation"])
    video(v, "Attention", title="Attention explained", channel="ML Explained",
          verdict="skim", signal=4, captured=days_ago(40), tags=["deep-learning"], video_id="CCCCCCCCCCC",
          spoiler="How a transformer weighs every token against every other.",
          claims=["**Transformers replace recurrence with attention.** [@03:28-07:10] ⚠ outdated: newer models "
                  "mix recurrence back in"],
          concepts=["Transformer"])
    post(v, "Routers as motion sensors", author="Sample Author", verdict="keep", signal=3, captured=days_ago(2),
         tags=["privacy"], gist="Home routers can sense motion using WiFi.", concepts=["Wi-Fi sensing"],
         original="Text of the post that must not be indexed: zebracorn")
    concept(v, "Wi-Fi sensing", aliases=["WiFi sensing", "RF sensing"], tags=["privacy"],
            summary="Using radio reflections from WiFi to detect people and motion.",
            seen=[("videos/WiFi sensing", "Signal Lab: WiFi signals can see through walls", ["Works through walls."])])
    concept(v, "Fermentation", tags=["cooking"], summary="Yeast and bacteria turning sugar into gas and acid.",
            seen=[("videos/Bread", "Kitchen Corner: Baking sourdough bread at home", ["Temperature drives it."])])
    concept(v, "Transformer", aliases=["Transformer model"], tags=["deep-learning"],
            summary="A neural network architecture built on attention.",
            seen=[("videos/Attention", "ML Explained: Attention explained", ["Attention replaces recurrence."])])
    return v


@pytest.fixture(scope="module")
def snap(vault):
    return snapshot(vault)


WIFI, BREAD, ATTN = "videos/WiFi sensing.md", "videos/Bread.md", "videos/Attention.md"
POST = "posts/Routers as motion sensors.md"
C_WIFI, C_FERM, C_TRANS = "concepts/Wi-Fi sensing.md", "concepts/Fermentation.md", "concepts/Transformer.md"


# ---------------------------------------------------------------- words

@pytest.mark.parametrize("word, expected", [
    ("tracking", "track"), ("tracked", "track"), ("tracks", "track"), ("policies", "policy"),
    ("transformers", "transformer"), ("class", "class"), ("status", "status"), ("analysis", "analysis"),
    ("sing", "sing"), ("used", "used"), ("bus", "bus"), ("2024", "2024"), ("ties", "tie"),
])
def test_stem(word, expected):
    assert bi.stem(word) == expected


def test_fold_and_word_parts():
    assert bi.fold("Révèle ÉTÉ") == "revele ete"
    assert bi.word_parts("Wi-Fi") == ["wi", "fi", "wifi"]
    assert bi.word_parts("the") == []  # a stopword
    assert bi.word_parts("x") == []  # too short
    assert bi.terms_of("Tracking the trackers") == ["track", "tracker"]


def test_edit_distance():
    assert bi.edit_distance("kitten", "sitting", 3) == 3
    assert bi.edit_distance("same", "same", 1) == 0
    assert bi.edit_distance("abc", "xyzabc", 1) == 2  # gives up at limit + 1
    assert bi.edit_distance("transfromer", "transformer", 2) == 2


# ---------------------------------------------------------------- query syntax

def test_parse_query_full_example():
    q = bi.parse_query("wifi tracking type:claim verdict:watch,skim signal>=4 after:30d -tag:privacy")
    assert q["words"] == ["wifi", "tracking"]
    assert q["filters"] == [(False, "type", ":", "claim"), (False, "verdict", ":", "watch,skim"),
                            (False, "signal", ">=", "4"), (False, "after", ":", "30d"), (True, "tag", ":", "privacy")]
    assert q["phrases"] == [] and q["excluded"] == [] and q["sort"] is None


@pytest.mark.parametrize("text, key, expected", [
    ('"see through walls" bread', "phrases", ["see through walls"]),
    ('"see through walls" bread', "words", ["bread"]),
    ("wifi -router", "excluded", ["router"]),
    ('-"exact phrase" word', "excluded", ["exact phrase"]),
    ("signal:>=4", "filters", [(False, "signal", ">=", "4")]),
    ("signal:<3", "filters", [(False, "signal", "<", "3")]),
    ("TYPE:claim", "filters", [(False, "type", ":", "claim")]),
    ('channel:"signal lab"', "filters", [(False, "channel", ":", "signal lab")]),
    ("type: wifi", "filters", []),  # an empty value is no filter
    ("foo:bar", "words", ["foo:bar"]),  # not a filter key: a plain word
    ("-foo:bar", "excluded", ["foo:bar"]),
    ('"unclosed phrase', "phrases", ["unclosed phrase"]),
    ("sort:Signal wifi", "sort", "signal"),
])
def test_parse_query(text, key, expected):
    assert bi.parse_query(text)[key] == expected


def test_parse_when():
    today = date.today()
    assert bi.parse_when("7d") == (today - timedelta(days=7)).isoformat()
    assert bi.parse_when("2w") == (today - timedelta(days=14)).isoformat()
    assert bi.parse_when("3m") == (today - timedelta(days=90)).isoformat()
    assert bi.parse_when("1y") == (today - timedelta(days=365)).isoformat()
    assert bi.parse_when("today") == today.isoformat()
    assert bi.parse_when("Yesterday") == (today - timedelta(days=1)).isoformat()
    assert bi.parse_when("2026-10-05") == "2026-10-05"
    assert bi.parse_when("2026-10") == "2026-10-01"
    assert bi.parse_when("2026") == "2026-01-01"
    assert bi.parse_when("soon") is None


# ---------------------------------------------------------------- parsing

def test_parse_video_note(snap):
    rec = snap.notes[WIFI]
    assert rec["kind"] == "video" and rec["verdict"] == "watch" and rec["signal"] == 5
    assert rec["tags"] == ["privacy", "wifi-sensing"]  # the source's own tag is left out
    assert rec["duration_s"] == 600 and rec["trust"] == "solid"
    first, second = rec["claims"]
    assert first["text"] == "WiFi tracking locates people through walls using reflected signals."
    assert first["ts"] == {"label": "01:10", "seconds": 70,
                           "url": "https://www.youtube.com/watch?v=AAAAAAAAAAA&t=70s"}
    assert first["example"] == "two access points found a person behind drywall."
    assert second["flag"] == "contested" and second["flag_source"] == "https://example.com/firmware"
    assert second["flag_reason"] == "only a few models do"
    assert rec["concepts"] == ["Wi-Fi sensing"]
    ranged = snap.notes[ATTN]["claims"][0]
    assert ranged["ts"]["label"] == "03:28–07:10" and ranged["ts"]["seconds"] == 208
    assert ranged["flag"] == "outdated"


def test_parse_post_note_leaves_out_the_original(snap):
    rec = snap.notes[POST]
    assert rec["kind"] == "post" and rec["channel"] == "Sample Author" and rec["verdict"] == "keep"
    assert rec["url"].startswith("https://www.linkedin.com/")
    assert rec["claims"] == []  # "None." under Key claims
    assert snap.search("zebracorn")["total"] == 0  # the post's own copied text isn't the note


def test_safe_url_refuses_other_sites():
    assert bi.safe_url("javascript:alert(1)", "post") == ""
    assert bi.safe_url("https://evil.example/x", "xpost") == ""
    assert bi.safe_url("https://x.com/a/status/1", "xpost") == "https://x.com/a/status/1"
    assert bi.safe_url('https://x.com/a"onmouseover=1', "xpost") == ""


def test_links_and_concept_sources(snap):
    assert snap.broken == []
    assert snap.concepts[C_WIFI]["notes"] == [POST, WIFI]
    assert snap.concepts[C_WIFI]["sources"] == {"video": [WIFI], "post": [POST], "xpost": []}
    assert (C_WIFI, WIFI) in snap.edges or (WIFI, C_WIFI) in snap.edges


# ---------------------------------------------------------------- ranking

def test_title_hit_outranks_body_hit(tmp_path):
    concept(tmp_path, "Zeppelin", summary="An airship.", definition="A rigid frame holds gas cells.")
    concept(tmp_path, "Airship", summary="A lighter than air craft.",
            definition="The zeppelin is one kind of rigid frame craft.")
    result = snapshot(tmp_path).search("zeppelin")
    assert ids(result) == ["concepts/Zeppelin.md", "concepts/Airship.md"]
    assert result["results"][0]["score"] > result["results"][1]["score"]


def test_matching_every_word_beats_matching_one(snap):
    top = snap.search("wifi walls")["results"][0]
    assert top["id"] in (WIFI, f"{WIFI}#claim-1")


def test_stemming_finds_other_forms(snap):
    found = ids(snap.search("tracked"))
    assert f"{WIFI}#claim-1" in found and f"{BREAD}#claim-1" in found


def test_alias_is_searchable(snap):
    assert ids(snap.search("RF sensing"))[0] == C_WIFI


def test_prefix_completion_while_typing(snap):
    result = snap.search("sourd", complete=True)
    assert BREAD in ids(result)
    assert result["suggestion"] is None


def test_typo_gets_a_did_you_mean(snap):
    result = snap.search("transfromer")
    assert result["suggestion"] == "transformer"
    assert C_TRANS in ids(result)


def test_typo_suggestion_keeps_the_rest_of_the_query(snap):
    assert snap.search("attention transfromer type:video")["suggestion"] == "attention transformer type:video"


def test_no_suggestion_when_spelled_right(snap):
    assert snap.search("transformer")["suggestion"] is None


def test_nothing_found(snap):
    result = snap.search("qwxzv")
    assert result["total"] == 0 and result["results"] == []


# ---------------------------------------------------------------- filters

@pytest.mark.parametrize("query, expected", [
    ("type:video", {WIFI, BREAD, ATTN}),
    ("type:videos", {WIFI, BREAD, ATTN}),
    ("type:v", {WIFI, BREAD, ATTN}),
    ("type:post", {POST}),
    ("type:x", set()),
    ("type:concept", {C_WIFI, C_FERM, C_TRANS}),
    ("type:video,post", {WIFI, BREAD, ATTN, POST}),
    ("is:contested", {WIFI, f"{WIFI}#claim-2"}),
    ("is:outdated", {ATTN, f"{ATTN}#claim-1"}),
    ("is:flagged type:claim", {f"{WIFI}#claim-2", f"{ATTN}#claim-1"}),
    ("verdict:watch,skim type:video", {WIFI, ATTN}),
    ("-verdict:skip type:video", {WIFI, ATTN}),
    ("verdict:skip type:concept", {C_FERM}),  # a concept matches through the notes that cover it
    ("signal>=4 type:video", {WIFI, ATTN}),
    ("signal:>=4 type:video", {WIFI, ATTN}),
    ("signal>4 type:video", {WIFI}),
    ("signal<3 type:video", {BREAD}),
    ("after:30d type:video", {WIFI}),
    ("before:30d type:video", {BREAD, ATTN}),
    ("after:2025 type:video", {WIFI, BREAD, ATTN}),
    ("-tag:privacy type:video", {BREAD, ATTN}),
    ("tag:wifi type:video", {WIFI}),  # a part of "wifi-sensing"
    ('channel:"signal lab"', {WIFI, f"{WIFI}#claim-1", f"{WIFI}#claim-2", C_WIFI}),
    ("author:sample type:post", {POST}),
    ("duration>5 type:video", {WIFI, BREAD, ATTN}),
    ("duration<5 type:video", set()),
])
def test_filters(snap, query, expected):
    assert set(ids(snap.search(query))) == expected


def test_excluded_word(snap):
    with_router, without = set(ids(snap.search("wifi"))), set(ids(snap.search("wifi -router")))
    assert POST in with_router and POST not in without
    assert WIFI in without


def test_quoted_phrase(snap):
    found = ids(snap.search('"see through walls"'))
    assert found[0] == WIFI
    assert {i.split("#")[0] for i in found} == {WIFI}  # its claims too: the note's title is their context
    assert ids(snap.search('"walls through see"')) == []


def test_type_facet_counts_before_the_type_filter(snap):
    result = snap.search("type:claim")
    assert {r["type"] for r in result["results"]} == {"claim"}
    assert result["facets"]["type"]["video"] == 3 and result["facets"]["type"]["claim"] == 4


@pytest.mark.parametrize("query, order", [
    ("type:video sort:signal", [WIFI, ATTN, BREAD]),
    ("type:video sort:old", [BREAD, ATTN, WIFI]),
    ("type:video", [WIFI, ATTN, BREAD]),  # no words: newest first
])
def test_sort(snap, query, order):
    assert ids(snap.search(query)) == order


def test_highlight_segments(snap):
    result = snap.search("sourdough")
    title = next(r for r in result["results"] if r["id"] == BREAD)["title"]
    assert ["sourdough", True] in title
    assert "".join(piece for piece, _ in title) == "Baking sourdough bread at home"


# ---------------------------------------------------------------- Ask

def test_relevance_ranks_the_right_note_first(snap):
    scores = snap.relevance("Can WiFi tracking see people through walls?")
    assert max(scores, key=scores.get) == WIFI
    assert not any("#claim" in key for key in scores)  # a claim counts for its note
    assert scores[WIFI] > scores.get(BREAD, 0) > 0  # "tracking" is in the bread claim too
    assert snap.relevance("the and of") == {}


def test_cited_keeps_known_notes_in_order(snap):
    answer = ("See [[videos/Attention@03:28–07:10]] and [[concepts/Transformer|the concept]], "
              "then [[videos/Attention@04:00]], [[videos/Attention@04:00]] and [[videos/Missing note]].")
    refs = bi.cited(answer, snap.note_refs())
    assert list(refs) == [ATTN, C_TRANS]
    assert refs[ATTN]["ts"] == ["03:28–07:10", "04:00"]


# ---------------------------------------------------------------- the sample vault in examples/

def test_examples_vault():
    snap = snapshot(EXAMPLES)
    assert snap.count("video") == 2 and len(snap.concepts) == 9
    assert snap.broken == []
    assert ids(snap.search("attention"))[0] == "concepts/Attention.md"
    assert ids(snap.search("subdomain takeover"))[0] == "concepts/Subdomain takeover.md"
    # Two unrelated videos (LLMs, bug bounties) give two topics.
    llm = snap.notes["videos/Large Language Models explained briefly.md"]["cluster"]
    bounty = snap.notes["videos/I Gave Claude 12 Years of my Bug Bounty Reports - Here's What I Learned.md"]["cluster"]
    assert llm != bounty
    assert snap.concepts["concepts/Transformer.md"]["cluster"] == llm
    assert snap.concepts["concepts/Blind XSS.md"]["cluster"] == bounty
    assert len(snap.log) == 4 and snap.log[0]["status"] == "watch" and snap.log[1]["new"] == 5


# ---------------------------------------------------------------- Louvain

def groups(membership):
    out = {}
    for node, community in enumerate(membership):
        out.setdefault(community, set()).add(node)
    return sorted(out.values(), key=min)


def test_louvain_two_triangles_and_a_bridge():
    edges = [(0, 1, 1), (1, 2, 1), (0, 2, 1), (3, 4, 1), (4, 5, 1), (3, 5, 1), (2, 3, 1)]
    assert groups(bi.louvain(6, edges)) == [{0, 1, 2}, {3, 4, 5}]


def test_louvain_follows_weights():
    edges = [(0, 1, 10), (2, 3, 10), (1, 2, 1), (3, 0, 1)]
    assert groups(bi.louvain(4, edges)) == [{0, 1}, {2, 3}]


def test_louvain_disconnected_parts_and_lone_nodes():
    assert groups(bi.louvain(5, [(0, 1, 1), (2, 3, 1)])) == [{0, 1}, {2, 3}, {4}]
    assert bi.louvain(3, []) == [0, 1, 2]
    assert bi.louvain(0, []) == []
    assert bi.louvain(2, [(0, 0, 1)]) == [0, 1]  # a self-loop is ignored


def test_louvain_is_deterministic():
    edges = [(i, (i * 7 + 3) % 30, 1 + i % 3) for i in range(30)] + [(i, i + 1, 1) for i in range(0, 29, 2)]
    assert bi.louvain(30, edges) == bi.louvain(30, edges)
