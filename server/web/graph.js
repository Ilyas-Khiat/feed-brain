// Graph: every concept and every source's note (video, LinkedIn post…) as a node, linked the way the notes link each other,
// coloured by topic cluster. Laid out in two levels, on a canvas, no libraries: each topic
// gets a round area sized to its notes, the areas are placed first (linked topics close,
// few crossing bundles, a gap between all of them), then the notes settle inside their own
// area. Links between two topics are drawn as one bundle through the gap between them.

import {
  el, setChildren, $, store, onBrain, cssVar, openNote, showTip, hideTip, plural, clusterColor, clusterVar, sourceOf, isoDay,
} from "./ui.js";

const positions = new Map(); // id -> {x, y}, kept across visits so the layout doesn't reshuffle
const LINK_LENGTH = { covers: 42, related: 66, shared: 56 };
const GAP = 22; // world units kept between two topics' areas: the room their links are bundled through
const RECENT_DAYS = 30;

// The graph's views: which notes and which concepts each shows. `note` is a test on a note, null
// (no notes: concepts are linked when a note covers both), or "covering" (the notes linked to the
// concepts shown); `concept` is a test on a concept, or "covered" (the concepts the notes shown
// link to). The source views come from the brain's sources (server/sources.py), so a new source
// gets its own view.
function viewsOf(brain) {
  const since = isoDay(Date.now() - (RECENT_DAYS - 1) * 86400000);
  const sharedBy = (c) => brain.sources.filter((src) => c.sources[src.key]?.length).length > 1;
  return [
    { key: "all", label: "Everything", about: "every note and every concept", note: () => true, concept: () => true },
    { key: "concepts", label: "Concepts only", about: "concepts alone, linked when a note covers both", note: null, concept: () => true },
    ...brain.sources.map((src) => ({
      key: src.key, label: src.many[0].toUpperCase() + src.many.slice(1),
      about: `${src.label}s and the concepts they cover`, note: (n) => n.kind === src.key, concept: "covered",
    })),
    brain.sources.length > 1 && {
      key: "shared", label: "Where they meet", about: "the concepts more than one source covers, with the notes behind them",
      note: "covering", concept: sharedBy,
    },
    { key: "recent", label: `Last ${RECENT_DAYS} days`, about: `what you captured in the last ${RECENT_DAYS} days and the concepts it covers`,
      note: (n) => (n.captured || "") >= since, concept: "covered" },
  ].filter(Boolean);
}

