// Shared by the three views: the brain data, DOM helpers, formatting, the tooltip,
// the note drawer and a small Markdown renderer for the vault's notes.
// Note text comes from transcripts, so it's only ever inserted as text nodes.

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  return build(node, props, children);
}

export function svg(tag, props = {}, ...children) {
  return build(document.createElementNS("http://www.w3.org/2000/svg", tag), props, children);
}

function build(node, props, children) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.setAttribute("class", value);
    else if (key === "text") node.textContent = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...kids(children));
  return node;
}

// Children as written: nested arrays flattened, and the false/null/undefined that
// `cond && el(...)` leaves behind dropped (the DOM would print them as text).
const kids = (children) => children.flat(Infinity).filter((c) => c != null && c !== false);

// replaceChildren with the same rules as el(): use it instead of node.replaceChildren.
export function setChildren(node, ...children) {
  node.replaceChildren(...kids(children));
  return node;
}

// The magnifier at the start of a .search-box.
export function searchIcon() {
  return svg("svg", { class: "glass", viewBox: "0 0 20 20", width: "20", height: "20", "aria-hidden": "true" },
    svg("circle", { cx: "8.5", cy: "8.5", r: "5.5", fill: "none", stroke: "currentColor", "stroke-width": "1.8" }),
    svg("path", { d: "m13 13 4.5 4.5", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round" }));
}

export async function api(path, { signal } = {}) {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------ the brain

export const store = { brain: null, error: null };
const listeners = new Set();

export function onBrain(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Listeners hear about it only when something changed: a note, or the server going up or down.
// Polls send the version they have, so an unchanged vault costs a 304 with no body.
export async function loadBrain() {
  const wasDown = Boolean(store.error);
  const known = store.brain?.version;
  let notify;
  try {
    const res = await fetch("/api/brain", { cache: "no-store", headers: known ? { "If-None-Match": `"${known}"` } : {} });
    let changed = false;
    if (res.status !== 304) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      changed = data.version !== known;
      if (changed) store.brain = prepare(data);
    }
    store.error = null;
    notify = changed || wasDown;
  } catch (e) {
    store.error = e;
    notify = !wasDown;
  }
  if (notify) listeners.forEach((fn) => fn(store.brain));
}

// The brain as the views use it. `sources` is the server's list of kinds of note (sources.py),
// each with its colours; `notes` holds every source's notes, `kind` saying which.
function prepare(data) {
  const sources = (data.sources || []).map((s) => ({
    ...s,
    color: `var(--src-${s.key}, var(--other))`,
    tint: `color-mix(in srgb, var(--src-${s.key}, var(--other)) 16%, var(--surface-2))`,
    ramp: (step) => `var(--ramp-${s.key}-${step}, var(--other))`,
  }));
  const notes = data.notes || [];
  data.concepts.forEach((c) => { c.kind = "concept"; });
  const byId = new Map([...notes, ...data.concepts].map((rec) => [rec.id, rec]));
  const neighbors = new Map([...byId.keys()].map((id) => [id, new Set()]));
  for (const [a, b] of data.edges) {
    neighbors.get(a)?.add(b);
    neighbors.get(b)?.add(a);
  }
  paintClusterColors(data.clusters);
  return {
    ...data, sources, notes, byId, neighbors,
    source: new Map(sources.map((s) => [s.key, s])),
    byKind: new Map(sources.map((s) => [s.key, notes.filter((n) => n.kind === s.key)])),
    clusterById: new Map(data.clusters.map((c) => [c.id, c])),
  };
}

// ------------------------------------------------------------ sources

// A kind of note (a source in server/sources.py) with its colours: --src-<key>, and an ordinal
// ramp --ramp-<key>-1..3 for its ordered classes, best first (app.css). A source added on the
// server but not yet given colours is drawn grey.
export const sourceOf = (kind) => store.brain?.source.get(kind) || null;

// The colour of the i-th of n ordered classes (verdicts, trust levels), best first, on a source's ramp.
export function classColor(source, i, n) {
  const step = n <= 1 ? 1 : Math.round(1 + (i * 2) / (n - 1)); // 2 classes: steps 1 and 3; 3 classes: 1, 2, 3
  return source ? source.ramp(Math.min(3, step)) : "var(--other)";
}

// A verdict's swatch, on its source's ramp: "skip" is a video's lightest step, "noise" a post's.
export function verdictColor(verdict, kind) {
  const source = sourceOf(kind) || store.brain?.sources.find((s) => s.verdicts.includes(verdict));
  const i = source ? source.verdicts.indexOf(verdict) : -1;
  return i >= 0 ? classColor(source, i, source.verdicts.length) : null;
}

export function verdictChip(verdict, kind) {
  if (!verdict) return null;
  const color = verdictColor(verdict, kind);
  return el("span", { class: "chip" }, color && el("span", { class: "sw", style: { background: color } }), verdict);
}

// A note's picture in a list: a video's thumbnail, or the initials of who it's from on a tint of
// its source's colour ("Ruben Hassid" -> RH).
export function noteThumb(rec, { small = false } = {}) {
  const cls = `thumb${small ? " small" : ""}`;
  if (rec?.video_id) return el("img", { class: cls, src: thumb(rec.video_id), alt: "", loading: "lazy" });
  const source = sourceOf(rec?.kind);
  const initials = (rec?.channel || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  return el("div", { class: `${cls} badge`, "aria-hidden": "true", title: source?.label || "",
    style: { background: source?.tint || "var(--surface-3)" }, text: initials || "?" });
}

// ------------------------------------------------------------ cluster colours

// The 8 largest clusters use the tested palette, --s1..--s8. Every other cluster gets a colour
// of its own, --x0, --x1…: of a few hundred candidates (hue, lightness and saturation), each
// takes the one that looks most different from the palette and the colours already given out,
// in a light and a dark version like the palette. Past 8 colours some pairs still look closer
// than the palette's; the topic name in tooltips and lists tells them apart.
const PALETTE = { // --s1..--s8, as in app.css
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

function extraColors(n, theme) {
  const candidates = [];
  for (let h = 0; h < 360; h += 6) {
    for (const L of theme === "light" ? [0.52, 0.64, 0.76] : [0.6, 0.72, 0.84]) {
      for (const C of [0.09, 0.15]) candidates.push(oklchHex(L, C, h));
    }
  }
  const labs = candidates.map(hexOklab);
  const used = PALETTE[theme].map(hexOklab), picked = [];
  const nearest = (lab) => Math.min(...used.map((u) => Math.hypot(lab[0] - u[0], lab[1] - u[1], lab[2] - u[2])));
  for (let k = 0; k < n; k++) {
    let best = 0;
    labs.forEach((lab, i) => { if (nearest(lab) > nearest(labs[best])) best = i; });
    used.push(labs[best]);
    picked.push(candidates[best]);
  }
  return picked;
}

function paintClusterColors(clusters) {
  const extra = clusters.filter((c) => !c.slot && !c.loose);
  extra.forEach((c, k) => { c.extra = k; });
  const colors = { light: extraColors(extra.length, "light"), dark: extraColors(extra.length, "dark") };
  const vars = (light) => colors[light ? "light" : "dark"].map((hex, k) => `--x${k}: ${hex};`).join(" ");
  const style = document.getElementById("cluster-colors") || document.head.appendChild(el("style", { id: "cluster-colors" }));
  style.textContent = `:root { ${vars(true)} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars(false)} } }
:root[data-theme="dark"] { ${vars(false)} }`;
}

// OKLCH (perceptual lightness, chroma, hue in degrees) to a hex colour the canvas can use too.
function oklchHex(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${linear.map((x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  }).join("")}`;
}

// A hex colour as OKLab, where distance matches how different two colours look.
function hexOklab(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

// The CSS variable a cluster is drawn with. Notes linked to nothing share one grey group.
export function clusterVar(c) {
  return !c || c.loose ? "--other" : c.slot ? `--s${c.slot}` : `--x${c.extra}`;
}

export function clusterColor(clusterId) {
  return `var(${clusterVar(store.brain?.clusterById.get(clusterId))})`;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ------------------------------------------------------------ formatting

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const fmt = (n) => (Math.abs(n) >= 10000 ? compact.format(n) : Math.round(n).toLocaleString("en"));
export const plural = (n, word, many = `${word}s`) => `${fmt(n)} ${n === 1 ? word : many}`;

export function fmtHours(seconds) {
  const minutes = seconds / 60;
  if (minutes < 90) return { value: Math.round(minutes), unit: "min" };
  return { value: Math.round((minutes / 60) * 10) / 10, unit: "h" };
}

export function fmtDuration(seconds) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(iso, { year = false } = {}) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}${year ? `, ${y}` : ""}`;
}

export function isoDay(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDay(new Date(y, m - 1, d + days));
}

export function daysBetween(a, b) {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  return Math.round((new Date(yb, mb - 1, db) - new Date(ya, ma - 1, da)) / 86400000);
}

export function ago(stamp) {
  if (!stamp) return "";
  const then = new Date(stamp.length <= 10 ? `${stamp}T12:00` : stamp.replace(" ", "T"));
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins} min`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h`;
  const days = Math.round(mins / 1440);
  return days < 45 ? `${days} d` : fmtDay(stamp.slice(0, 10));
}

export const thumb = (videoId) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;

export function tsLink(ts) {
  if (!ts) return null;
  return el("a", { class: "ts-link", href: ts.url, target: "_blank", rel: "noopener noreferrer",
    title: "Watch from here on YouTube", onclick: (e) => e.stopPropagation() }, ts.label);
}

// Search hits come back as [text, isHit] pairs.
export function highlighted(segments) {
  return (segments || []).map(([text, hit]) => (hit ? el("mark", { text }) : document.createTextNode(text)));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ------------------------------------------------------------ tooltip

export function showTip(event, ...content) {
  const tip = $("#tooltip");
  setChildren(tip, content);
  tip.hidden = false;
  const pad = 14, { innerWidth: w, innerHeight: h } = window;
  const rect = tip.getBoundingClientRect();
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + rect.width > w - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > h - 8) y = event.clientY - rect.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

export function hideTip() {
  $("#tooltip").hidden = true;
}

export function tipRow(color, value, label, { box = false } = {}) {
  return el("div", { class: "tt-row" },
    color && el("i", { class: `tt-key${box ? " box" : ""}`, style: { background: color } }),
    el("b", { text: String(value) }), el("span", { text: label }));
}

// ------------------------------------------------------------ markdown

// A cited moment: 04:23, 1:02:03 or a range 03:28–07:10 (the same pattern as TS_CITED in brain_index.py).
export const TS_CITED = String.raw`\d{1,2}(?::\d{2}){1,2}(?:\s*[–-]\s*\d{1,2}(?::\d{2}){1,2})?`;
const INLINE_RE = new RegExp([
  String.raw`(\*\*(.+?)\*\*)`, // 1-2 **bold**
  String.raw`(\[\[([^\]|]+)(?:\|([^\]]+))?\]\])`, // 3-5 [[wikilink|label]]
  String.raw`(\[([^\]]*)\]\(([^)\s]+)\))`, // 6-8 [link](url)
  "(`([^`]+)`)", // 9-10 `code`
  String.raw`(\*([^*\s][^*]*?)\*)`, // 11-12 *em*
  String.raw`(https?:\/\/[^\s<>()\]]+)`, // 13 bare URL
  String.raw`(\[((?:[VC]\d+(?:[ @]+${TS_CITED})?\s*[,;]?\s*)+)\])`, // 14-15 an older Ask answer's [V12 04:23]
].join("|"), "g");
const TS_LABEL_RE = /^\d{1,2}(:\d{2}){1,2}([–-]\d{1,2}(:\d{2}){1,2})?$/;

function link(href, children) {
  if (!/^(https?:|obsidian:)/i.test(href)) return children;
  const external = /^https?:/i.test(href);
  const text = children.map((c) => c.textContent).join("");
  return el("a", {
    href, target: external ? "_blank" : null, rel: external ? "noopener noreferrer" : null,
    class: external && /youtube\.com\/watch/.test(href) && TS_LABEL_RE.test(text) ? "ts" : null,
  }, children);
}

// An Ask answer's citation: a note link, maybe with a moment: [[videos/Some title@04:23]].
// Any folder: a source's ("videos", "posts"…) or "concepts"; a link to no note opens as "not found".
const CITE_TARGET_RE = new RegExp(String.raw`^([\w-]+/.+?)(?:@(${TS_CITED}))?$`);
// Saved answers from before Ask explored the vault cite [V12 04:23] instead.
const OLD_CITE_PART_RE = new RegExp(String.raw`([VC]\d+)(?:[ @]+(${TS_CITED}))?`, "g");

// opts.cite([{ ref, ts }]) renders a citation; without it, note links are links and old
// citations stay plain text.
export function inline(text, opts = {}) {
  const out = [];
  let last = 0;
  text = text.replace(/%%.*?%%/g, "");
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) out.push(el("strong", {}, inline(m[2], opts)));
    else if (m[3]) {
      const target = m[4].trim();
      const label = m[5] || target.split("/").pop();
      const cite = opts.cite && target.match(CITE_TARGET_RE);
      if (cite) {
        if (m[5]) out.push(document.createTextNode(`${m[5]} `));
        out.push(opts.cite([{ ref: `${cite[1].trim()}.md`, ts: cite[2] }]));
      } else {
        out.push(/^[\w-]+\//.test(target)
          ? el("a", { href: "#", class: "wikilink", onclick: (e) => { e.preventDefault(); openNote(`${target}.md`); } }, label)
          : document.createTextNode(label));
      }
    } else if (m[6]) out.push(link(m[8], inline(m[7], opts)));
    else if (m[9]) out.push(el("code", { text: m[10] }));
    else if (m[11]) out.push(el("em", {}, inline(m[12], opts)));
    else if (m[13]) out.push(link(m[13], [document.createTextNode(m[13])]));
    else if (m[14]) {
      out.push(opts.cite
        ? opts.cite([...m[15].matchAll(OLD_CITE_PART_RE)].map(([, ref, ts]) => ({ ref, ts })))
        : document.createTextNode(m[14]));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out.flat();
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const BLOCK_START_RE = /^(#{1,6}\s|>|```|\s*([-*+]|\d+[.)])\s|(-{3,}|\*{3,})\s*$)/;

export function markdown(md, opts = {}) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      frag.append(el("pre", {}, el("code", { text: code.join("\n") })));
      i++;
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      frag.append(el(`h${Math.min(4, m[1].length)}`, {}, inline(m[2], opts)));
      i++;
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      frag.append(el("hr"));
      i++;
    } else if (line.startsWith(">")) {
      const quoted = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) quoted.push(lines[i].replace(/^>\s?/, ""));
      const callout = quoted[0].match(/^\[!(\w+)\][+-]?\s*(.*)$/);
      frag.append(callout
        ? el("div", { class: `callout callout-${callout[1].toLowerCase()}` },
          el("div", { class: "callout-title", text: callout[2] || callout[1] }), markdown(quoted.slice(1).join("\n"), opts))
        : el("blockquote", {}, markdown(quoted.join("\n"), opts)));
    } else if (LIST_RE.test(line)) {
      const items = [];
      for (; i < lines.length; i++) {
        const item = lines[i].match(LIST_RE);
        if (item) items.push({ indent: item[1].replace(/\t/g, "    ").length, ordered: /\d/.test(item[2]), text: item[3] });
        else if (lines[i].trim() && /^\s/.test(lines[i]) && items.length) items.at(-1).text += ` ${lines[i].trim()}`;
        else break;
      }
      frag.append(list(items, opts));
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !(para.length && BLOCK_START_RE.test(lines[i])); i++) para.push(lines[i]);
      if (!para.length) para.push(lines[i++]);
      const p = el("p");
      para.forEach((text, j) => p.append(...(j ? [el("br")] : []), ...inline(text, opts)));
      frag.append(p);
    }
  }
  return frag;
}

function list(items, opts) {
  const root = el(items[0].ordered ? "ol" : "ul");
  const stack = [{ indent: items[0].indent, node: root }];
  for (const item of items) {
    while (stack.length > 1 && item.indent < stack.at(-1).indent) stack.pop();
    const top = stack.at(-1);
    if (item.indent > top.indent && top.node.lastElementChild) {
      const sub = el(item.ordered ? "ol" : "ul");
      top.node.lastElementChild.append(sub);
      stack.push({ indent: item.indent, node: sub });
    }
    stack.at(-1).node.append(el("li", {}, inline(item.text, opts)));
  }
  return root;
}

// ------------------------------------------------------------ note drawer

const history = [];

export function closeDrawer() {
  $("#drawer").hidden = true;
  history.length = 0;
  document.dispatchEvent(new CustomEvent("noteselect", { detail: null }));
}

export async function openNote(id, { back = false } = {}) {
  const drawer = $("#drawer"), body = $("#drawer-body");
  if (!back && history.at(-1) !== id) history.push(id);
  $("#drawer-back").hidden = history.length < 2;
  drawer.hidden = false;
  document.dispatchEvent(new CustomEvent("noteselect", { detail: id }));
  let note, error;
  try {
    note = await api(`/api/note?path=${encodeURIComponent(id)}`);
  } catch (e) {
    error = e;
  }
  if (history.at(-1) !== id) return; // another note was opened meanwhile
  if (error) {
    setChildren(body, el("p", { class: "empty", text: `Couldn't open ${id}: ${error.message}` }));
    return;
  }
  const source = sourceOf(note.kind);
  $("#drawer-kind").textContent = source?.label || note.kind;
  const header = !source ? conceptHeader : source.format === "video" && note.fields.video_id ? videoHeader : captureHeader;
  setChildren(body, header(note),
    el("div", { class: "md" }, markdown(note.body.replace(/^\s*#\s+.*\n/, ""))),
    linksBlock(note));
  body.scrollTop = 0;
}

// The note's own link, only if it really is a YouTube page: notes are written from untrusted
// transcripts, so a `url: javascript:...` must never become a link.
function youtubeUrl(fields) {
  if (/^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(fields.url || "")) return fields.url;
  return /^[\w-]{11}$/.test(fields.video_id || "") ? `https://www.youtube.com/watch?v=${fields.video_id}` : null;
}

export function drawerBack() {
  history.pop();
  const prev = history.at(-1);
  if (prev) openNote(prev, { back: true });
  else closeDrawer();
}

function videoHeader(note) {
  const f = note.fields;
  const rec = store.brain?.byId.get(note.id);
  const signal = /^\d$/.test(f.signal || "") ? `signal ${f.signal}/5` : null;
  const url = youtubeUrl(f);
  return [
    f.video_id && url && el("a", { class: "poster", href: url, target: "_blank", rel: "noopener noreferrer" },
      el("img", { src: thumb(f.video_id), alt: "", loading: "lazy" }),
      el("span", { class: "play", text: `▶ Watch${f.duration ? ` · ${f.duration}` : ""}` })),
    el("h2", { text: f.title || note.id }),
    el("div", { class: "byline", text: [f.channel, f.published && `published ${fmtDay(f.published, { year: true })}`,
      f.captured && `captured ${fmtDay(f.captured, { year: true })}`].filter(Boolean).join(" · ") }),
    el("div", { class: "chips" }, verdictChip(f.verdict, note.kind), signal && el("span", { class: "chip", text: signal }),
      f.novelty && el("span", { class: "chip", text: `novelty ${f.novelty}` }),
      rec?.trust && el("span", { class: "chip", text: `trust ${rec.trust}` }),
      clusterChip(note.cluster)),
    actions(note, url),
  ];
}

// The note's own link, only if it points where its source lives (sources.py url_prefix).
function sourceUrl(fields, source) {
  const url = fields.url || "";
  return source?.url_prefix && url.startsWith(source.url_prefix) && /^[^\s<>"']+$/.test(url) ? url : null;
}

// What you did on LinkedIn: "saved", "sent by hand", or the reaction ("reacted: like").
const ACTIONS = { saved: "saved", manual: "sent by hand", repost: "reposted" };
export const actionText = (action) => ACTIONS[action] || (action ? `reacted: ${action}` : "");

// The header of a note from any source other than a video with its thumbnail: a LinkedIn
// post, and whatever source comes next (X posts…), told apart by sources.py.
function captureHeader(note) {
  const f = note.fields;
  const source = sourceOf(note.kind);
  const rec = store.brain?.byId.get(note.id);
  const signal = /^\d$/.test(f.signal || "") ? `signal ${f.signal}/5` : null;
  const url = sourceUrl(f, source);
  // A post known only by its key has no link of its own: its url is its author's page.
  const toAuthor = f.urn === "";
  const published = /^\d{4}-\d{2}-\d{2}$/.test(f.published || "") ? `published ${fmtDay(f.published, { year: true })}` : null;
  return [
    el("h2", { text: rec?.title || f.title || note.id.replace(/^[^/]+\/|\.md$/g, "") }),
    el("div", { class: "byline", text: [rec?.channel || f.author || f.channel, f.headline, published,
      f.captured && `${actionText(f.action) || "captured"} ${fmtDay(f.captured, { year: true })}`].filter(Boolean).join(" · ") }),
    el("div", { class: "chips" }, verdictChip(f.verdict, note.kind), signal && el("span", { class: "chip", text: signal }),
      rec?.trust && el("span", { class: "chip", text: `trust ${rec.trust}` }), clusterChip(note.cluster)),
    el("div", { class: "actions" },
      el("a", { class: "btn primary", href: note.uri }, "Open in Obsidian"),
      url && el("a", { class: "btn", href: url, target: "_blank", rel: "noopener noreferrer",
        title: toAuthor ? `${source.platform} didn't show this note's own link: this opens its ${source.by}` : `Open it on ${source.platform}` },
      toAuthor ? `${source.by[0].toUpperCase()}${source.by.slice(1)} on ${source.platform}` : source.platform),
      el("a", { class: "btn", href: `#/graph?focus=${encodeURIComponent(note.id)}` }, "Show in graph"),
      el("a", { class: "btn", href: `#/search?q=${encodeURIComponent(searchFor(note))}` }, `More from this ${source.by}`)),
  ];
}

function conceptHeader(note) {
  const f = note.fields;
  const aliases = Array.isArray(f.aliases) ? f.aliases : [];
  return [
    el("h2", { text: note.id.replace(/^concepts\/|\.md$/g, "") }),
    aliases.length > 0 && el("div", { class: "byline", text: `also: ${aliases.join(", ")}` }),
    f.summary && el("p", { class: "summary", text: f.summary }),
    el("div", { class: "chips" }, clusterChip(note.cluster),
      ...(Array.isArray(f.tags) ? f.tags : []).map((t) => el("span", { class: "chip", text: `#${t}` })),
      f.updated && el("span", { class: "chip", text: `updated ${fmtDay(f.updated)}` })),
    actions(note),
  ];
}

function clusterChip(id) {
  const c = store.brain?.clusterById.get(id);
  if (!c) return null;
  return el("a", { class: "chip", href: `#/graph?cluster=${id}`, title: "Show this topic in the graph" },
    el("span", { class: "sw", style: { background: clusterColor(id) } }), c.label);
}

function actions(note, youtube) {
  return el("div", { class: "actions" },
    el("a", { class: "btn primary", href: note.uri }, "Open in Obsidian"),
    youtube && el("a", { class: "btn", href: youtube, target: "_blank", rel: "noopener noreferrer" }, "YouTube"),
    el("a", { class: "btn", href: `#/graph?focus=${encodeURIComponent(note.id)}` }, "Show in graph"),
    el("a", { class: "btn", href: `#/search?q=${encodeURIComponent(searchFor(note))}` }, "Search mentions"));
}

function searchFor(note) {
  if (note.kind === "concept") return `concept:"${note.id.replace(/^concepts\/|\.md$/g, "")}"`;
  const by = store.brain?.byId.get(note.id)?.channel || note.fields.channel || note.fields.author || "";
  return `type:${note.kind} channel:"${by}"`;
}

function linksBlock(note) {
  if (!note.links.length) return null;
  const group = (kind, title) => {
    const items = note.links.filter((l) => l.kind === kind);
    return items.length > 0 && [el("h3", { text: `${title} · ${items.length}` }), el("ul", {}, items.map((l) => el("li", {},
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openNote(l.id); } },
        el("span", { class: `sw${kind === "concept" ? " round" : ""}`, style: { background: clusterColor(l.cluster) } }), l.title),
      l.relation === "related" && el("span", { class: "rel", text: "related" }))))];
  };
  return el("div", { class: "links-block" },
    group("concept", note.kind === "concept" ? "Connected concepts" : "Concepts it covers"),
    (store.brain?.sources || []).map((s) => group(s.key, `Seen in ${s.label}s`)));
}
