// Search: BM25 over every video, LinkedIn post, concept and claim (server side, /api/search), with
// filters typed into the query itself, so a search is just a line of text you can share.
// The same box switches to "Ask the brain" (ask.js), where Claude answers from the notes.

import {
  el, searchIcon, api, store, fmtDay, fmtDuration, verdictChip, tsLink, highlighted, openNote, clusterColor,
  debounce, hideTip, setChildren, noteThumb, actionText, sourceOf,
} from "./ui.js";
import { createAsk } from "./ask.js";

// The type buttons: every source (server/sources.py), then concepts and claims.
const types = () => [["", "All"], ...(store.brain?.sources || []).map((s) => [s.key, s.many[0].toUpperCase() + s.many.slice(1)]),
  ["concept", "Concepts"], ["claim", "Claims"]];
const EXAMPLES = [
  ["wifi tracking", "words anywhere, typos and endings forgiven"],
  ["type:claim is:contested", "claims the web check disputed"],
  ["verdict:watch signal>=4", "the videos worth watching in full"],
  ["type:post verdict:keep after:30d", "the LinkedIn posts worth keeping, this month"],
  ["tag:osint after:30d", "a topic, captured this month"],
  ['"signal rate" -xss', "an exact phrase, without a word"],
  ["concept:attention type:claim", "every claim from videos and posts on a concept"],
];
const SYNTAX = [
  ["wifi tracking", "Words anywhere. Endings, accents and small typos are forgiven."],
  ['"signal rate"', "Exact phrase"],
  ["-xss", "Leave out notes with this word"],
  ["type:claim", "video, post, concept or claim (comma for several)"],
  ["verdict:watch,skim", "watch, skim or skip for videos; keep or noise for posts"],
  ['channel:"two minute"', "Part of the channel's or the post author's name (author: works too)"],
  ["action:saved", "Posts by what you did: saved, manual, or a reaction (like, celebrate…)"],
  ["tag:osint", "A topic tag"],
  ["concept:bm25", "Notes that link a concept"],
  ["signal>=4", "Signal rating 1–5; also > < <= ="],
  ["duration<15", "Video length in minutes (or 1h)"],
  ["after:30d  before:2026-10", "Capture date: 7d, 2w, 3m, 1y, today, or a date"],
  ["is:contested", "Claims flagged by the web check (also outdated, flagged)"],
  ["novelty:new  trust:solid", "From the verdict line"],
  ["sort:new", "new, old or signal; relevance by default"],
];

