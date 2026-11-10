// Ask the brain: Claude starts from the catalog, opens the notes it needs, and answers from
// them only, citing them as [[videos/Some title@04:23]]. POST /api/ask streams its steps and
// the answer as one JSON event per line; every answer is kept (GET /api/asks), so reading it
// again costs nothing. A follow-up carries the thread it continues. Only Stop ends a
// question: asking another one or opening an earlier answer leaves it running, and it lands
// in the list. Used by the search page's Ask tab and by the dashboard (compact).

import {
  el, setChildren, api, store, onBrain, markdown, openNote, clusterColor, ago, plural, showTip, hideTip, fmt,
  noteThumb, sourceOf,
} from "./ui.js";

// A cited range opens the video at its start.
const seconds = (ts) => ts.split(/\s*[–-]\s*/)[0].split(":").reduce((total, part) => total * 60 + Number(part), 0);
const youtube = (videoId, ts) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${seconds(ts)}s`;

// A note as the page knows it, for a citation or a step ("videos/X.md"). Saved answers carry
// their own copy of what they cite, in case the note was renamed since.
function noteRef(entry, id) {
  if (entry.refs?.[id]) return entry.refs[id];
  const rec = store.brain?.byId.get(id);
  return rec && { id, kind: rec.kind, title: rec.title || rec.name, cluster: rec.cluster, video_id: rec.video_id, channel: rec.channel };
}

// compact: for the dashboard, with no example questions and only the last few earlier ones.
export function createAsk({ onPick, compact = false }) {
  let current = null, history = [], model = "", frame = 0;
  const running = []; // questions still being answered, shown or not
  let parts = null; // the answer card's pieces, kept while one entry is shown so Stop stays clickable

  const hint = el("p", { class: "ask-hint" });
  const card = el("section", { class: "card ask-answer", hidden: true });
  const past = el("section", { class: "ask-history" });
  const node = el("div", { class: "ask" }, hint, card, past);

  // ---------------------------------------------------------- rendering

  // Citation chips for one answer, numbered in order of first use.
  function citations(entry) {
    const c = { order: [], stamps: new Map(), refs: {} };
    c.cite = (cited) => cited.map(({ ref, ts }) => {
      const r = noteRef(entry, ref);
      if (!r) return el("span", { class: "cite bad", title: "Not one of your notes", text: "?" });
      c.refs[ref] = r;
      if (!c.order.includes(ref)) c.order.push(ref);
      if (ts && r.video_id) c.stamps.set(ref, [...new Set([...(c.stamps.get(ref) || []), ts])]);
      const url = ts && r.video_id ? youtube(r.video_id, ts) : null;
      return el("a", {
        class: "cite", href: url || "#", target: url ? "_blank" : null, rel: url ? "noopener noreferrer" : null,
        onclick: url ? null : (e) => { e.preventDefault(); openNote(r.id); },
        onpointermove: (e) => showTip(e, el("div", { class: "tt-title", text: r.title }),
          el("div", { class: "tt-head", text: url ? `Watch from ${ts} on YouTube` : `Open the ${r.kind} note` })),
        onpointerleave: hideTip,
      }, String(c.order.indexOf(ref) + 1), url && el("span", { class: "cite-ts", text: ts }));
    });
    return c;
  }

  // The saved exchanges an answer follows up on, oldest first.
  function threadOf(entry) {
    const chain = [];
    for (let id = entry.parent; id && chain.length < 20;) {
      const prev = history.find((h) => h.id === id);
      if (!prev || chain.includes(prev)) break;
      chain.unshift(prev);
      id = prev.parent;
    }
    return chain;
  }

  // An earlier exchange of the thread, above the latest one. Clicking its question folds it.
  function earlierTurn(h) {
    const c = citations(h);
    const body = el("div", { class: "md ask-body" }, markdown(h.answer || "", { cite: c.cite }));
    const turn = el("div", { class: "ask-turn" });
    const question = el("button", {
      class: "ask-q", type: "button", text: h.question, title: "Fold or unfold this answer", "aria-expanded": "true",
      onclick: () => question.setAttribute("aria-expanded", String(!turn.classList.toggle("folded"))),
    });
    return setChildren(turn, question, body,
      c.order.length > 0 && el("p", { class: "ask-reading" }, "Sources: ", c.order.map((ref, i) => [i ? " · " : "",
        el("a", { href: "#", onclick: (e) => { e.preventDefault(); openNote(c.refs[ref].id); } }, `${i + 1} ${c.refs[ref].title}`)])));
  }

  // Close the answer card. A question still being answered keeps going and stays in the list.
  function close() {
    current = null;
    parts = null;
    card.hidden = true;
    hideTip();
    renderHistory();
  }

  // The card's top bar: what it shows, then Collapse (keep just the question and its status) and Close.
  function cardBar(earlier) {
    const toggle = el("button", { class: "icon-btn", type: "button" });
    const collapse = (on) => {
      card.classList.toggle("collapsed", on);
      toggle.textContent = on ? "▸" : "▾";
      toggle.title = on ? "Expand" : "Collapse";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", String(!on));
    };
    toggle.addEventListener("click", () => collapse(!card.classList.contains("collapsed")));
    collapse(false);
    return {
      bar: el("div", { class: "ask-bar" },
        el("span", { class: "label", text: earlier.length ? `Thread · ${earlier.length + 1} questions` : "Answer" }),
        toggle, el("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", text: "×", onclick: close })),
      expand: () => collapse(false),
    };
  }

  function render() {
    const entry = current;
    if (!entry) {
      card.hidden = true;
      return;
    }
    const c = citations(entry);
    if (parts?.entry !== entry) {
      const input = el("input", { type: "text", placeholder: "Ask a follow-up about this answer…", "aria-label": "Follow-up question" });
      parts = { entry, status: el("div"), reading: el("p", { class: "ask-reading" }),
        body: el("div", { class: "md ask-body" }), sources: el("div", { class: "ask-sources" }),
        follow: el("form", {
          class: "ask-follow",
          onsubmit: (e) => {
            e.preventDefault();
            if (input.value.trim()) ask(input.value, { parent: entry });
          },
        }, input, el("button", { class: "btn primary", type: "submit", text: "Follow up" })) };
      const earlier = threadOf(entry);
      const { bar, expand } = cardBar(earlier);
      setChildren(card, bar, earlier.length > 0 && el("div", { class: "ask-thread" }, earlier.map(earlierTurn)),
        el("div", { class: "ask-q", text: entry.question, onclick: expand }),
        parts.status, parts.reading, parts.body, parts.sources, parts.follow);
    }
    card.hidden = false;
    renderStatus();
    setChildren(parts.body, markdown(entry.answer, { cite: c.cite }));
    parts.body.hidden = !entry.answer;
    if (entry.streaming) { // a caret at the end of the last line while Claude writes
      let last = parts.body;
      while (last.lastElementChild && /^(P|UL|OL|LI)$/.test(last.lastElementChild.tagName)) last = last.lastElementChild;
      last.append(el("span", { class: "caret", "aria-hidden": "true" }));
    }
    parts.sources.hidden = !c.order.length;
    setChildren(parts.sources, el("h3", { text: `Sources · ${c.order.length}` }),
      el("ol", {}, c.order.map((ref, i) => sourceRow(c.refs[ref], i + 1, c.stamps.get(ref) || []))));
    renderReading(c.order);
    parts.follow.hidden = entry.streaming || !entry.id; // only a saved answer can be followed up
  }

  // The notes Claude opened, as links: what it read but didn't cite is still worth a look.
  function renderReading(cited = []) {
    const entry = parts.entry;
    const read = (entry.read || []).filter((id) => !cited.includes(id));
    parts.reading.hidden = !read.length;
    setChildren(parts.reading, read.length > 0 && [entry.streaming ? "Read so far: " : "Also read: ",
      read.map((id, i) => {
        const r = noteRef(entry, id);
        return [i ? " · " : "", r ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); openNote(id); } }, r.title) : id];
      })]);
  }

  // While Claude works, only the stage text changes, so the Stop button is never rebuilt under the pointer.
  function renderStatus() {
    const entry = parts.entry;
    if (!entry.streaming) {
      parts.stage = null;
      setChildren(parts.status, statusLine(entry));
      return;
    }
    if (!parts.stage) {
      parts.stage = el("span");
      setChildren(parts.status, el("div", { class: "ask-meta busy" }, el("i", { class: "pulse" }), parts.stage,
        el("button", { class: "toggle", type: "button", text: "Stop", onclick: () => entry.controller.abort() })));
    }
    parts.stage.textContent = `${entry.stage}${elapsed(entry) >= 2 ? ` · ${elapsed(entry)} s` : ""}`;
  }

  const elapsed = (entry) => Math.round((Date.now() - entry.started) / 1000);

  function statusLine(entry) {
    if (entry.error) {
      return el("div", { class: "status-row" }, el("span", { class: "icon critical", text: "✕", "aria-hidden": "true" }),
        el("div", { class: "what" }, el("b", { text: "Couldn't answer: " }), entry.error));
    }
    const since = entry.saved && ago(entry.time);
    const facts = [since && (since === "now" ? "asked just now" : /\d (min|h|d)$/.test(since) ? `asked ${since} ago` : `asked ${since}`),
      entry.stopped && "stopped",
      entry.read && !entry.stopped && `read ${plural(entry.read.length, "note")}`,
      entry.tokens_in != null && `${fmt(entry.tokens_in)} tokens in (${fmt(entry.tokens_cached)} cached), ${fmt(entry.tokens_out)} out`,
      entry.seconds != null && `${entry.seconds} s`, entry.cost_usd != null && `$${entry.cost_usd.toFixed(3)}`, entry.model];
    return el("div", { class: "ask-meta", text: facts.filter(Boolean).join(" · ") });
  }

  function sourceRow(r, n, stamps) {
    return el("li", {},
      el("span", { class: "num", text: String(n) }),
      r.kind === "concept"
        ? el("span", { class: "sw round", style: { background: clusterColor(r.cluster), margin: "6px 4px 0" } })
        : noteThumb(r, { small: true }),
      el("div", { class: "grow" },
        el("a", { href: "#", class: "title", onclick: (e) => { e.preventDefault(); openNote(r.id); } }, r.title),
        el("div", { class: "meta" }, el("span", { text: r.kind === "concept" ? "concept"
          : [r.channel, sourceOf(r.kind)?.one || r.kind].filter(Boolean).join(" · ") }),
          stamps.map((ts) => el("a", { class: "ts-link", href: youtube(r.video_id, ts), target: "_blank", rel: "noopener noreferrer" }, ts)))));
  }

  function renderHistory() {
    const others = (list) => list.filter((h) => h !== current && !(h.id && h.id === current?.id));
    const answering = others(running);
    const shown = others(history).slice(0, compact ? 3 : 12);
    if (!history.length && !answering.length) {
      setChildren(past, !compact && [el("h3", { text: "Try asking" }), el("div", { class: "examples" }, examples().map((q) =>
        el("button", { type: "button", onclick: () => onPick(q) }, el("span", { class: "ask-example", text: q }), el("span", { text: "fill in" }))))]);
      return;
    }
    const followUp = (h) => h.parent && history.find((p) => p.id === h.parent);
    setChildren(past, (answering.length || shown.length) > 0 && [el("h3", { text: "Earlier questions" }), el("ul", { class: "list" },
      answering.map((h) => el("li", {},
        el("span", { class: "when", text: "now" }),
        el("div", { class: "grow" },
          el("span", { class: "title", text: h.question, onclick: () => show(h) }),
          el("div", { class: "meta" }, el("span", { text: "answering…" }))))),
      shown.map((h) => el("li", {},
        el("span", { class: "when", text: ago(h.time) }),
        el("div", { class: "grow" },
          el("span", { class: "title", text: followUp(h) ? `↳ ${h.question}` : h.question, onclick: () => show({ ...h, saved: true }) }),
          el("div", { class: "meta" },
            followUp(h) && el("span", { text: `follow-up to “${followUp(h).question.slice(0, 60)}”` }),
            el("span", { text: plural(Object.keys(h.refs || {}).length, "source") }),
            h.cost_usd != null && el("span", { text: `$${h.cost_usd.toFixed(3)}` })))))),
      compact && history.length > shown.length && el("a", { class: "ask-more", href: "#/search?mode=ask", text: "All earlier questions →" })]);
  }

  function examples() {
    const hubs = (store.brain?.clusters || []).filter((c) => c.hub).slice(0, 2).map((c) => `What do my notes say about ${c.hub}?`);
    return [...hubs, "Which claims in my notes were contested, and why?", "Which videos should I actually rewatch, and which parts?"];
  }

  function renderHint() {
    setChildren(hint, "Claude answers from your notes only, citing each point; click a number to jump to that moment. ",
      el("span", { class: "muted", text: `Uses Claude ${model ? model[0].toUpperCase() + model.slice(1) : "Sonnet"} on your plan and takes 10–40 s. Answers are saved.` }));
  }

  // ---------------------------------------------------------- asking

  function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  }

  // `parent`: the saved answer this question follows up on; its thread goes along.
  async function ask(question, { parent } = {}) {
    question = question.trim();
    if (!question) return;
    const entry = {
      question, parent: parent?.id || null, answer: "", refs: {}, read: [], streaming: true, started: Date.now(),
      stage: parent ? "Sending your follow-up…" : "Sending your question…", controller: new AbortController(),
    };
    // Each question has its own timer, so one finishing never stops another's clock.
    entry.timer = setInterval(() => parts?.entry === entry && renderStatus(), 1000);
    running.push(entry);
    current = entry;
    render();
    renderHistory();
    const finish = (changes) => {
      if (!entry.streaming) return;
      Object.assign(entry, { streaming: false }, changes);
      clearInterval(entry.timer);
      running.splice(running.indexOf(entry), 1);
      if (current === entry) render();
      renderHistory();
    };
    try {
      const res = await fetch("/api/ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, parent: entry.parent }), signal: entry.controller.signal,
      });
      if (!res.ok) return finish({ error: (await res.json().catch(() => ({}))).error || `HTTP ${res.status}` });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) handle(entry, JSON.parse(line), finish);
        }
      }
      finish({ error: "The answer stopped early. Is the server still running?" });
    } catch (e) {
      if (e.name === "AbortError") finish({ stopped: true, stage: "" });
      else finish({ error: e.message === "Failed to fetch" ? "Can't reach the Feed Brain server." : e.message });
    }
  }

  function handle(entry, event, finish) {
    if (event.type === "start") {
      const notes = Object.entries(event.notes || {}).filter(([, n]) => n).map(([kind, n]) => {
        const source = sourceOf(kind);
        return source ? plural(n, source.one, source.many) : `${n} ${kind}`;
      });
      entry.stage = `Reading the catalog: ${[...notes, plural(event.concepts, "concept")].join(", ")}`;
    } else if (event.type === "status") {
      entry.stage = event.text;
    } else if (event.type === "step") {
      entry.answer = ""; // text before a step's reading was Claude thinking aloud, not the answer
    } else if (event.type === "tool") {
      if (event.tool === "Read") {
        entry.read.push(event.target);
        entry.stage = `Reading ${noteRef(entry, event.target)?.title || event.target}`;
      } else {
        entry.stage = event.tool === "Grep" ? `Searching the notes for “${event.target}”` : `Listing ${event.target}`;
      }
    } else if (event.type === "delta") {
      entry.answer += event.text;
      entry.stage = "Writing";
    } else if (event.type === "done") {
      const { type, ...saved } = event;
      history.unshift(saved);
      finish(saved);
      return;
    } else if (event.type === "error") {
      finish({ error: event.message });
      return;
    }
    if (current === entry) scheduleRender();
  }

  // Show a question: a running one keeps streaming here; a saved one as it was saved
  // (its refs hold just the notes it cited).
  function show(entry) {
    current = entry;
    render();
    renderHistory();
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function showSaved(question) {
    const saved = history.find((h) => h.question === question.trim());
    if (saved) show({ ...saved, saved: true });
    return Boolean(saved);
  }

  const ready = api("/api/asks").then((data) => {
    history = data.asks;
    model = data.model;
  }).catch(() => {}).then(() => {
    renderHint();
    renderHistory();
  });
  const off = onBrain(renderHistory); // the example questions use the vault's topics

  return {
    node, ask, ready, showSaved,
    // Leaving the page doesn't stop a question: the server still saves its answer.
    destroy() {
      running.forEach((entry) => clearInterval(entry.timer));
      cancelAnimationFrame(frame);
      off();
    },
  };
}
