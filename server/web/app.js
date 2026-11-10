// Router, top bar and theme. Each view module exports mount(root, params), which
// returns { update(params), unmount() }.

import * as dashboard from "./dashboard.js";
import * as graph from "./graph.js";
import * as search from "./search.js";
import { $, setChildren, store, loadBrain, onBrain, closeDrawer, drawerBack, plural, ago, hideTip } from "./ui.js";

const VIEWS = { dashboard, graph, search };
const REFRESH_MS = 20000; // new captures show up without reloading the page
let current = null;

function parseHash() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  return { name: VIEWS[path] ? path : "dashboard", params: new URLSearchParams(query || "") };
}

function route() {
  const { name, params } = parseHash();
  hideTip();
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  $("#quick").hidden = name === "search";
  if (current?.name === name) return current.view.update?.(params);
  current?.view.unmount?.();
  const root = $("#view");
  setChildren(root);
  current = { name, view: VIEWS[name].mount(root, params) };
  window.scrollTo(0, 0);
}

function renderStatus() {
  const s = $("#status");
  const b = store.brain;
  s.className = `status ${store.error ? "off" : b ? "on" : ""}`;
  s.lastElementChild.textContent = store.error
    ? "server offline"
    : b ? [...b.sources.map((src, i) => {
      const n = b.byKind.get(src.key).length;
      return (n || i === 0) && plural(n, src.one, src.many); // the first source always, the others once they have notes
    }), plural(b.concepts.length, "concept")].filter(Boolean).join(" · ") : "connecting…";
  s.title = b ? `Vault read ${ago(b.generated)} ago` : "";
}

// ------------------------------------------------------------ theme

const THEME_KEY = "yb-theme";
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.dispatchEvent(new Event("themechange"));
}
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* storage blocked: follow the OS */ }
$("#theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* fine, just not remembered */ }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => document.dispatchEvent(new Event("themechange")));

// ------------------------------------------------------------ global keys and search

$("#quick").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#quick-q").value.trim();
  $("#quick-q").value = "";
  location.hash = `#/search?q=${encodeURIComponent(q)}`;
});

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === "/" && !typing) {
    e.preventDefault();
    ($("#search-q") || $("#quick-q")).focus();
  } else if (e.key === "Escape" && !$("#drawer").hidden) {
    closeDrawer();
  }
});
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-back").addEventListener("click", drawerBack);

// ------------------------------------------------------------ start

onBrain(renderStatus);
window.addEventListener("hashchange", route);
route();
loadBrain();
setInterval(() => {
  if (document.visibilityState === "visible") loadBrain();
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadBrain();
});