export function mount(root, params) {
  let q = params.get("q") || "";
  let mode = params.get("mode") === "ask" ? "ask" : "search";
  let controller = null, selected = -1, results = [];

  const input = el("input", {
    id: "search-q", type: "search", value: q, autocomplete: "off", spellcheck: "false", "aria-label": "Search query",
  });
  const syntaxBtn = el("button", { class: "btn syntax", type: "button", text: "Syntax" });
  const askBtn = el("button", { class: "btn primary syntax", type: "button", text: "Ask", onclick: () => submitAsk() });
  const modeSeg = el("div", { class: "segmented", role: "group", "aria-label": "Search or ask" });
  const typeSeg = el("div", { class: "segmented", role: "group", "aria-label": "Note type" });
  const count = el("span", { class: "count" });
  const suggest = el("span", { class: "suggest" });
  const askLink = el("a", { class: "ask-link", href: "#", onclick: (e) => { e.preventDefault(); setMode("ask"); } },
    "Not finding it? Ask the brain →");
  const list = el("ul", { class: "results", role: "listbox", "aria-label": "Results" });
  const facets = el("aside", { class: "facets" });
  const help = el("div");
  const searchArea = el("div", {},
    el("div", { class: "search-meta" }, typeSeg, count, suggest, askLink),
    el("div", { class: "search-layout" }, el("div", {}, list, help), facets));
  const asker = createAsk({ onPick: (question) => { input.value = question; input.focus(); } });

  root.append(
    el("div", { class: "search-modes" }, modeSeg),
    el("div", { class: "search-box" }, searchIcon(), input, syntaxBtn, askBtn),
    searchArea, asker.node);

  // ---------------------------------------------------------- modes

  const hashFor = () => {
    const query = q ? `q=${encodeURIComponent(q)}` : "";
    return mode === "ask" ? `#/search?mode=ask${query ? `&${query}` : ""}` : `#/search${query ? `?${query}` : ""}`;
  };

  function setMode(next, { run: runNow = true } = {}) {
    mode = next;
    q = input.value;
    const asking = mode === "ask";
    setChildren(modeSeg, ...[["search", "Search"], ["ask", "Ask the brain"]].map(([key, label]) => el("button", {
      type: "button", "aria-pressed": String(mode === key), onclick: () => mode !== key && setMode(key),
    }, label)));
    input.placeholder = asking
      ? "Ask a question about what you've watched…  e.g. which video showed radar seeing through walls?"
      : "Search videos, LinkedIn posts, concepts and claims…";
    input.setAttribute("aria-label", asking ? "Question" : "Search query");
    syntaxBtn.hidden = asking;
    askBtn.hidden = !asking;
    searchArea.hidden = asking;
    asker.node.hidden = !asking;
    if (location.hash !== hashFor()) history.replaceState(null, "", hashFor());
    if (asking) asker.ready.then(() => q && asker.showSaved(q));
    else if (runNow) run(false);
    input.focus();
  }

  function submitAsk() {
    q = input.value;
    if (!q.trim()) return input.focus();
    history.replaceState(null, "", hashFor());
    asker.ask(q);
  }

  // ---------------------------------------------------------- query editing

  // Replace (or remove) every `key:...` token in the query.
  function setFilter(key, value) {
    const rest = q.replace(new RegExp(`(^|\\s)-?${key}(:|>=|<=|>|<|=)("[^"]*"|\\S*)`, "gi"), " ").replace(/\s+/g, " ").trim();
    return value ? `${rest} ${key}:${/\s/.test(value) ? `"${value}"` : value}`.trim() : rest;
  }
  function hasFilter(key, value) {
    const v = /\s/.test(value) ? `"${value}"` : value;
    return new RegExp(`(^|\\s)${key}:${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "i").test(q);
  }
  function setQuery(next) {
    q = next;
    input.value = next;
    run(false);
  }

  // ---------------------------------------------------------- fetching

  const run = async (typing) => {
    q = input.value;
    if (location.hash !== hashFor()) history.replaceState(null, "", hashFor());
    askLink.hidden = !q.trim();
    renderTypes(null);
    if (!q.trim()) {
      controller?.abort();
      results = [];
      setChildren(list);
      setChildren(facets);
      count.textContent = "";
      setChildren(suggest);
      setChildren(help, helpPanel());
      return;
    }
    setChildren(help);
    controller?.abort();
    controller = new AbortController();
    list.classList.add("stale"); // keep the old results visible while the new ones load
    const started = performance.now();
    let data;
    try {
      data = await api(`/api/search?q=${encodeURIComponent(q)}&complete=${typing ? 1 : 0}`, { signal: controller.signal });
    } catch (e) {
      if (e.name === "AbortError") return;
      list.classList.remove("stale");
      setChildren(list, el("li", { class: "empty", text: `Search failed: ${e.message}` }));
      return;
    }
    list.classList.remove("stale");
    results = data.results;
    selected = -1;
    renderTypes(data.facets.type);
    count.textContent = `${data.total.toLocaleString("en")} result${data.total === 1 ? "" : "s"}`
      + `${data.total > results.length ? `, showing ${results.length}` : ""} · ${Math.round(performance.now() - started)} ms`;
    setChildren(suggest, ...(data.suggestion && data.suggestion !== q
      ? ["Did you mean ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); setQuery(data.suggestion); } }, data.suggestion), "?"]
      : []));
    setChildren(list, ...(results.length ? results.map(resultRow) : [el("li", { class: "empty", text: "Nothing matches. Try fewer words, or drop a filter." })]));
    renderFacets(data.facets);
  };
  const runSoon = debounce(() => run(true), 110);

  // ---------------------------------------------------------- rendering

  function renderTypes(counts) {
    const current = (q.match(/(?:^|\s)type:(\w+)/i) || [])[1]?.toLowerCase().replace(/s$/, "") || "";
    const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
    setChildren(typeSeg, ...types().map(([key, label]) => el("button", {
      type: "button", "aria-pressed": String(current === key),
      onclick: () => setQuery(setFilter("type", key)),
    }, counts ? `${label} ${key ? counts[key] || 0 : total}` : label)));
  }

  function renderFacets(f) {
    const group = (title, key, items, format = (v) => v) => items.length > 0 && el("section", {},
      el("h3", { text: title }),
      el("div", { class: "facet-list" }, items.map(([value, n]) => {
        const on = hasFilter(key, value);
        return el("button", {
          class: "chip", type: "button", "aria-pressed": String(on),
          onclick: () => setQuery(on ? setFilter(key, "") : setFilter(key, value)),
        }, format(value), el("b", { text: String(n) }));
      })));
    setChildren(facets, ...[
      group("Verdict", "verdict", f.verdict.filter(([v]) => v !== "?")),
      group("Channel or author", "channel", f.channel.filter(([v]) => v !== "?").slice(0, 8)),
      group("Tag", "tag", f.tag, (t) => `#${t}`),
    ].filter(Boolean));
  }

  function resultRow(r, i) {
    const open = () => {
      select(i);
      openNote(r.path);
    };
    let body;
    const source = sourceOf(r.type);
    if (source) { // a note from any source: video, LinkedIn post…
      body = [
        el("div", { class: "kind", text: source.label }),
        el("div", { class: "rtitle" }, highlighted(r.title)),
        el("div", { class: "snippet" }, highlighted(r.snippet)),
        el("div", { class: "meta" }, verdictChip(r.verdict, r.type), r.signal != null && el("span", { text: `signal ${r.signal}/5` }),
          el("span", { text: r.channel }), r.duration_s > 0 && el("span", { text: fmtDuration(r.duration_s) }),
          r.action && el("span", { text: actionText(r.action) }),
          r.captured && el("span", { text: `captured ${fmtDay(r.captured, { year: true })}` })),
      ];
    } else if (r.type === "concept") {
      body = [
        el("div", { class: "kind", text: "Concept" }),
        el("div", { class: "rtitle" }, highlighted(r.title),
          r.aliases?.length > 0 && el("span", { class: "muted small", style: { fontWeight: "400" }, text: `  aka ${r.aliases.join(", ")}` })),
        el("div", { class: "snippet" }, highlighted(r.snippet)),
        el("div", { class: "meta" },
          el("span", {}, el("span", { class: "sw round", style: { background: clusterColor(r.cluster), width: "8px", height: "8px", marginRight: "5px" } }),
            store.brain?.clusterById.get(r.cluster)?.label || ""),
          (store.brain?.sources || []).map((src, i) => {
            const n = r.sources?.[src.key] || 0;
            return (n || i === 0) && el("span", { text: `${n} ${n === 1 ? src.one : src.many}` });
          }),
          r.updated && el("span", { text: `updated ${fmtDay(r.updated)}` })),
      ];
    } else {
      body = [
        el("div", { class: "kind", text: `Claim · ${sourceOf(r.source)?.label || "note"}` }),
        el("div", { class: "rtitle" }, highlighted(r.title)),
        r.snippet.length > 0 && el("div", { class: "snippet" }, "e.g. ", highlighted(r.snippet)),
        el("div", { class: "meta" }, tsLink(r.ts),
          r.flag && el("span", { class: "chip flag", title: r.flag_reason }, el("span", { class: "icon", text: "⚠" }), r.flag),
          el("a", { class: "from", href: "#", onclick: (e) => { e.preventDefault(); e.stopPropagation(); open(); } }, r.video_title),
          el("span", { text: r.channel })),
      ];
    }
    return el("li", { class: "result", role: "option", onclick: open },
      source
        ? noteThumb({ kind: r.type, video_id: r.video_id, channel: r.channel })
        : el("span", { class: `marker ${r.type}`, style: r.type === "concept" ? { background: clusterColor(r.cluster) } : {} }),
      el("div", { class: "grow" }, body));
  }

  function select(i) {
    const rows = list.querySelectorAll(".result");
    rows[selected]?.classList.remove("selected");
    selected = Math.max(-1, Math.min(rows.length - 1, i));
    rows[selected]?.classList.add("selected");
    rows[selected]?.scrollIntoView({ block: "nearest" });
  }

  function helpPanel() {
    return el("div", { class: "help" },
      el("section", { class: "card" },
        el("div", { class: "card-head" }, el("h2", { text: "Try" })),
        el("div", { class: "examples" }, EXAMPLES.map(([query, what]) => el("button", {
          type: "button", onclick: () => { setQuery(query); input.focus(); },
        }, el("code", { text: query }), el("span", { text: what }))))),
      el("section", { class: "card" },
        el("div", { class: "card-head" }, el("h2", { text: "Query syntax" }), el("span", { class: "sub", text: "mix freely" })),
        el("div", { class: "table-wrap" }, el("table", { class: "data" }, el("tbody", {},
          SYNTAX.map(([code, what]) => el("tr", {}, el("td", {}, el("code", { text: code })), el("td", { text: what }))))))));
  }

  // ---------------------------------------------------------- events

  input.addEventListener("input", () => {
    if (mode === "search") runSoon();
  });
  input.addEventListener("keydown", (e) => {
    if (mode === "ask") {
      if (e.key === "Enter") {
        e.preventDefault();
        submitAsk();
      }
    } else if (e.key === "ArrowDown") { e.preventDefault(); select(selected + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (selected >= 0 && results[selected]) openNote(results[selected].path);
      else run(false);
    }
  });
  syntaxBtn.addEventListener("click", () => {
    const showing = help.childElementCount > 0;
    setChildren(help, ...(showing && q.trim() ? [] : [helpPanel()]));
  });

  setMode(mode); // asking never starts on its own: a question costs plan usage

  return {
    update(p) {
      const next = p.get("q") || "";
      const nextMode = p.get("mode") === "ask" ? "ask" : "search";
      if (next !== input.value) input.value = next;
      if (nextMode !== mode || mode === "search") setMode(nextMode);
      else {
        asker.ready.then(() => next && asker.showSaved(next));
        input.focus();
      }
    },
    unmount() {
      controller?.abort();
      asker.destroy();
      hideTip();
    },
  };
}