export function mount(root, params) {
  const opts = { view: "all", related: true, minLinks: 0 };
  let isolate = null, pendingFocus = null;
  let nodes = [], links = [], byId = new Map(), adj = new Map();
  let groups = new Map(); // cluster id -> its area: { id, n, r, x, y }
  let view = { k: 1, x: 0, y: 0 }; // screen = world * k + (x, y)
  let W = 0, H = 0, dpr = 1, alpha = 0, raf = 0, fitted = false;
  let viewTouched = false; // you zoomed, panned or a note was centred: resizing leaves the view alone
  let hover = null, selected = null, drag = null, colors = {};

  // ---------------------------------------------------------- DOM

  const find = el("input", { type: "search", placeholder: "Find a note…", list: "graph-names", "aria-label": "Find a note in the graph" });
  const names = el("datalist", { id: "graph-names" });
  const modeSeg = el("div", { class: "segmented", role: "group", "aria-label": "View" });
  const related = el("input", { type: "checkbox", checked: true });
  const minLinks = el("input", { type: "range", min: "0", max: "5", value: "0", "aria-label": "Minimum links" });
  const minLabel = el("span", { text: "0" });
  const tableBtn = el("button", { class: "btn", type: "button", text: "Table" });
  const canvas = el("canvas", { "aria-label": "Knowledge graph. Use the table view or search for a text version." });
  const ctx = canvas.getContext("2d");
  const stage = el("section", { class: "card graph-stage" }, canvas,
    el("div", { class: "graph-hint", text: "Scroll to zoom · drag the background to pan · drag a note to move it · hover a note for its name, click to open it" }),
    el("div", { class: "graph-zoom" },
      el("button", { class: "icon-btn", type: "button", title: "Zoom in", text: "+", onclick: () => zoomBy(1.35) }),
      el("button", { class: "icon-btn", type: "button", title: "Zoom out", text: "−", onclick: () => zoomBy(1 / 1.35) }),
      el("button", { class: "icon-btn", type: "button", title: "Fit to screen", text: "⤢", onclick: () => fit() })));
  const clusterList = el("ul", { class: "cluster-list" });
  const shapeKey = el("div", { class: "shape-key" }); // filled from the sources once the brain is read
  const sideHead = el("div", { class: "card-head" }, el("h2", { text: "Topics" }), el("span", { class: "sub" }));
  const side = el("aside", { class: "graph-side" }, el("section", { class: "card" }, sideHead, clusterList,
    shapeKey));
  const wrap = el("div", { class: "graph-wrap" }, stage, side);
  const tableView = el("section", { class: "card", hidden: true });
  const summary = el("p");

  root.append(
    el("div", { class: "view-head" }, el("div", {}, el("h1", { text: "Graph" }), summary)),
    el("div", { class: "graph-controls" }, find, names, modeSeg,
      el("label", {}, related, "Related links"),
      el("label", {}, "Min. links", minLinks, minLabel),
      el("div", { style: { flex: "1" } }),
      el("button", { class: "btn", type: "button", text: "Fit", onclick: () => fit() }), tableBtn),
    wrap, tableView);

  const renderMode = () => setChildren(modeSeg, ...(store.brain ? viewsOf(store.brain) : []).map((v) =>
    el("button", { type: "button", "aria-pressed": String(opts.view === v.key), title: `Show ${v.about}`, onclick: () => setView(v.key) }, v.label)));
  renderMode();
  related.addEventListener("change", () => { opts.related = related.checked; rebuild(); });
  minLinks.addEventListener("input", () => { opts.minLinks = Number(minLinks.value); minLabel.textContent = minLinks.value; rebuild(); });
  find.addEventListener("change", () => focusByName(find.value));
  find.addEventListener("keydown", (e) => { if (e.key === "Enter") focusByName(find.value); });
  tableBtn.addEventListener("click", () => {
    const showTable = tableView.hidden;
    tableView.hidden = !showTable;
    wrap.hidden = showTable;
    tableBtn.textContent = showTable ? "Graph" : "Table";
    if (showTable) renderTable();
    else resize();
  });

  // ---------------------------------------------------------- model

  // Read again on a theme change and on new data (the generated cluster colours are renumbered).
  function readColors() {
    colors = { surface: cssVar("--surface"), text: cssVar("--text"), text2: cssVar("--text-2"), edge: cssVar("--edge"),
      other: cssVar("--other"), muted: cssVar("--muted") };
  }
  const colorOf = (n) => {
    const name = clusterVar(store.brain.clusterById.get(n.cluster));
    return (colors[name] ||= cssVar(name)) || colors.other;
  };

  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return ((h >>> 0) % 10000) / 10000;
  }

  function rebuild() {
    const brain = store.brain;
    if (!brain) return;
    readColors();
    const views = viewsOf(brain);
    const current = views.find((v) => v.key === opts.view) || views[0];
    opts.view = current.key;
    renderMode();
    // The view's notes and concepts (see viewsOf).
    let notes = typeof current.note === "function" ? brain.notes.filter(current.note) : [];
    let concepts;
    if (current.concept === "covered") {
      const covered = new Set(notes.flatMap((n) => [...brain.neighbors.get(n.id)]));
      concepts = brain.concepts.filter((c) => covered.has(c.id));
    } else {
      concepts = brain.concepts.filter(current.concept);
    }
    if (current.note === "covering") {
      const covering = new Set(concepts.flatMap((c) => c.notes));
      notes = brain.notes.filter((n) => covering.has(n.id));
    }
    const withNotes = current.note !== null;
    const list = concepts.map((c) => ({ id: c.id, kind: "concept", label: c.name, cluster: c.cluster, rec: c }));
    list.push(...notes.map((v) => ({ id: v.id, kind: v.kind, label: v.title, cluster: v.cluster, rec: v })));
    const ids = new Set(list.map((n) => n.id));

    const linkMap = new Map();
    const addLink = (a, b, kind) => {
      if (a === b || !ids.has(a) || !ids.has(b)) return;
      const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
      if (!linkMap.has(key)) linkMap.set(key, { source: a, target: b, kind });
    };
    for (const [a, b, kind] of brain.edges) {
      if ((kind === "related" && opts.related) || (kind === "covers" && withNotes)) addLink(a, b, kind);
    }
    if (!withNotes) { // concepts only: two concepts from the same note are linked
      for (const v of brain.notes) {
        const cs = [...brain.neighbors.get(v.id)].filter((id) => id.startsWith("concepts/"));
        cs.forEach((a, i) => cs.slice(i + 1).forEach((b) => addLink(a, b, "shared")));
      }
    }
    const degree = new Map();
    for (const l of linkMap.values()) {
      degree.set(l.source, (degree.get(l.source) || 0) + 1);
      degree.set(l.target, (degree.get(l.target) || 0) + 1);
    }

    const before = new Set(nodes.map((n) => n.id));
    for (const n of nodes) positions.set(n.id, { x: n.x, y: n.y });
    nodes = list.filter((n) => (degree.get(n.id) || 0) >= opts.minLinks);
    byId = new Map(nodes.map((n) => [n.id, n]));
    links = [...linkMap.values()].filter((l) => byId.has(l.source) && byId.has(l.target))
      .map((l) => ({ ...l, s: byId.get(l.source), t: byId.get(l.target) }));
    adj = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const l of links) {
      adj.get(l.source).add(l.target);
      adj.get(l.target).add(l.source);
    }

    groups = layoutGroups();
    let fresh = 0;
    for (const n of nodes) {
      n.degree = adj.get(n.id).size;
      n.r = n.kind === "concept" ? 3.5 + 2.2 * Math.sqrt(Math.max(1, n.degree)) : 4.5 + 0.55 * (n.rec.signal || 2);
      const g = groups.get(n.cluster);
      const known = positions.get(n.id);
      if (known && Math.hypot(known.x - g.x, known.y - g.y) < g.r) Object.assign(n, known);
      else { // somewhere in its topic's area; the forces sort out the rest
        fresh++;
        const angle = hash(n.id) * Math.PI * 2, dist = Math.sqrt(hash(`${n.id}r`)) * (g.r - 12);
        n.x = g.x + Math.cos(angle) * dist;
        n.y = g.y + Math.sin(angle) * dist;
      }
      n.vx = n.vy = 0;
    }

    setChildren(names, ...nodes.map((n) => el("option", { value: n.label })));
    const count = (kind) => nodes.filter((n) => n.kind === kind).length;
    summary.textContent = `${current.label}: ${current.about}. ` + [plural(count("concept"), "concept"),
      ...brain.sources.map((src) => withNotes && count(src.key) && plural(count(src.key), src.one, src.many)),
      plural(links.length, "link")].filter(Boolean).join(" · ");
    setChildren(shapeKey, el("span", {}, el("i", { class: "c" }), "concept"),
      brain.sources.map((src) => el("span", {}, el("i", { class: src.shape }), src.one)),
      el("span", { class: "muted", text: "size = links" }));
    if (isolate != null && !nodes.some((n) => n.cluster === isolate)) isolate = null; // its topic isn't in this view
    renderClusters();
    if (selected) selected = byId.get(selected.id) || null;
    if (hover) hover = byId.get(hover.id) || null;

    const changed = nodes.length !== before.size || nodes.some((n) => !before.has(n.id));
    if (fresh > nodes.length / 2) {
      // Mostly new: settle most of the layout before the first frame (bounded for big vaults).
      alpha = 1;
      const pairs = (nodes.length * nodes.length) / 2 || 1;
      for (let i = Math.min(260, Math.floor(3e7 / pairs)); i > 0; i--) tick();
      fitted = false;
    } else if (changed) {
      alpha = Math.max(alpha, 0.35);
    }
    if (!fitted && W) {
      fit();
      fitted = true;
    }
    applyPending();
    if (tableView.hidden) schedule();
    else renderTable();
  }

  // ---------------------------------------------------------- topic areas

  // Each topic in view gets a round area sized to its notes. The areas are laid out like a
  // small graph of their own, then rearranged to cut crossings. Same vault, same layout.
  function layoutGroups() {
    const counts = new Map();
    for (const n of nodes) counts.set(n.cluster, (counts.get(n.cluster) || 0) + 1);
    const gs = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id, n], i) => ({
      id, n, r: 21 * Math.sqrt(n) + 14,
      x: Math.cos(i * 2.39996) * 90 * Math.sqrt(i), y: Math.sin(i * 2.39996) * 90 * Math.sqrt(i),
    }));
    const index = new Map(gs.map((g, i) => [g.id, i]));
    const weights = new Map(); // how many links join each pair of topics
    for (const l of links) {
      if (l.s.cluster === l.t.cluster) continue;
      const key = [index.get(l.s.cluster), index.get(l.t.cluster)].sort((a, b) => a - b).join(":");
      weights.set(key, (weights.get(key) || 0) + 1);
    }
    const pairs = [...weights].map(([key, w]) => {
      const [i, j] = key.split(":").map(Number);
      return { i, j, a: gs[i], b: gs[j], w };
    });
    relaxGroups(gs, pairs, 300, 1);
    reduceCrossings(gs, pairs);
    const cx = gs.reduce((s, g) => s + g.x, 0) / gs.length, cy = gs.reduce((s, g) => s + g.y, 0) / gs.length;
    gs.forEach((g) => { g.x -= cx; g.y -= cy; });
    return new Map(gs.map((g) => [g.id, g]));
  }

  // Areas push apart, linked ones pull together (harder with more links), and none come
  // closer than GAP. `heat` scales how far they may move.
  function relaxGroups(gs, pairs, steps, heat) {
    for (let s = 0; s < steps; s++) {
      const t = heat * (1 - s / steps);
      const fx = new Float64Array(gs.length), fy = new Float64Array(gs.length);
      for (let i = 0; i < gs.length; i++) {
        for (let j = i + 1; j < gs.length; j++) {
          const a = gs[i], b = gs[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
          const push = (900 * (a.r + b.r)) / (d * d);
          fx[i] -= (dx / d) * push; fy[i] -= (dy / d) * push;
          fx[j] += (dx / d) * push; fy[j] += (dy / d) * push;
        }
      }
      for (const p of pairs) {
        const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y, d = Math.hypot(dx, dy) || 0.01;
        const pull = (d - (p.a.r + p.b.r + GAP)) * 0.08 * Math.min(3, p.w);
        fx[p.i] += (dx / d) * pull; fy[p.i] += (dy / d) * pull;
        fx[p.j] -= (dx / d) * pull; fy[p.j] -= (dy / d) * pull;
      }
      gs.forEach((g, i) => {
        const mx = (fx[i] - g.x * 0.04) * t, my = (fy[i] - g.y * 0.04) * t, m = Math.hypot(mx, my);
        const step = m > 40 ? 40 / m : 1;
        g.x += mx * step;
        g.y += my * step;
      });
      separateGroups(gs);
    }
  }

  function separateGroups(gs) {
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < gs.length; i++) {
        for (let j = i + 1; j < gs.length; j++) {
          const a = gs[i], b = gs[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
          const overlap = a.r + b.r + GAP - d;
          if (overlap > 0) {
            a.x -= (dx / d) * overlap / 2; a.y -= (dy / d) * overlap / 2;
            b.x += (dx / d) * overlap / 2; b.y += (dy / d) * overlap / 2;
          }
        }
      }
    }
  }

  // What a layout of areas costs the eye: bundles crossing each other, bundles cutting
  // through a third topic, and (a little) long bundles.
  function groupsCost(gs, pairs) {
    const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    let cost = 0;
    for (let x = 0; x < pairs.length; x++) {
      const p = pairs[x];
      for (let y = x + 1; y < pairs.length; y++) {
        const q = pairs[y];
        if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;
        if (side(p.a, p.b, q.a) * side(p.a, p.b, q.b) < 0 && side(q.a, q.b, p.a) * side(q.a, q.b, p.b) < 0) cost += p.w * q.w;
      }
      const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y, len2 = dx * dx + dy * dy || 1;
      for (const g of gs) {
        if (g === p.a || g === p.b) continue;
        const u = Math.max(0, Math.min(1, ((g.x - p.a.x) * dx + (g.y - p.a.y) * dy) / len2));
        if (Math.hypot(g.x - p.a.x - u * dx, g.y - p.a.y - u * dy) < g.r + 8) cost += 2 * p.w;
      }
      cost += 0.002 * p.w * (Math.sqrt(len2) - p.a.r - p.b.r);
    }
    return cost;
  }

  // Swap two topics' places, let the areas settle, keep the swap if the layout costs less.
  function reduceCrossings(gs, pairs) {
    if (!pairs.length) return;
    let best = groupsCost(gs, pairs);
    const passes = gs.length > 30 ? 1 : 6, settle = gs.length > 30 ? 12 : 30;
    for (let pass = 0; pass < passes; pass++) {
      let improved = false;
      for (let i = 0; i < gs.length; i++) {
        for (let j = i + 1; j < gs.length; j++) {
          const saved = gs.map((g) => [g.x, g.y]);
          [gs[i].x, gs[j].x] = [gs[j].x, gs[i].x];
          [gs[i].y, gs[j].y] = [gs[j].y, gs[i].y];
          relaxGroups(gs, pairs, settle, 0.4);
          const cost = groupsCost(gs, pairs);
          if (cost < best - 1e-9) {
            best = cost;
            improved = true;
          } else {
            gs.forEach((g, k) => { [g.x, g.y] = saved[k]; });
          }
        }
      }
      if (!improved) break;
    }
  }

  // ---------------------------------------------------------- forces

  function tick() {
    const n = nodes.length;
    for (let i = 0; i < n; i++) { // repulsion within a topic, plus collision for overlapping nodes
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        if (a.cluster !== b.cluster) continue; // topics sit apart, GAP between them
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 === 0) {
          dx = (hash(a.id + b.id) - 0.5) * 0.01;
          dy = 0.005;
          d2 = dx * dx + dy * dy;
        }
        if (d2 < 160000) {
          const f = (-42 * alpha) / d2;
          a.vx += dx * f; a.vy += dy * f;
          b.vx -= dx * f; b.vy -= dy * f;
        }
        const min = a.r + b.r + 5;
        if (d2 < min * min) {
          const d = Math.sqrt(d2), push = ((min - d) / d) * 0.35;
          a.x -= dx * push; a.y -= dy * push;
          b.x += dx * push; b.y += dy * push;
        }
      }
    }
    for (const l of links) {
      const { s, t } = l;
      if (s.cluster !== t.cluster) {
        // A link to another topic doesn't pull the notes across the gap: each end leans
        // toward the side of its own area that faces the other topic, so the bundle is short.
        for (const [node, other] of [[s, t], [t, s]]) {
          const g = groups.get(node.cluster), o = groups.get(other.cluster);
          const dx = o.x - g.x, dy = o.y - g.y, d = Math.hypot(dx, dy) || 1;
          node.vx += (g.x + (dx / d) * g.r * 0.7 - node.x) * 0.03 * alpha;
          node.vy += (g.y + (dy / d) * g.r * 0.7 - node.y) * 0.03 * alpha;
        }
        continue;
      }
      let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy; // springs inside a topic
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const k = ((d - LINK_LENGTH[l.kind]) / d) * alpha * ((l.kind === "shared" ? 0.3 : 0.7) / Math.min(s.degree, t.degree));
      dx *= k; dy *= k;
      const bias = s.degree / (s.degree + t.degree);
      t.vx -= dx * bias; t.vy -= dy * bias;
      s.vx += dx * (1 - bias); s.vy += dy * (1 - bias);
    }
    for (const node of nodes) {
      const g = groups.get(node.cluster);
      node.vx += (g.x - node.x) * 0.012 * alpha; // a light pull to the middle of its area
      node.vy += (g.y - node.y) * 0.012 * alpha;
      if (node.fx != null) {
        node.x = node.fx; node.y = node.fy; node.vx = node.vy = 0;
        continue;
      }
      node.x += node.vx *= 0.6;
      node.y += node.vy *= 0.6;
      const dx = node.x - g.x, dy = node.y - g.y, d = Math.hypot(dx, dy), room = g.r - node.r - 4;
      if (d > room) { // notes stay inside their topic's area
        node.x = g.x + (dx / d) * room;
        node.y = g.y + (dy / d) * room;
        node.vx *= 0.5;
        node.vy *= 0.5;
      }
    }
    alpha += (0 - alpha) * 0.0228;
  }

  // How readable the layout is, for checking it from the console: document.querySelector(".graph-stage canvas").layoutStats()
  // crossings: pairs of links that cross; betweenTopics: of those, pairs of links that both join two topics;
  // overNotes: links between topics drawn over a note of a third topic.
  function layoutStats() {
    const lines = links.map((l) => ({ l, pts: edgePoints(l) }));
    const segs = (pts) => pts.slice(1).map((p, i) => [pts[i], p]);
    const cross = ([p, q], [r, s]) => {
      const o = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      return o(p, q, r) * o(p, q, s) < 0 && o(r, s, p) * o(r, s, q) < 0;
    };
    let crossings = 0, betweenTopics = 0, overNotes = 0;
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i], b = lines[j];
        if ([a.l.s, a.l.t].some((n) => n === b.l.s || n === b.l.t)) continue;
        if (segs(a.pts).some((x) => segs(b.pts).some((y) => cross(x, y)))) {
          crossings++;
          if (a.l.s.cluster !== a.l.t.cluster && b.l.s.cluster !== b.l.t.cluster) betweenTopics++;
        }
      }
    }
    const near = (n, [p, q]) => {
      const dx = q.x - p.x, dy = q.y - p.y, t = Math.max(0, Math.min(1, ((n.x - p.x) * dx + (n.y - p.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(n.x - p.x - t * dx, n.y - p.y - t * dy) < n.r + 2;
    };
    for (const { l, pts } of lines) {
      if (l.s.cluster === l.t.cluster) continue;
      if (nodes.some((n) => n.cluster !== l.s.cluster && n.cluster !== l.t.cluster && segs(pts).some((sg) => near(n, sg)))) overNotes++;
    }
    // spread: area of the box around all notes, per note (world units²); lower is tighter
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const spread = Math.round(((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / nodes.length);
    return { links: links.length, betweenTopicLinks: lines.filter(({ l }) => l.s.cluster !== l.t.cluster).length,
      crossings, betweenTopics, overNotes, spread };
  }
  canvas.layoutStats = layoutStats;

  // A link inside a topic is a straight line. A link between two topics is a curve through
  // the edges of both areas, where they face each other, so all links between the same two
  // topics gather into one bundle across the gap.
  function bundle(l) {
    const a = groups.get(l.s.cluster), b = groups.get(l.t.cluster);
    if (!a || !b || a === b) return null;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    return [{ x: a.x + (dx / d) * a.r, y: a.y + (dy / d) * a.r }, { x: b.x - (dx / d) * b.r, y: b.y - (dy / d) * b.r }];
  }

  function traceEdge(l) {
    ctx.moveTo(l.s.x, l.s.y);
    const c = bundle(l);
    if (c) ctx.bezierCurveTo(c[0].x, c[0].y, c[1].x, c[1].y, l.t.x, l.t.y);
    else ctx.lineTo(l.t.x, l.t.y);
  }

  // A link as the points it's drawn through (a curve as 16 short segments), for layoutStats.
  function edgePoints(l) {
    const c = bundle(l);
    if (!c) return [{ x: l.s.x, y: l.s.y }, { x: l.t.x, y: l.t.y }];
    const p = [l.s, c[0], c[1], l.t];
    return Array.from({ length: 17 }, (_, i) => {
      const t = i / 16, u = 1 - t, w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      return { x: w.reduce((s, k, j) => s + k * p[j].x, 0), y: w.reduce((s, k, j) => s + k * p[j].y, 0) };
    });
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (alpha > 0.004 || drag?.node) {
      tick();
      schedule();
    }
    draw();
  }

  // ---------------------------------------------------------- drawing

  // A note's outline, added to the current path: concepts are round, a source's notes take the
  // shape sources.py gives it (square, diamond, triangle).
  function shape(n, r) {
    const kind = n.kind === "concept" ? "circle" : sourceOf(n.kind)?.shape || "square";
    if (kind === "circle") ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    else if (kind === "diamond") {
      const d = r * 1.25; // a diamond looks as big as a square of the same radius at about 1.25x
      ctx.moveTo(n.x, n.y - d);
      ctx.lineTo(n.x + d, n.y);
      ctx.lineTo(n.x, n.y + d);
      ctx.lineTo(n.x - d, n.y);
      ctx.closePath();
    } else if (kind === "triangle") {
      const d = r * 1.3;
      ctx.moveTo(n.x, n.y - d);
      ctx.lineTo(n.x + d, n.y + d * 0.8);
      ctx.lineTo(n.x - d, n.y + d * 0.8);
      ctx.closePath();
    } else ctx.roundRect(n.x - r, n.y - r, r * 2, r * 2, Math.min(2.5, r / 2));
  }

  function draw() {
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, W, H);
    if (!nodes.length) {
      ctx.fillStyle = colors.muted;
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(store.brain ? "No notes match these settings." : "Reading the vault…", W / 2, H / 2);
      ctx.textAlign = "start";
      return;
    }
    const k = view.k;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);
    const focus = hover || selected;
    const near = focus ? adj.get(focus.id) : null;
    const lit = (n) => (isolate == null || n.cluster === isolate) && (!focus || n === focus || near.has(n.id));

    ctx.lineWidth = 1 / k;
    for (const pass of [false, true]) {
      ctx.beginPath();
      for (const l of links) {
        if ((lit(l.s) && lit(l.t)) !== pass || (focus && (l.s === focus || l.t === focus))) continue;
        traceEdge(l);
      }
      ctx.globalAlpha = pass ? 1 : 0.18;
      ctx.strokeStyle = colors.edge;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (focus) {
      ctx.beginPath();
      for (const l of links) {
        if (l.s === focus || l.t === focus) traceEdge(l);
      }
      ctx.strokeStyle = colors.text2;
      ctx.lineWidth = 1.4 / k;
      ctx.stroke();
    }

    for (const n of nodes) {
      ctx.globalAlpha = lit(n) ? 1 : 0.14;
      ctx.beginPath();
      shape(n, n.r);
      ctx.fillStyle = colorOf(n);
      ctx.fill();
      ctx.lineWidth = 1.5 / k; // the surface ring keeps overlapping nodes apart
      ctx.strokeStyle = colors.surface;
      ctx.stroke();
      if (n === selected) {
        ctx.beginPath();
        shape(n, n.r + 3 / k);
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = colors.text;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    drawTopicNames(focus);
  }

  // Each topic's name just above its topmost note. Notes have no names on the graph (too much
  // text): hovering one shows its name in the tooltip.
  function drawTopicNames(focus) {
    const k = view.k;
    const spans = new Map(); // cluster id -> { sx: sum of its notes' x, n, top, bottom }
    for (const n of nodes) {
      const s = spans.get(n.cluster) || spans.set(n.cluster, { sx: 0, n: 0, top: Infinity, bottom: -Infinity }).get(n.cluster);
      s.sx += n.x;
      s.n++;
      s.top = Math.min(s.top, n.y - n.r);
      s.bottom = Math.max(s.bottom, n.y + n.r);
    }
    ctx.font = `600 ${11.5 / k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const placed = []; // screen boxes of the names drawn so far
    for (const g of groups.values()) {
      const cluster = store.brain.clusterById.get(g.id), span = spans.get(g.id);
      if (!cluster || !span || (isolate != null && g.id !== isolate)) continue;
      // Above the group, or under it when that would run into another topic's name.
      const x = span.sx / span.n, w = (ctx.measureText(cluster.label).width + 6) * k;
      const box = (wy) => [x * k + view.x - w / 2, wy * k + view.y - 8, x * k + view.x + w / 2, wy * k + view.y + 8];
      const free = (b) => !placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
      const above = span.top - 10 / k, below = span.bottom + 11 / k;
      const y = free(box(above)) || !free(box(below)) ? above : below;
      placed.push(box(y));
      ctx.globalAlpha = focus && g.id !== focus.cluster ? 0.35 : 1;
      ctx.lineWidth = 3.5 / k;
      ctx.strokeStyle = colors.surface;
      ctx.strokeText(cluster.label, x, y);
      ctx.fillStyle = colors.muted;
      ctx.fillText(cluster.label, x, y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "start";
  }

  // ---------------------------------------------------------- view

  function resize() {
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    dpr = window.devicePixelRatio || 1;
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (nodes.length && (!fitted || !viewTouched)) { // keep framing everything until you move the view
      fit();
      fitted = true;
      applyPending();
    }
    draw();
  }

  // The note drawer covers the right of the stage; centre things in what's left.
  function visibleWidth() {
    const drawer = $("#drawer");
    if (drawer.hidden) return W;
    const covered = stage.getBoundingClientRect().right - drawer.getBoundingClientRect().left;
    return Math.max(W * 0.45, W - Math.max(0, covered));
  }

  // Frame every topic's area (or just the isolated one), with room for the names above them.
  function fit() {
    const areas = [...groups.values()].filter((g) => isolate == null || g.id === isolate);
    if (!areas.length || !W) return;
    viewTouched = false; // framed again: later resizes may re-frame
    const minX = Math.min(...areas.map((g) => g.x - g.r)) - 20, maxX = Math.max(...areas.map((g) => g.x + g.r)) + 20;
    const minY = Math.min(...areas.map((g) => g.y - g.r)) - 34, maxY = Math.max(...areas.map((g) => g.y + g.r)) + 20;
    const vw = visibleWidth();
    view.k = Math.max(0.15, Math.min(2.2, vw / (maxX - minX), H / (maxY - minY)));
    view.x = vw / 2 - ((minX + maxX) / 2) * view.k;
    view.y = H / 2 - ((minY + maxY) / 2) * view.k;
    draw();
  }

  function zoomAt(px, py, factor) {
    viewTouched = true;
    const k = Math.max(0.15, Math.min(6, view.k * factor));
    view.x = px - ((px - view.x) * k) / view.k;
    view.y = py - ((py - view.y) * k) / view.k;
    view.k = k;
    draw();
  }
  const zoomBy = (factor) => zoomAt(visibleWidth() / 2, H / 2, factor);

  function centerOn(n, minZoom = 1.5) {
    viewTouched = true;
    view.k = Math.max(view.k, minZoom);
    view.x = visibleWidth() / 2 - n.x * view.k;
    view.y = H / 2 - n.y * view.k;
    draw();
  }

  function focusByName(name) {
    const q = name.trim().toLowerCase();
    if (!q) return;
    const n = nodes.find((x) => x.label.toLowerCase() === q)
      || nodes.find((x) => x.label.toLowerCase().startsWith(q))
      || nodes.find((x) => x.label.toLowerCase().includes(q));
    if (!n) return;
    selected = n;
    openNote(n.id);
    centerOn(n);
  }

  function applyPending() {
    if (!pendingFocus || !W || !nodes.length) return;
    const n = byId.get(pendingFocus);
    if (!n) return;
    pendingFocus = null;
    selected = n;
    centerOn(n, 1.6);
  }

  // ---------------------------------------------------------- side panel and table

  function renderClusters() {
    const brain = store.brain;
    const counts = new Map();
    nodes.forEach((n) => counts.set(n.cluster, (counts.get(n.cluster) || 0) + 1));
    const clusters = brain.clusters.filter((c) => counts.has(c.id));
    sideHead.lastElementChild.textContent = isolate != null ? "click again to show all" : `${clusters.length} clusters`;
    setChildren(clusterList, ...clusters.map((c) => el("li", {}, el("button", {
      type: "button", "aria-pressed": String(isolate === c.id), title: c.hub ? `Main concept: ${c.hub}` : c.label,
      dataset: { cluster: String(c.id) }, onclick: () => setIsolate(isolate === c.id ? null : c.id),
    }, el("span", { class: "sw", style: { background: clusterColor(c.id) } }), el("span", { class: "name", text: c.label }),
    el("span", { class: "count", text: String(counts.get(c.id)) })))));
    markLegend(hover);
  }

  // While a node is hovered, its topic stands out in the list and the others fade.
  function markLegend(n) {
    clusterList.classList.toggle("hovering", Boolean(n));
    let match = null;
    clusterList.querySelectorAll("button").forEach((b) => {
      const on = Boolean(n) && b.dataset.cluster === String(n.cluster);
      b.classList.toggle("hover-match", on);
      if (on) match = b;
    });
    const box = clusterList.closest(".card");
    if (!match || box.scrollHeight <= box.clientHeight) return;
    // Scroll the list itself, never the page (on narrow screens the list sits under the graph).
    const outer = box.getBoundingClientRect(), item = match.getBoundingClientRect();
    if (item.top < outer.top + 40) box.scrollTop -= outer.top + 40 - item.top;
    else if (item.bottom > outer.bottom - 8) box.scrollTop += item.bottom - outer.bottom + 8;
  }

  // The address keeps the view and the isolated topic: #/graph?view=shared&cluster=3.
  function syncHash() {
    const q = new URLSearchParams();
    if (opts.view !== "all") q.set("view", opts.view);
    if (isolate != null) q.set("cluster", isolate);
    const query = q.toString();
    const hashNow = query ? `#/graph?${query}` : "#/graph";
    if (location.hash !== hashNow) history.replaceState(null, "", hashNow);
  }

  function setView(key, { refit = true } = {}) {
    if (key === opts.view) return;
    opts.view = key;
    rebuild();
    syncHash();
    if (refit && W) fit();
  }

  function setIsolate(id, { refit = true } = {}) {
    isolate = id;
    syncHash();
    renderClusters();
    if (refit) fit();
    draw();
  }

  function renderTable() {
    const rows = [...nodes].sort((a, b) => a.cluster - b.cluster || b.degree - a.degree || a.label.localeCompare(b.label));
    setChildren(tableView, 
      el("div", { class: "card-head" }, el("h2", { text: "All nodes" }), el("span", { class: "sub", text: "by topic, most connected first" })),
      el("div", { class: "table-wrap" }, el("table", { class: "data" },
        el("thead", {}, el("tr", {}, ["Topic", "Note", "Kind", "Links"].map((h, i) => el("th", { class: i === 3 ? "num" : null, text: h })))),
        el("tbody", {}, rows.map((n) => el("tr", { class: "click", onclick: () => openNote(n.id) },
          el("td", {}, el("span", { class: "sw", style: { background: clusterColor(n.cluster), marginRight: "7px" } }),
            store.brain.clusterById.get(n.cluster)?.label || ""),
          el("td", { text: n.label }), el("td", { text: n.kind }), el("td", { class: "num", text: String(n.degree) })))))));
  }

  // ---------------------------------------------------------- pointer

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function nodeAt(px, py) {
    const wx = (px - view.x) / view.k, wy = (py - view.y) / view.k;
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d < n.r + 6 / view.k && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  function tip(e, n) {
    const brain = store.brain;
    const cluster = brain.clusterById.get(n.cluster);
    const text = n.kind === "concept" ? n.rec.summary : n.rec.spoiler;
    const about = n.kind === "concept"
      ? brain.sources.map((src) => n.rec.sources[src.key]?.length && plural(n.rec.sources[src.key].length, src.one, src.many))
        .filter(Boolean).join(", ") || "no notes yet"
      : n.rec.channel;
    showTip(e,
      el("div", { class: "tt-title", text: n.label }),
      el("div", { class: "tt-head", text: [sourceOf(n.kind)?.label || n.kind, about, cluster?.label].filter(Boolean).join(" · ") }),
      text && el("div", { class: "tt-body", text: text.length > 180 ? `${text.slice(0, 178)}…` : text }));
  }

  canvas.addEventListener("pointerdown", (e) => {
    const p = local(e);
    const n = nodeAt(p.x, p.y);
    canvas.setPointerCapture(e.pointerId);
    drag = { node: n, x: p.x, y: p.y, vx: view.x, vy: view.y, moved: false };
    canvas.classList.add("dragging");
    hideTip();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = local(e);
    if (drag) {
      if (Math.hypot(p.x - drag.x, p.y - drag.y) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.node) { // the note follows the pointer at once; its neighbours catch up over the next frames
        drag.node.x = drag.node.fx = (p.x - view.x) / view.k;
        drag.node.y = drag.node.fy = (p.y - view.y) / view.k;
        alpha = Math.max(alpha, 0.2);
        draw();
        schedule();
      } else {
        viewTouched = true;
        view.x = drag.vx + p.x - drag.x;
        view.y = drag.vy + p.y - drag.y;
        draw();
      }
      return;
    }
    const n = nodeAt(p.x, p.y);
    if (n !== hover) {
      hover = n;
      canvas.classList.toggle("on-node", Boolean(n));
      markLegend(n);
      draw();
    }
    if (n) tip(e, n);
    else hideTip();
  });
  canvas.addEventListener("pointerup", () => {
    if (!drag) return;
    const n = drag.node;
    if (n) { // let go: the note moves with the others again
      n.fx = n.fy = null;
      alpha = Math.max(alpha, 0.2);
      schedule();
      if (!drag.moved) {
        selected = n;
        openNote(n.id);
      }
    } else if (!drag.moved) {
      selected = null;
    }
    drag = null;
    canvas.classList.remove("dragging");
    draw();
  });
  canvas.addEventListener("pointerleave", () => {
    if (drag) return;
    hover = null;
    markLegend(null);
    hideTip();
    draw();
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => {
    const p = local(e);
    if (!nodeAt(p.x, p.y)) fit();
  });

  // ---------------------------------------------------------- lifecycle

  const onSelect = (e) => { // the drawer opened (or closed) a note: mirror it here
    const n = e.detail ? byId.get(e.detail) : null;
    selected = n;
    if (n) requestAnimationFrame(() => keepVisible(n));
    draw();
  };

  function keepVisible(n) { // slide the view so the drawer doesn't cover the selected note
    const sx = n.x * view.k + view.x, sy = n.y * view.k + view.y, right = visibleWidth() - 40;
    if (sx > right || sx < 40 || sy < 40 || sy > H - 40) centerOn(n, view.k);
  }
  const onTheme = () => {
    readColors();
    draw();
  };
  document.addEventListener("noteselect", onSelect);
  document.addEventListener("themechange", onTheme);
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  readColors();

  // #/graph?view=shared picks a view, ?cluster=3 isolates a topic, ?focus=<note> centres on a note.
  function update(p) {
    const views = store.brain ? viewsOf(store.brain) : [];
    const wanted = p.get("view") || "all";
    const focus = p.get("focus");
    if (focus) {
      pendingFocus = focus;
      if (isolate != null) setIsolate(null, { refit: false });
      if (!byId.has(focus)) setView("all", { refit: false }); // the note isn't in this view
      applyPending();
      return;
    }
    if (views.some((v) => v.key === wanted)) setView(wanted, { refit: Boolean(W) });
    const cluster = p.get("cluster");
    const next = cluster != null && store.brain?.clusterById.has(Number(cluster)) ? Number(cluster) : null;
    if (next !== isolate) setIsolate(next, { refit: Boolean(W) });
  }

  let initial = params; // applied once the vault has loaded
  const off = onBrain(() => {
    if (!store.brain) return draw();
    rebuild();
    if (initial) update(initial);
    initial = null;
  });
  if (store.brain) {
    rebuild();
    update(initial);
    initial = null;
  }

  return {
    update,
    unmount() {
      cancelAnimationFrame(raf);
      for (const n of nodes) positions.set(n.id, { x: n.x, y: n.y });
      off();
      observer.disconnect();
      document.removeEventListener("noteselect", onSelect);
      document.removeEventListener("themechange", onTheme);
      hideTip();
    },
  };
}
