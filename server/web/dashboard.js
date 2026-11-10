// Dashboard: what's in the brain, where it came from, where its sources meet in the concepts
// they share, and where the attention went. One date range above everything scopes every card.
//
// Nothing here names a source: the cards loop over brain.sources (server/sources.py), so a new
// kind of note (X posts, Instagram reels…) gets its tile, its series and its filters by itself.
// Every source is drawn the same way: its colour (--src-<key>) for its notes, the lightest step
// of its ramp for its low verdict ("skip", "noise"), and its ramp for its ordered classes.

import {
  el, svg, store, onBrain, fmt, plural, fmtHours, fmtDay, isoDay, addDays, daysBetween, ago,
  setChildren, verdictChip, classColor, tsLink, showTip, hideTip, tipRow, openNote, clusterColor, debounce,
  searchIcon, noteThumb, actionText, sourceOf,
} from "./ui.js";
import { createAsk } from "./ask.js";

const RANGES = [["all", "All time"], ["90", "90 days"], ["30", "30 days"], ["7", "7 days"]];
const TRUST = ["solid", "mixed", "shaky"]; // best first, like every source's verdicts
const SHARED_COLOR = "var(--shared)"; // concepts several sources cover, and the concept line
const READING_WPM = 230;

const sum = (items, fn) => items.reduce((total, item) => total + (fn(item) || 0), 0);
const searchLink = (q) => { location.hash = `#/search?q=${encodeURIComponent(q)}`; };
const many = (n, s) => plural(n, s.one, s.many); // "3 videos", "1 post"
const cap = (text) => text[0].toUpperCase() + text.slice(1);

// Choices made on a card, kept while the page is open (the grid is rebuilt when the vault changes).
const picked = { concepts: null, recent: "all" };

export function mount(root, params) {
  let range = validRange(params.get("range"));
  const subtitle = el("p");
  const seg = el("div", { class: "segmented", role: "group", "aria-label": "Date range" });
  const grid = el("div", { class: "grid" });
  const ask = askBox();
  root.append(el("div", { class: "view-head" },
    el("div", {}, el("h1", { text: "Dashboard" }), subtitle), el("div", { class: "spacer" }), seg), ask.node, grid);

  let width = 0;
  const render = () => {
    setChildren(seg, ...RANGES.map(([key, label]) => el("button", {
      type: "button", "aria-pressed": String(key === range),
      onclick: () => { location.hash = key === "all" ? "#/" : `#/?range=${key}`; },
    }, label)));
    if (!store.brain) {
      setChildren(grid, el("p", { class: "empty span-12",
        text: store.error ? "Can't reach the Feed Brain server. Is start.cmd running?" : "Reading the vault…" }));
      return;
    }
    const scope = slice(store.brain, range);
    subtitle.textContent = scope.label;
    setChildren(grid, ...cards(scope));
    width = grid.clientWidth;
    drawPlots(grid);
  };
  const resize = new ResizeObserver(debounce(() => {
    if (grid.clientWidth !== width) {
      width = grid.clientWidth;
      drawPlots(grid);
    }
  }, 120));
  resize.observe(grid);
  const off = onBrain(render);
  render();
  return {
    update(p) {
      const next = validRange(p.get("range"));
      if (next !== range) {
        range = next;
        render();
      }
    },
    unmount() {
      off();
      resize.disconnect();
      ask.asker.destroy();
      hideTip();
    },
  };
}

// Ask the brain right here: the answer shows under the box. It lives outside the grid,
// which is rebuilt whenever the vault changes, so an answer in progress is never wiped.
function askBox() {
  const input = el("input", { type: "search", placeholder: "Ask your brain…  e.g. which video showed radar seeing through walls? or: that post about Claude skills?",
    autocomplete: "off", spellcheck: "false", "aria-label": "Ask the brain" });
  const asker = createAsk({ compact: true, onPick: (q) => { input.value = q; input.focus(); } });
  const node = el("section", { class: "dash-ask" },
    el("form", {
      class: "search-box",
      onsubmit: (e) => {
        e.preventDefault();
        if (input.value.trim()) asker.ask(input.value);
      },
    }, searchIcon(), input, el("button", { class: "btn primary syntax", type: "submit", text: "Ask" })),
    asker.node);
  return { node, asker };
}

function validRange(value) {
  return RANGES.some(([key]) => key === value) ? value : "all";
}

// Everything the cards need, cut to the selected range (and the same-length period before it).
function slice(brain, range) {
  const today = isoDay(Date.now());
  const days = range === "all" ? null : Number(range);
  const since = days ? addDays(today, -(days - 1)) : null;
  const prevSince = days ? addDays(since, -days) : null;
  const day = (stamp) => (stamp || "").slice(0, 10);
  const inRange = (stamp) => Boolean(day(stamp)) && (!since || day(stamp) >= since);
  const inPrev = (stamp) => Boolean(days && day(stamp)) && day(stamp) >= prevSince && day(stamp) < since;
  const first = brain.notes.map((n) => n.captured).filter(Boolean).sort()[0] || today;
  const notes = brain.notes.filter((n) => inRange(n.captured));
  const prevNotes = brain.notes.filter((n) => inPrev(n.captured));
  return {
    brain, today, days, since, first,
    sources: brain.sources,
    label: days
      ? `Last ${days} days · ${fmtDay(since)} – ${fmtDay(today)}`
      : `Everything since your first capture on ${fmtDay(first, { year: true })}`,
    rangeName: days ? `the last ${days} days` : "all time",
    notes, prevNotes,
    of: (kind, list = notes) => list.filter((n) => n.kind === kind), // one source's notes in the range
    concepts: brain.concepts.filter((c) => inRange(c.created)),
    prevConcepts: brain.concepts.filter((c) => inPrev(c.created)),
    log: brain.log.filter((e) => inRange(e.time)),
    runs: brain.runs.filter((r) => inRange(r.created)),
  };
}

