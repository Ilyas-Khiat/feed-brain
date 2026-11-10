"""Evaluate Ask the brain on questions with known answers, and measure how it found them.

    server/.venv/Scripts/python tools/ask_eval.py QUESTIONS.json --vault VAULT_COPY --out RESULTS.json

Run it against a dev server (tools/dev_server.py, port 8766) on a copy of the vault the questions
were written for: each question is a real Ask run and costs plan usage (about $0.02-0.20).

QUESTIONS.json is a list of:
  id        short name
  question  asked exactly as written
  kind      what it tests (bridge, comparison, contradiction, aggregation, control, absent)
  notes     the vault notes a complete answer must cite ("videos/X.md"); [] when nothing should be cited
  facts     facts the answer must contain: each is a list of regexes, any of which counts (case-insensitive)
  absent    true when the vault doesn't cover the question: the answer must say so (pointing to the
            closest notes is allowed, as ask.md asks)

For each answer it records the tool calls in order and scores: facts found, required notes cited,
notes opened, and link hops: notes opened right after reading a note that links to them, which is
Claude following the vault's own links rather than finding a note from the catalog or a keyword.
Citations are parsed with the repo's own brain_index.cited(), so a parser fix shows up when the
saved answers are scored again (no new questions asked):

    server/.venv/Scripts/python tools/ask_eval.py QUESTIONS.json --vault VAULT_COPY --out RESULTS.json --rescore
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from brain_index import cited as parse_citations  # noqa: E402  (the server's own citation parser)

LINK_RE = re.compile(r"\[\[([^\]|#@]+)")


def links_of(vault, note, cache={}):
    """The notes a note links to, as vault-relative paths with .md."""
    if note not in cache:
        path = vault / note
        text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        cache[note] = {f"{target.strip()}.md" for target in LINK_RE.findall(text)}
    return cache[note]


def ask(base, question, timeout=360):
    req = urllib.request.Request(f"{base}/api/ask", data=json.dumps({"question": question}).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    trace, done, error = [], None, None
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            event = json.loads(line)
            if event.get("type") == "tool":
                trace.append({"tool": event.get("tool"), "target": event.get("target")})
            elif event.get("type") == "done":
                done = event
            elif event.get("type") == "error":
                error = event.get("message")
    return trace, done, error


def vault_notes(vault, cache={}):
    """Every note in the vault copy, in the shape brain_index.cited() expects."""
    if vault not in cache:
        cache[vault] = {p.relative_to(vault).as_posix(): {} for p in vault.rglob("*.md")}
    return cache[vault]


def score(q, trace, done, vault):
    answer = (done or {}).get("answer") or ""
    cited = list(parse_citations(answer, vault_notes(vault)))
    facts = [any(re.search(p, answer, re.I) for p in alternatives) for alternatives in q.get("facts", [])]
    required = q.get("notes", [])
    opened, hops = [], []
    for step in trace:
        if step["tool"] != "Read":
            continue
        note = step["target"]
        sources = [prev for prev in opened if note in links_of(vault, prev)]
        if sources and note not in opened:
            hops.append({"to": note, "from": sources[-1]})
        if note not in opened:
            opened.append(note)
    out = {
        "facts_found": sum(facts), "facts_total": len(facts), "facts": facts,
        "required_cited": sum(n in cited for n in required), "required_total": len(required),
        "missing_notes": [n for n in required if n not in cited],
        "cited": cited, "opened": opened, "link_hops": hops,
        "greps": [s["target"] for s in trace if s["tool"] in ("Grep", "Glob")],
    }
    if q.get("absent"):
        out["said_absent"] = bool(re.search(r"\b(don't|do not|doesn't|does not|none of|not (in|covered|cover))\b"
                                            r"|^\W*no (video|note|post|source)s?\b", answer, re.I))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("questions", type=Path)
    ap.add_argument("--vault", type=Path, required=True, help="the dev server's vault copy, to read note links")
    ap.add_argument("--base", default="http://127.0.0.1:8766")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--only", help="comma-separated question ids")
    ap.add_argument("--rescore", action="store_true", help="score the saved answers again, without asking")
    args = ap.parse_args()
    if args.base.rstrip("/").endswith(":8765"):
        sys.exit("That's the real server's port. Run this against a dev server (tools/dev_server.py).")

    questions = json.loads(args.questions.read_text(encoding="utf-8"))
    if args.only:
        keep = set(args.only.split(","))
        questions = [q for q in questions if q["id"] in keep]
    results = json.loads(args.out.read_text(encoding="utf-8")) if args.out.exists() else {}
    if args.rescore:
        for q in questions:
            if q["id"] in results:
                r = results[q["id"]]
                r["score"] = score(q, r["trace"], {"answer": r["answer"]}, args.vault)
        args.out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
        return summary(questions, results)
    for q in questions:
        print(f"[{q['id']}] {q['question']}", flush=True)
        started = time.time()
        try:
            trace, done, error = ask(args.base.rstrip("/"), q["question"])
        except Exception as e:  # keep going: one failed question shouldn't lose the others
            trace, done, error = [], None, repr(e)
        s = score(q, trace, done, args.vault)
        results[q["id"]] = {"question": q["question"], "kind": q.get("kind"), "error": error, "trace": trace,
                            "answer": (done or {}).get("answer"), "score": s,
                            "steps": (done or {}).get("steps"), "cost_usd": (done or {}).get("cost_usd"),
                            "seconds": (done or {}).get("seconds") or round(time.time() - started, 1),
                            "tokens_in": (done or {}).get("tokens_in"), "tokens_cached": (done or {}).get("tokens_cached")}
        args.out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"    facts {s['facts_found']}/{s['facts_total']} · notes cited {s['required_cited']}/{s['required_total']}"
              f" · opened {len(s['opened'])} · link hops {len(s['link_hops'])} · greps {len(s['greps'])}"
              f" · ${(done or {}).get('cost_usd') or 0:.3f} · {results[q['id']]['seconds']}s"
              + (f" · ERROR {error}" if error else ""), flush=True)
    summary(questions, results)


def summary(questions, results):
    rows = [results[q["id"]] for q in questions if q["id"] in results]
    facts = [sum(r["score"][k] for r in rows) for k in ("facts_found", "facts_total")]
    notes = [sum(r["score"][k] for r in rows) for k in ("required_cited", "required_total")]
    hops = sum(len(r["score"]["link_hops"]) for r in rows)
    cost = sum(r.get("cost_usd") or 0 for r in rows)
    print(f"\n{len(rows)} questions · facts {facts[0]}/{facts[1]} · required notes cited {notes[0]}/{notes[1]}"
          f" · link hops {hops} · ${cost:.2f} in total")
    for q in questions:
        r = results.get(q["id"])
        if r:
            s = r["score"]
            print(f"  {q['id']:16} facts {s['facts_found']}/{s['facts_total']}  notes {s['required_cited']}/{s['required_total']}"
                  f"  opened {len(s['opened'])}  hops {len(s['link_hops'])}  greps {len(s['greps'])}"
                  + (f"  said_absent={s['said_absent']}" if "said_absent" in s else ""))


if __name__ == "__main__":
    main()