function cards(s) {
  return [
    heroCard(s), kpiCard(s),
    capturesCard(s), qualityCard(s),
    conceptsCard(s), topicsCard(s),
    growthCard(s), calendarCard(s),
    peopleCard(s), tagsCard(s), attentionCard(s),
    recentCard(s), el("div", { class: "stack span-4" }, rediscoverCard(s), runsCard(s)),
  ];
}

// ------------------------------------------------------------ card + plot plumbing

function card({ title, sub, span = 6, table, cls = "" }, ...content) {
  const body = el("div", {}, ...content);
  let tableNode = null;
  const toggle = table && el("button", {
    class: "toggle", type: "button", text: "Table",
    onclick: () => {
      tableNode ||= section.appendChild(dataTable(table()));
      const showTable = !body.hidden;
      body.hidden = showTable;
      tableNode.hidden = !showTable;
      toggle.textContent = showTable ? "Chart" : "Table";
      if (!showTable) drawPlots(body);
    },
  });
  const section = el("section", { class: `card span-${span} ${cls}` },
    el("div", { class: "card-head" }, el("h2", { text: title }), sub && el("span", { class: "sub", text: sub }),
      el("div", { class: "spacer" }), toggle),
    body);
  return section;
}

function dataTable({ columns, rows }) {
  return el("div", { class: "table-wrap" }, el("table", { class: "data" },
    el("thead", {}, el("tr", {}, columns.map((c) => el("th", { class: c.num ? "num" : null, text: c.label })))),
    el("tbody", {}, rows.map((row) => el("tr", {}, row.map((cell, i) =>
      el("td", { class: columns[i].num ? "num" : null, text: String(cell ?? "") })))))));
}

// A small filter in a card's head: buttons, one pressed.
function cardFilter(label, options, current, onPick) {
  return el("div", { class: "segmented small", role: "group", "aria-label": label },
    options.map(([key, text]) => el("button", {
      type: "button", "aria-pressed": String(key === current), onclick: () => onPick(key),
    }, text)));
}

function legend(series, { line = false } = {}) {
  return el("div", { class: "legend" }, series.map((x) =>
    el("span", {}, el("i", { class: line ? "line" : "sw", style: { background: x.color } }), x.label)));
}

// A chart that draws itself at its container's width, and again when that changes.
function plot(draw) {
  const node = el("div", { class: "plot" });
  node.draw = draw;
  return node;
}

function drawPlots(root) {
  root.querySelectorAll(".plot").forEach((p) => {
    if (p.offsetParent !== null && p.clientWidth) setChildren(p, p.draw(p.clientWidth));
  });
}

// Whether cards sit side by side: below 1100px (app.css) a span-8 card takes the whole row.
const wide = () => !matchMedia("(max-width: 1100px)").matches;

function niceTicks(max, count = 4) {
  const raw = Math.max(1, max) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= raw));
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  return ticks;
}

function roundedTop(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function yAxis(root, ticks, y, left, right) {
  ticks.forEach((t) => root.append(
    svg("line", { class: t ? "grid-line" : "baseline", x1: left, x2: right, y1: y(t), y2: y(t) }),
    svg("text", { x: left - 8, y: y(t) + 3.5, "text-anchor": "end", text: fmt(t) })));
}

// Stacked columns, one per bucket. Each column is its own hover target.
function columns(width, data, series, { height = 196, capLabels = false, ariaLabel = "" } = {}) {
  const padL = 30, padR = 4, padT = capLabels ? 18 : 10, padB = 24;
  const plotW = Math.max(40, width - padL - padR), plotH = height - padT - padB;
  const totals = data.map((d) => sum(series, (s) => d.values[s.key]));
  const ticks = niceTicks(Math.max(...totals, 1));
  const max = ticks.at(-1);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const band = plotW / data.length;
  const bw = Math.max(2, Math.min(24, band - 2, band * 0.72));
  const root = svg("svg", { class: "chart", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": ariaLabel });
  yAxis(root, ticks, y, padL, width - padR);
  const every = Math.max(1, Math.ceil(52 / band));
  data.forEach((d, i) => {
    const x = padL + i * band + (band - bw) / 2;
    const col = svg("g", { class: "col" });
    const parts = series.filter((s) => d.values[s.key] > 0);
    let base = y(0);
    parts.forEach((s, j) => {
      const top = y(totals[i] - sum(parts.slice(j + 1), (p) => d.values[p.key]));
      const bottom = base - (j > 0 ? 2 : 0); // 2px surface gap between stacked segments
      const h = Math.max(0.75, bottom - top);
      col.append(j === parts.length - 1
        ? svg("path", { d: roundedTop(x, bottom - h, bw, h), style: { fill: s.color } })
        : svg("rect", { x, y: bottom - h, width: bw, height: h, style: { fill: s.color } }));
      base = top;
    });
    if (capLabels && totals[i]) {
      col.append(svg("text", { class: "value-label", x: x + bw / 2, y: y(totals[i]) - 5, "text-anchor": "middle", text: fmt(totals[i]) }));
    }
    const hit = svg("rect", { class: "hit", x: padL + i * band, y: padT, width: band, height: plotH + padB });
    hit.addEventListener("pointermove", (e) => {
      root.classList.add("hovering");
      col.classList.add("hover");
      showTip(e, el("div", { class: "tt-head", text: d.title || d.label }),
        series.length > 1
          ? [...series.map((s) => tipRow(s.color, d.values[s.key] || 0, s.label, { box: true })), tipRow(null, totals[i], "total")]
          : tipRow(null, totals[i], series[0].label));
    });
    hit.addEventListener("pointerleave", () => {
      root.classList.remove("hovering");
      col.classList.remove("hover");
      hideTip();
    });
    root.append(col);
    if (i % every === 0) {
      root.append(svg("text", { x: padL + i * band + band / 2, y: height - 6, "text-anchor": "middle", text: d.label }));
    }
    root.append(hit);
  });
  return root;
}

// Lines over days, with a crosshair that snaps to the nearest day and reads every series.
function lines(width, dates, series, { height = 210, ariaLabel = "" } = {}) {
  const padL = 30, padR = 96, padT = 12, padB = 24;
  const plotW = Math.max(40, width - padL - padR), plotH = height - padT - padB;
  const n = dates.length;
  const ticks = niceTicks(Math.max(1, ...series.flatMap((s) => s.values)));
  const max = ticks.at(-1);
  const x = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const root = svg("svg", { class: "chart", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": ariaLabel });
  yAxis(root, ticks, y, padL, padL + plotW);
  const labelAt = [...new Set([0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1])];
  labelAt.forEach((i, k) => root.append(svg("text", {
    x: x(i), y: height - 6, "text-anchor": k === 0 ? "start" : k === labelAt.length - 1 ? "end" : "middle", text: fmtDay(dates[i]) })));

  // End labels where they don't collide; the legend names every line anyway.
  const ends = series.map((s) => y(s.values.at(-1)));
  const placed = [];
  series.forEach((s, k) => {
    root.append(svg("path", {
      d: s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(""),
      fill: "none", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", style: { stroke: s.color } }));
    root.append(svg("circle", { class: "dot", cx: x(n - 1), cy: ends[k], r: 4, style: { fill: s.color } }));
    if (placed.every((other) => Math.abs(other - ends[k]) >= 15)) {
      placed.push(ends[k]);
      root.append(svg("text", { class: "end-label", x: x(n - 1) + 9, y: ends[k] + 4 },
        svg("tspan", { text: fmt(s.values.at(-1)) }), svg("tspan", { class: "muted", text: ` ${s.label}` })));
    }
  });

  const cross = svg("line", { class: "crosshair", y1: padT, y2: padT + plotH, visibility: "hidden" });
  const dots = series.map((s) => svg("circle", { class: "dot", r: 4, visibility: "hidden", style: { fill: s.color } }));
  const hit = svg("rect", { class: "hit", x: padL, y: padT, width: plotW, height: plotH });
  hit.addEventListener("pointermove", (e) => {
    const px = e.clientX - root.getBoundingClientRect().left;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / plotW) * (n - 1))));
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    dots.forEach((d, k) => {
      d.setAttribute("cx", x(i));
      d.setAttribute("cy", y(series[k].values[i]));
      d.setAttribute("visibility", "visible");
    });
    showTip(e, el("div", { class: "tt-head", text: fmtDay(dates[i], { year: true }) }),
      series.map((s) => tipRow(s.color, fmt(s.values[i]), s.label)));
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    hideTip();
  });
  root.append(cross, ...dots, hit);
  return root;
}

// Horizontal bars with the value at the tip; each row is a link. A row with `segments`
// is stacked (videos | posts), with a 2px gap between the parts and its own tooltip.
function bars(items, { color = "var(--s1)" } = {}) {
  if (!items.length) return el("p", { class: "empty", text: "Nothing in this period." });
  const max = Math.max(...items.map((d) => d.value));
  return el("div", { class: "bars" }, items.map((d) => {
    const parts = (d.segments || []).filter((x) => x.value > 0);
    const bar = parts.length
      ? el("div", { class: "bar split", style: { width: `${(d.value / max) * 100}%` },
        onpointermove: (e) => showTip(e, el("div", { class: "tt-head", text: d.label }),
          parts.map((x) => tipRow(x.color, x.value, x.label, { box: true }))),
        onpointerleave: hideTip,
      }, parts.map((x) => el("span", { style: { flex: String(x.value), background: x.color } })))
      : el("div", { class: "bar", style: { width: `${(d.value / max) * 100}%`, background: d.color || color } });
    return el("div", {
      class: "row", role: "link", tabindex: "0", title: d.title || d.label,
      onclick: d.onclick, onkeydown: (e) => { if (e.key === "Enter") d.onclick?.(); },
    },
    el("span", { class: "name" }, d.swatch && el("span", { class: "sw", style: { background: d.swatch, marginRight: "7px", verticalAlign: "-1px" } }), d.label),
    el("div", { class: "track" }, bar),
    el("span", { class: "num", text: fmt(d.value) }));
  }));
}

// A thin stacked bar for a table cell: one part per source, as wide as its count.
function inlineStack(parts, unit) {
  return el("span", { class: "inline-stack" }, parts.filter((x) => x.value > 0).map((x) =>
    el("span", { style: { width: `${Math.max(3, x.value * unit)}px`, background: x.color } })));
}

// ------------------------------------------------------------ headline

function heroCard(s) {
  // Any source with a length (videos; reels one day). Only notes with a known length count on
  // both sides, or notes without one would add reading time with no watching time to set it against.
  const timed = s.notes.filter((n) => n.duration_s > 0);
  const untimed = s.notes.filter((n) => !n.duration_s && sourceOf(n.kind)?.format === "video").length;
  const watched = sum(timed, (n) => n.duration_s);
  const readSeconds = (sum(timed, (n) => n.words) / READING_WPM) * 60;
  const watch = fmtHours(watched), read = fmtHours(readSeconds);
  const saved = watched ? Math.max(0, Math.round((1 - readSeconds / watched) * 100)) : 0;
  const what = s.sources.map((src) => [src, s.of(src.key, timed).length]).filter(([, n]) => n)
    .map(([src, n]) => many(n, src)).join(" and ");
  return el("section", { class: "card hero span-4" },
    el("div", { class: "label", text: "Watching distilled into notes" }),
    el("div", { class: "figure" }, `${watch.value}`, el("small", { text: ` ${watch.unit}` }),
      el("span", { class: "arrow", text: "→" }), `${read.value}`, el("small", { text: ` ${read.unit}` })),
    el("div", { class: "note", text: timed.length
      ? `${what} of watching, read in ${read.value} ${read.unit}: ${saved}% of the time saved.`
        + (untimed ? ` ${untimed} without a known length left out.` : "")
      : "Nothing with a known length captured in this period." }));
}

// The sources that link a concept, and whether it's shared (two sources or more).
const coveredBy = (s, c) => s.sources.filter((src) => c.sources[src.key]?.length);
const isShared = (s, c) => coveredBy(s, c).length > 1;

function kpiCard(s) {
  const all = s.brain;
  const weekAgo = addDays(s.today, -6);
  const change = (now, before, recent) => {
    if (s.days) {
      const d = now - before;
      return el("div", { class: `delta${d > 0 ? " up" : ""}`, text: `${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmt(Math.abs(d))} vs previous ${s.days} days` });
    }
    return el("div", { class: `delta${recent > 0 ? " up" : ""}`, text: `+${fmt(recent)} in the last 7 days` });
  };
  const claims = s.notes.flatMap((n) => n.claims);
  const flagged = claims.filter((c) => c.flag).length;
  // A shared concept counts in a period when one of its notes was captured in it.
  const inScope = new Set(s.notes.map((n) => n.id));
  const shared = all.concepts.filter((c) => isShared(s, c)).filter((c) => !s.days || c.notes.some((id) => inScope.has(id)));
  const tile = (label, value, ...below) => el("div", { class: "tile" },
    el("div", { class: "label", text: label }), el("div", { class: "value", text: value }), below);
  return el("section", { class: "card span-8" }, el("div", { class: "tiles" },
    // One tile per source, with how many of its notes got its low verdict.
    s.sources.map((src) => {
      const notes = s.of(src.key);
      const low = notes.filter((n) => n.verdict === src.low).length;
      return tile(src.title, fmt(notes.length),
        change(notes.length, s.of(src.key, s.prevNotes).length, all.byKind.get(src.key).filter((n) => n.captured >= weekAgo).length),
        notes.length > 0 && el("div", { class: "delta", text: `${fmt(low)} ${src.low_label}` }));
    }),
    tile(s.days ? "New concepts" : "Concepts", fmt(s.concepts.length), change(s.concepts.length, s.prevConcepts.length,
      all.concepts.filter((c) => c.created >= weekAgo).length)),
    tile(s.sources.length === 2 ? `In ${s.sources[0].many} and ${s.sources[1].many}` : "In several sources", fmt(shared.length),
      el("div", { class: "delta", text: s.days ? "shared concepts touched" : `of ${plural(all.concepts.length, "concept")}` })),
    tile("Claims", fmt(claims.length), el("div", { class: "delta", text: `${fmt(flagged)} flagged by the web check` }))));
}

// ------------------------------------------------------------ captures over time

// Two series per source: its notes, and those with its low verdict (skipped videos, noise
// posts) in the lightest step of its ramp, stacked on top.
function captureSeries(s) {
  return s.sources.flatMap((src) => [
    { key: src.key, label: src.many, color: src.color },
    { key: `${src.key}:low`, label: `${src.low_label} ${src.many}`, color: src.ramp(3), low: true },
  ]);
}

function captureBuckets(s) {
  const start = s.since || s.first;
  const span = daysBetween(start, s.today) + 1;
  const unit = span <= 31 ? "day" : span <= 26 * 7 ? "week" : "month";
  const startOf = (day) => {
    if (unit === "day") return day;
    if (unit === "month") return `${day.slice(0, 7)}-01`;
    const [y, m, d] = day.split("-").map(Number);
    return addDays(day, -((new Date(y, m - 1, d).getDay() + 6) % 7)); // Monday
  };
  const next = (day) => {
    if (unit === "day") return addDays(day, 1);
    if (unit === "week") return addDays(day, 7);
    const [y, m] = day.split("-").map(Number);
    return isoDay(new Date(y, m, 1));
  };
  const out = [];
  for (let b = startOf(start); b <= s.today; b = next(b)) {
    out.push({
      start: b, label: unit === "month" ? fmtDay(b).split(" ")[0] : fmtDay(b),
      title: unit === "week" ? `Week of ${fmtDay(b, { year: true })}` : unit === "month" ? `${fmtDay(b).split(" ")[0]} ${b.slice(0, 4)}` : fmtDay(b, { year: true }),
      values: {},
    });
  }
  for (const n of s.notes) {
    const bucket = out.findLast((b) => b.start <= n.captured);
    if (bucket) {
      const key = n.verdict === sourceOf(n.kind)?.low ? `${n.kind}:low` : n.kind;
      bucket.values[key] = (bucket.values[key] || 0) + 1;
    }
  }
  return { buckets: out, unit };
}

function capturesCard(s) {
  const { buckets, unit } = captureBuckets(s);
  // Every source is named; its low-verdict series once there is one, for every source alike.
  const series = captureSeries(s).filter((x) => !x.low || buckets.some((b) => b.values[x.key]));
  return card({
    title: "Captures", sub: `per ${unit}, by source and verdict`, span: 8,
    table: () => ({
      columns: [{ label: cap(unit) }, ...series.map((x) => ({ label: x.label, num: true })), { label: "total", num: true }],
      rows: buckets.filter((b) => sum(series, (x) => b.values[x.key])).map((b) =>
        [b.title, ...series.map((x) => b.values[x.key] || 0), sum(series, (x) => b.values[x.key])]),
    }),
  },
  legend(series),
  // Beside the Quality card, as tall as it: that card grows by two bars (verdict, trust) per source.
  // Alone on its row, shorter.
  plot((w) => columns(w, buckets, series, { height: wide() ? 230 + 90 * s.sources.length : 240,
    ariaLabel: `Notes captured per ${unit}, by source and verdict` })));
}

// ------------------------------------------------------------ quality

// For each source, its verdicts and its trust, on its own ramp.
function qualityCard(s) {
  const rows = s.sources.flatMap((src) => [
    { label: `${cap(src.one)} verdict`, src, field: "verdict", classes: src.verdicts },
    { label: `${cap(src.one)} trust`, src, field: "trust", classes: TRUST },
  ]).map((r) => {
    const notes = s.of(r.src.key);
    const counts = r.classes.map((c) => notes.filter((n) => n[r.field] === c).length);
    const colors = r.classes.map((c, i) => classColor(r.src, i, r.classes.length));
    return { ...r, counts, colors, total: sum(counts, (x) => x) };
  });
  const signal = [1, 2, 3, 4, 5].map((n) => ({ label: String(n), title: `Signal ${n}/5`,
    values: Object.fromEntries(s.sources.map((src) => [src.key, s.of(src.key).filter((x) => x.signal === n).length])) }));
  const series = s.sources.map((src) => ({ key: src.key, label: src.many, color: src.color }));
  return card({
    title: "Quality", sub: s.sources.map((src) => many(s.of(src.key).length, src)).join(" · "), span: 4,
    table: () => ({
      columns: [{ label: "Field" }, { label: "Value" }, { label: "Notes", num: true }, { label: "Share", num: true }],
      rows: [
        ...rows.flatMap((r) => r.classes.map((c, i) => [r.label, c, r.counts[i], r.total ? `${Math.round((r.counts[i] / r.total) * 100)}%` : "–"])),
        ...s.sources.flatMap((src) => signal.map((d) => [`${cap(src.one)} signal`, d.label, d.values[src.key], ""])),
      ],
    }),
  },
  el("div", { class: "mix" }, rows.map((r) => el("div", { class: "mix-row" },
    el("div", { class: "mix-label", text: r.label }),
    r.total
      ? el("div", { class: "mix-bar" }, r.classes.map((c, i) => r.counts[i] > 0 && el("span", {
        style: { flex: String(r.counts[i]), background: r.colors[i] },
        onpointermove: (e) => showTip(e, tipRow(r.colors[i], r.counts[i], `${c} · ${Math.round((r.counts[i] / r.total) * 100)}%`, { box: true })),
        onpointerleave: hideTip,
      })))
      : el("div", { class: "muted small", text: "None in this period" }),
    r.total > 0 && el("div", { class: "mix-keys" }, r.classes.map((c, i) => el("span", {},
      el("i", { class: "sw", style: { background: r.colors[i], width: "8px", height: "8px" } }), c, el("b", { text: String(r.counts[i]) })))))),
  el("div", { class: "mix-label", style: { marginTop: "4px" }, text: "Signal (1–5)" })),
  plot((w) => columns(w, signal, series, { height: 120, capLabels: true, ariaLabel: "Notes by signal rating, by source" })));
}

// ------------------------------------------------------------ the concept layer

// The day a concept last got a new note.
function lastSeen(brain, c) {
  return c.notes.map((id) => brain.byId.get(id)?.captured).filter(Boolean).sort().at(-1) || c.updated;
}

// Where the sources meet: how many concepts each source reaches alone, and the ones several share.
function conceptsCard(s) {
  const brain = s.brain;
  const sharedLabel = s.sources.length === 2 ? "in both" : "in several";
  const groups = { shared: brain.concepts.filter((c) => isShared(s, c)) };
  for (const src of s.sources) {
    groups[src.key] = brain.concepts.filter((c) => { const by = coveredBy(s, c); return by.length === 1 && by[0] === src; });
  }
  // The first source, the shared ones, then the others: with two sources the shared part sits between them.
  const [firstSource, ...otherSources] = s.sources;
  const only = (src) => ({ key: src.key, label: `only in ${src.many}`, color: src.color, n: groups[src.key].length });
  const parts = [firstSource && only(firstSource), { key: "shared", label: sharedLabel, color: SHARED_COLOR, n: groups.shared.length },
    ...otherSources.map(only)].filter(Boolean);
  const total = sum(parts, (p) => p.n);
  const inScope = new Set(s.notes.map((n) => n.id));
  const coverage = el("div", { class: "coverage" });
  const list = el("div");
  const filter = el("div", { class: "card-filter" });
  const note = el("p", { class: "muted small", style: { margin: "10px 0 0" } });

  const show = (view) => {
    picked.concepts = view;
    const pool = view === "all" ? brain.concepts : groups[view] || [];
    let rows = pool.map((c) => ({ c, total: c.notes.length, last: lastSeen(brain, c) }));
    if (s.days) rows = rows.filter((r) => r.c.notes.some((id) => inScope.has(id)));
    rows.sort((a, b) => b.total - a.total || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || a.c.name.localeCompare(b.c.name));
    const shown = rows.slice(0, 8);
    const unit = 70 / Math.max(1, ...shown.flatMap((r) => s.sources.map((src) => r.c.sources[src.key]?.length || 0)));
    setChildren(filter, cardFilter("Which concepts", [
      ["shared", `${cap(sharedLabel)} ${groups.shared.length}`],
      ...[...otherSources, firstSource].filter(Boolean).map((src) => [src.key, `Only ${src.many} ${groups[src.key].length}`]),
      ["all", "All"],
    ], view, show));
    coverage.querySelectorAll("[data-key]").forEach((seg) => seg.classList.toggle("dim", view !== "all" && seg.dataset.key !== view));
    setChildren(list, shown.length
      ? el("div", { class: "table-wrap" }, el("table", { class: "data" },
        el("thead", {}, el("tr", {}, el("th", { text: "Concept" }), s.sources.map((src) => el("th", { text: cap(src.many) })),
          el("th", { class: "num", text: "Last seen" }))),
        el("tbody", {}, shown.map(({ c, last }) => el("tr", { class: "click", onclick: () => openNote(c.id), title: c.summary },
          el("td", {}, el("span", { class: "sw round", style: { background: clusterColor(c.cluster), marginRight: "8px", width: "8px", height: "8px" } }), c.name),
          s.sources.map((src) => {
            const n = c.sources[src.key]?.length || 0;
            return el("td", {}, inlineStack([{ value: n, color: src.color }], unit), String(n));
          }),
          el("td", { class: "num", text: fmtDay(last) }))))))
      : el("p", { class: "empty", text: view === "shared"
        ? `No concept is ${sharedLabel} yet. When a note from one source covers an idea another one brought, it shows up here.`
        : "None in this period." }));
    const source = sourceOf(view);
    // The same group in the graph: its view of the shared concepts, or of one source.
    const graphView = view === "all" ? "" : `?view=${view}`;
    setChildren(note, (view === "shared" ? "Ideas you met in more than one source. Open one to compare what each said."
      : view === "all" ? "Every concept, most covered first."
        : `Ideas only ${source?.label}s brought so far, most covered first.`)
      + (rows.length > shown.length ? ` Showing ${shown.length} of ${rows.length}.` : "") + " ",
    el("a", { href: `#/graph${graphView}`, text: "See them in the graph →" }));
  };

  setChildren(coverage,
    el("div", { class: "mix-bar" }, parts.map((p) => p.n > 0 && el("span", {
      dataset: { key: p.key }, style: { flex: String(p.n), background: p.color }, role: "button", tabindex: "0",
      onclick: () => show(p.key), onkeydown: (e) => { if (e.key === "Enter") show(p.key); },
      onpointermove: (e) => showTip(e, tipRow(p.color, p.n, `${p.label} · ${Math.round((p.n / total) * 100)}%`, { box: true })),
      onpointerleave: hideTip,
    }))),
    el("div", { class: "mix-keys" }, parts.map((p) => el("span", {},
      el("i", { class: "sw", style: { background: p.color, width: "8px", height: "8px" } }), p.label, el("b", { text: fmt(p.n) })))));
  const section = card({
    title: "The concept layer", sub: `where your ${s.sources.map((src) => src.label + "s").join(" and ")} meet`, span: 7,
    table: () => ({
      columns: [{ label: "Concept" }, ...s.sources.map((src) => ({ label: src.many, num: true })), { label: "Last seen" }],
      rows: [...brain.concepts].sort((a, b) => b.notes.length - a.notes.length)
        .map((c) => [c.name, ...s.sources.map((src) => c.sources[src.key]?.length || 0), lastSeen(brain, c)]),
    }),
  }, coverage, filter, list, note);
  const remembered = picked.concepts && (picked.concepts === "all" || groups[picked.concepts]) ? picked.concepts : null;
  show(remembered || (groups.shared.length ? "shared" : "all"));
  return section;
}

// One stacked part per source, for a bar or a tooltip.
const segmentsOf = (s, counts) => s.sources.map((src) => ({ label: src.many, value: counts[src.key] || 0, color: src.color }));

function topicsCard(s) {
  const counts = new Map();
  const loose = {};
  for (const n of s.notes) {
    const cluster = s.brain.clusterById.get(n.cluster);
    if (!cluster) continue;
    if (cluster.loose) {
      loose[n.kind] = (loose[n.kind] || 0) + 1;
      continue;
    }
    if (!counts.has(cluster.id)) counts.set(cluster.id, { cluster, n: 0, by: {} });
    const x = counts.get(cluster.id);
    x.n++;
    x.by[n.kind] = (x.by[n.kind] || 0) + 1;
  }
  const items = [...counts.values()].sort((a, b) => b.n - a.n || b.cluster.size - a.cluster.size).slice(0, 9);
  const looseNotes = s.sources.filter((src) => loose[src.key]).map((src) => many(loose[src.key], src));
  const looseCount = sum(Object.values(loose), (x) => x);
  return card({
    title: "Topics", sub: `notes per topic cluster · ${s.rangeName}`, span: 5,
    table: () => ({ columns: [{ label: "Topic" }, { label: "Main concept" }, ...s.sources.map((src) => ({ label: src.many, num: true })),
      { label: "Concepts in cluster", num: true }],
    rows: items.map((x) => [x.cluster.label, x.cluster.hub || "", ...s.sources.map((src) => x.by[src.key] || 0), x.cluster.concepts]) }),
  },
  legend(s.sources.map((src) => ({ label: src.many, color: src.color }))),
  bars(items.map((x) => ({
    label: x.cluster.label, value: x.n, swatch: clusterColor(x.cluster.id), segments: segmentsOf(s, x.by),
    title: `${x.cluster.label}: ${x.cluster.hub ? `around "${x.cluster.hub}", ` : ""}${plural(x.cluster.concepts, "concept")}. Click to see it in the graph.`,
    onclick: () => { location.hash = `#/graph?cluster=${x.cluster.id}`; },
  }))),
  el("p", { class: "muted small", style: { margin: "12px 0 0" },
    text: `Clusters come from the links between notes. Click one to see it in the graph.${looseCount
      ? ` ${looseNotes.join(" and ")} link${looseCount === 1 ? "s" : ""} to no concept yet (low verdicts, mostly).` : ""}` }));
}

// ------------------------------------------------------------ growth and calendar

function growthCard(s) {
  const start = s.since || s.first;
  const all = daysBetween(start, s.today) + 1;
  const step = all > 400 ? 7 : 1;
  const dates = [];
  for (let i = 0; i < all; i += step) dates.push(addDays(start, i));
  if (dates.at(-1) !== s.today) dates.push(s.today);
  const cumulative = (stamps) => {
    const sorted = stamps.filter(Boolean).sort();
    let k = 0;
    return dates.map((d) => {
      while (k < sorted.length && sorted[k] <= d) k++;
      return k;
    });
  };
  const series = [
    { label: "concepts", color: SHARED_COLOR, values: cumulative(s.brain.concepts.map((c) => c.created)) },
    ...s.sources.map((src) => ({ label: src.many, color: src.color, values: cumulative(s.brain.byKind.get(src.key).map((n) => n.captured)) })),
  ];
  return card({
    title: "Knowledge growth", sub: "notes in the vault, cumulative", span: 6,
    table: () => ({
      columns: [{ label: "Date" }, ...series.map((x) => ({ label: x.label, num: true }))],
      rows: dates.map((d, i) => [d, ...series.map((x) => x.values[i])])
        .filter((row, i, rows) => i === rows.length - 1 || row.slice(1).join() !== rows[i + 1].slice(1).join()),
    }),
  },
  legend(series, { line: true }),
  plot((w) => lines(w, dates, series, { ariaLabel: "Concepts and notes of each source in the vault over time" })));
}

function calendarCard(s) {
  const spanDays = s.days || daysBetween(s.first, s.today) + 1;
  const weeks = Math.max(14, Math.min(53, Math.ceil(spanDays / 7) + 1));
  const [y, m, d] = s.today.split("-").map(Number);
  const start = addDays(s.today, -((new Date(y, m - 1, d).getDay() + 6) % 7) - (weeks - 1) * 7);
  const byDay = new Map();
  for (const n of s.brain.notes) {
    if (!n.captured) continue;
    if (!byDay.has(n.captured)) byDay.set(n.captured, []);
    byDay.get(n.captured).push(n);
  }
  const active = [...byDay.entries()].filter(([day]) => day >= start).sort();
  const bin = (n) => Math.min(4, n);

  const draw = (width) => {
    const left = 30, top = 18, gap = 3;
    const cell = Math.max(8, Math.min(15, Math.floor((width - left) / weeks) - gap));
    const height = top + 7 * (cell + gap);
    const root = svg("svg", { class: "chart", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Notes captured per day" });
    ["Mon", "Wed", "Fri"].forEach((label, i) => root.append(svg("text", { x: 0, y: top + (i * 2) * (cell + gap) + cell - 2, text: label })));
    let lastMonth = "";
    for (let w = 0; w < weeks; w++) {
      const weekStart = addDays(start, w * 7);
      if (weekStart.slice(5, 7) !== lastMonth) {
        lastMonth = weekStart.slice(5, 7);
        if (w < weeks - 2) root.append(svg("text", { x: left + w * (cell + gap), y: 11, text: fmtDay(weekStart).split(" ")[0] }));
      }
      for (let k = 0; k < 7; k++) {
        const day = addDays(weekStart, k);
        if (day > s.today) break;
        const notes = byDay.get(day) || [];
        const outside = s.since && day < s.since;
        const rect = svg("rect", {
          class: "cell", x: left + w * (cell + gap), y: top + k * (cell + gap), width: cell, height: cell, rx: 2.5,
          style: { fill: `var(--q${bin(notes.length)})`, opacity: outside ? "0.35" : "1" },
        });
        rect.addEventListener("pointermove", (e) => {
          rect.classList.add("hover");
          showTip(e, el("div", { class: "tt-head", text: fmtDay(day, { year: true }) }),
            notes.length
              ? s.sources.map((src) => [src, s.of(src.key, notes).length]).filter(([, n]) => n)
                .map(([src, n]) => tipRow(src.color, n, n === 1 ? src.one : src.many, { box: true }))
              : tipRow(null, 0, "captures"),
            notes.length > 0 && el("ul", { class: "tt-list" }, notes.slice(0, 6).map((n) => el("li", { text: n.title }))));
        });
        rect.addEventListener("pointerleave", () => {
          rect.classList.remove("hover");
          hideTip();
        });
        rect.addEventListener("click", () => {
          if (notes.length) searchLink(`after:${day} before:${addDays(day, 1)} sort:new`);
        });
        root.append(rect);
      }
    }
    return root;
  };

  const streak = (() => {
    let n = 0;
    for (let day = s.today; byDay.has(day); day = addDays(day, -1)) n++;
    return n;
  })();
  return card({
    title: "Activity", sub: `${plural(active.length, "day")} with captures${streak > 1 ? ` · ${streak}-day streak` : ""}`, span: 6,
    table: () => ({ columns: [{ label: "Day" }, ...s.sources.map((src) => ({ label: src.many, num: true })), { label: "Titles" }],
      rows: active.reverse().map(([day, notes]) => [day, ...s.sources.map((src) => s.of(src.key, notes).length),
        notes.map((n) => n.title).join(" · ")]) }),
  },
  plot(draw),
  el("div", { class: "legend", style: { marginTop: "10px", marginBottom: "0" } },
    el("span", { text: "Less" }), [0, 1, 2, 3, 4].map((i) => el("i", { class: "sw", style: { background: `var(--q${i})` }, title: i === 4 ? "4 or more" : String(i) })),
    el("span", { text: "More · every source" })));
}

// ------------------------------------------------------------ people and tags

// Who you learn from, every source in one ranking: channels, authors…
function peopleCard(s) {
  const counts = new Map();
  for (const n of s.notes) {
    const name = n.channel || "Unknown";
    const key = `${n.kind}\n${name}`;
    counts.set(key, { kind: n.kind, name, n: (counts.get(key)?.n || 0) + 1 });
  }
  const items = [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 8);
  return card({ title: "Who you learn from", sub: s.sources.map((src) => `${src.by}s`).join(" and "), span: 4 },
    legend(s.sources.map((src) => ({ label: src.by_label, color: src.color }))),
    bars(items.map((x) => {
      const src = sourceOf(x.kind);
      return {
        label: x.name, value: x.n, color: src?.color,
        title: `${many(x.n, src)} from ${x.name}`,
        onclick: () => searchLink(`type:${x.kind} channel:"${x.name}"`),
      };
    })));
}

function tagsCard(s) {
  const counts = new Map();
  for (const n of s.notes) {
    for (const tag of n.tags) {
      if (!counts.has(tag)) counts.set(tag, { tag, n: 0, by: {} });
      const x = counts.get(tag);
      x.n++;
      x.by[n.kind] = (x.by[n.kind] || 0) + 1;
    }
  }
  const items = [...counts.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).slice(0, 8);
  return card({ title: "Tags", sub: "most used, by source", span: 4 },
    bars(items.map((x) => ({ label: `#${x.tag}`, value: x.n, segments: segmentsOf(s, x.by), onclick: () => searchLink(`tag:${x.tag}`) }))));
}

// ------------------------------------------------------------ attention

function attentionCard(s) {
  const issues = [];
  for (const e of s.log) {
    if (e.error) issues.push({ level: "critical", icon: "✕", label: "Failed run", text: `${e.title}: ${e.error}`, note: e.note });
    for (const w of e.warnings) issues.push({ level: "warning", icon: "⚠", label: "Warning", text: w, note: e.note });
  }
  for (const b of s.brain.broken_links) {
    issues.push({ level: "warning", icon: "⚠", label: "Broken link", text: `${b.from} → ${b.to}`, note: b.from });
  }
  for (const c of s.brain.concepts.filter((c) => !c.summary)) {
    issues.push({ level: "warning", icon: "⚠", label: "No summary", text: c.id, note: c.id });
  }
  const shown = issues.slice(0, 5);
  return card({ title: "Needs attention", sub: issues.length ? plural(issues.length, "item") : "", span: 4 },
    issues.length
      ? [shown.map((x) => el("div", { class: "status-row" },
        el("span", { class: `icon ${x.level}`, text: x.icon, "aria-hidden": "true" }),
        el("div", { class: "what" }, el("b", { text: `${x.label}: ` }),
          x.note ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); openNote(x.note); } }, x.text) : x.text))),
      issues.length > shown.length && el("p", { class: "muted small", text: `and ${issues.length - shown.length} more in _log.md` })]
      : el("div", { class: "status-row" }, el("span", { class: "icon good", text: "✓", "aria-hidden": "true" }),
        el("div", { class: "what" }, el("b", { text: "All clear. " }), "No warnings, failed runs or broken links in this period.")));
}

// ------------------------------------------------------------ recent, rediscover, runs

// What came in lately, from every source or one: what you saved on LinkedIn this week, say.
function recentCard(s) {
  const list = el("ul", { class: "list" });
  const filter = el("div");
  const show = (view) => {
    const source = sourceOf(view);
    picked.recent = source ? view : "all";
    const entries = s.log.filter((e) => !source || (e.note || "").startsWith(`${source.folder}/`)).slice(0, 9);
    setChildren(filter, cardFilter("Which captures", [["all", "All"], ...s.sources.map((src) => [src.key, cap(src.many)])], picked.recent, show));
    setChildren(list, entries.length ? entries.map((e) => {
      const n = e.note && s.brain.byId.get(e.note);
      const src = sourceOf(n?.kind) || s.sources.find((x) => (e.note || "").startsWith(`${x.folder}/`));
      const changes = [e.new && `${e.new} new`, e.updated && `${e.updated} updated`].filter(Boolean).join(" · ");
      const verdict = n?.verdict || (src?.verdicts.includes(e.status) ? e.status : null);
      return el("li", {},
        el("span", { class: "when", text: ago(e.time) }),
        n ? noteThumb(n) : el("div", { class: "thumb" }),
        el("div", { class: "grow" },
          el("span", { class: "title", text: n?.title || e.title, onclick: () => e.note && openNote(e.note), title: n?.spoiler || "" }),
          el("div", { class: "meta" }, verdictChip(verdict, src?.key),
            e.status === "failed" && el("span", { class: "chip", text: "failed" }),
            // Who it's from, unless the title already starts with it ("Ruben Hassid: …").
            n?.channel && !n.title.startsWith(n.channel) && el("span", { text: n.channel }),
            n?.action && el("span", { text: actionText(n.action) }),
            changes && el("span", { text: `${changes} concept${e.new + e.updated === 1 ? "" : "s"}` }),
            e.warnings.length > 0 && el("span", { class: "chip flag" }, el("span", { class: "icon", text: "⚠" }), plural(e.warnings.length, "warning")))));
    }) : el("p", { class: "empty", text: source ? `No ${source.label}s in this period.` : "No runs in this period." }));
  };
  const section = card({ title: "Recent captures", sub: "from _log.md", span: 8 }, list);
  section.querySelector(".card-head").append(filter);
  show(picked.recent);
  return section;
}

function rediscoverCard(s) {
  const weekAgo = addDays(s.today, -7);
  const notes = s.brain.notes.filter((n) => n.claims.length);
  const older = notes.filter((n) => n.captured && n.captured <= weekAgo);
  const pool = (older.length ? older : notes).flatMap((n) => n.claims.map((c) => ({ n, c })));
  const body = el("div", { class: "rediscover" });
  const pick = () => {
    if (!pool.length) {
      setChildren(body, el("p", { class: "empty", text: "Claims from your notes will show up here." }));
      return;
    }
    const { n, c } = pool[Math.floor(Math.random() * pool.length)];
    setChildren(body,
      el("blockquote", { text: c.text }),
      c.example && el("p", { class: "eg", text: `e.g. ${c.example}` }),
      el("div", { class: "from" }, tsLink(c.ts),
        el("a", { href: "#", onclick: (e) => { e.preventDefault(); openNote(n.id); } }, n.title),
        el("span", { text: `${sourceOf(n.kind)?.label || "note"}, captured ${ago(n.captured)} ago` })));
  };
  pick();
  const section = card({ title: "Rediscover", sub: "a claim from an older note", span: 12 }, body);
  section.querySelector(".card-head").append(el("button", { class: "toggle", type: "button", text: "Another", onclick: pick }));
  return section;
}

function runsCard(s) {
  const done = (runs) => runs.filter((r) => r.status === "done");
  const avg = (runs) => (done(runs).length ? sum(done(runs), (r) => r.seconds) / done(runs).length : 0);
  const time = (seconds) => (!seconds ? "–" : seconds < 90 ? `${Math.round(seconds)} s` : `${(seconds / 60).toFixed(1)} min`);
  const cost = (runs) => sum(runs, (r) => r.cost_usd);
  const bySource = s.sources.map((src) => ({ src, runs: s.runs.filter((r) => r.kind === src.key) })).filter((x) => x.runs.length);
  const failed = s.runs.filter((r) => r.status === "failed").length;
  const split = bySource.length > 1; // the per-source line, once there's more than one source
  const tile = (label, value, below) => el("div", { class: "tile" }, el("div", { class: "label", text: label }),
    el("div", { class: "value", style: { fontSize: "22px" }, text: value }), below && el("div", { class: "delta", text: below }));
  const [main] = bySource;
  return card({ title: "Runs on this computer", sub: "server/data/captures.jsonl", span: 12 },
    s.runs.length
      ? el("div", { class: "tiles", style: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))", rowGap: "12px" } },
        tile("Runs", fmt(s.runs.length), split ? bySource.map((x) => many(x.runs.length, x.src)).join(" · ") : null),
        tile("Failed", fmt(failed)),
        tile("Claude cost", `$${cost(s.runs).toFixed(2)}`, split ? bySource.map((x) => `$${cost(x.runs).toFixed(2)} ${x.src.many}`).join(" · ") : null),
        tile("Avg. run", time(avg(main.runs)),
          [`per ${main.src.one}`, ...bySource.slice(1).map((x) => `${time(avg(x.runs))} per ${x.src.one}`)].join(" · ")))
      : el("p", { class: "empty", text: "No runs logged here in this period." }));
}
