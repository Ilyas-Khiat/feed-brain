import { SERVER, VIDEO_URL, siteOf, cleanTitle, changeSummary, refOf } from "./shared.js";

const STAGES = {
  queued: "Queued",
  transcript: "Reading transcript",
  analyzing: "Writing notes",
};

const $ = (id) => document.getElementById(id);
const openPanels = new Set(); // job keys whose "changes" panel is expanded, kept across re-renders
let autoOpened = false;
let mode = null; // what this tab shows: "video", "post" (a post's own page on LinkedIn or X), "feed" (the rest of those sites)

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function showMessage(text, isError = false) {
  const el = $("message");
  el.textContent = text;
  el.className = "message" + (isError ? " error" : "");
  el.hidden = !text;
}

function ago(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}

function openLink(uri, label = "Open in Obsidian") {
  // A plain link to obsidian:// launches Obsidian and leaves the popup where it is.
  return el("a", { href: uri, textContent: label });
}

function updateDetail(change) {
  const parts = [];
  if (change.added) parts.push(`+${change.added} line${change.added === 1 ? "" : "s"}`);
  if (change.removed) parts.push(`${change.removed} reworded`);
  if (change.fields?.length) parts.push(change.fields.join(", "));
  return parts.join(" · ");
}

function changeRow(tag, change, detail) {
  return el(
    "li",
    {},
    el("span", { className: `tag ${tag}`, textContent: tag }),
    el(
      "div",
      { className: "change-body" },
      el("a", { href: change.uri, textContent: change.kind === "concept" ? change.name : change.path, title: change.path }),
      detail && el("span", { className: "detail", textContent: detail }),
    ),
  );
}

// What the run created and modified, apart from the video note itself.
function renderChanges(job) {
  const others = (list) => (list || []).filter((c) => c.path !== job.note);
  const created = others(job.changes?.created);
  const updated = others(job.changes?.updated);
  const warnings = job.warnings || [];
  if (!created.length && !updated.length && !warnings.length) return null;

  const details = el(
    "details",
    { className: "changes", open: openPanels.has(job.key) },
    el("summary", { textContent: changeSummary(job) || "Changes" }),
    el(
      "ul",
      {},
      ...created.map((c) => changeRow("new", c, c.summary)),
      ...updated.map((c) => changeRow("updated", c, updateDetail(c))),
    ),
    ...warnings.map((w) => el("p", { className: "warning", textContent: w })),
  );
  details.addEventListener("toggle", () => {
    if (details.open) openPanels.add(job.key);
    else openPanels.delete(job.key);
  });
  return details;
}

function renderJob(job) {
  const meta = el("div", { className: "meta" });
  if (job.status in STAGES) {
    meta.append(el("span", { className: "chip busy", textContent: STAGES[job.status] }), ago(job.created));
  } else if (job.status === "done" || job.status === "exists") {
    const v = (job.verdict || "").toLowerCase();
    if (v) meta.append(el("span", { className: `chip ${v}`, textContent: v }));
    if (job.post_id && job.action) meta.append(job.action); // a post from any site: saved, like, repost…
    if (job.note_words) meta.append(`${Math.max(1, Math.round(job.note_words / 230))} min read`);
    if (job.status === "exists") meta.append("already in vault");
    meta.append(openLink(job.obsidian_uri));
  } else if (job.status === "failed") {
    meta.append(el("span", { className: "chip skip", textContent: "failed" }));
  }
  return el(
    "li",
    {},
    el("span", { className: "title", textContent: job.title || refOf(job), title: job.title || "" }),
    meta,
    job.status === "failed" && el("div", { className: "error", textContent: job.error }),
    job.status !== "exists" && renderChanges(job),
  );
}

async function renderJobs() {
  const { jobs = [] } = await chrome.storage.local.get("jobs");
  if (!autoOpened) {
    // Expand the latest finished run once, so its changes are visible straight away.
    const latest = jobs.find((j) => j.status === "done");
    if (latest) openPanels.add(latest.key);
    autoOpened = true;
  }
  $("jobs").replaceChildren(...jobs.slice(0, 8).map(renderJob));
  $("empty").hidden = jobs.length > 0;
}

async function checkServer() {
  const res = await send({ type: "health" });
  const s = $("server");
  s.className = "server " + (res?.ok ? "on" : "off");
  s.querySelector("span").textContent = res?.ok
    ? `${res.data.vault} · ${res.data.concepts} concepts`
    : "server offline";
  return res?.ok;
}

async function capture(force = false) {
  $("send").disabled = true;
  showMessage("");
  const res = await send(mode === "post" ? { type: "capture-page-post", force } : { type: "capture", focus: $("focus").value, force });
  $("send").disabled = false;
  if (!res?.ok) return showMessage(res?.error || "Something went wrong.", true);
  const job = res.data;
  if (job.status === "exists") {
    const again = el("a", { textContent: "process again" });
    again.addEventListener("click", () => capture(true));
    $("message").replaceChildren("Already in your vault. ", openLink(job.obsidian_uri, "Open it"), " or ", again, ".");
    $("message").className = "message";
    $("message").hidden = false;
  } else {
    showMessage("Sent. You can close this popup; you'll get a notification when it's done.");
    $("focus").value = "";
  }
}

// On LinkedIn or X: whether saves and reactions are sent, and whether this page's posts can be read.
async function initSite(tab, site) {
  $("site").hidden = false;
  $("site-name").textContent = site.name;
  $("site-save-text").textContent = site.save;
  $("site-react-text").textContent = site.react;
  const stored = (await chrome.storage.local.get(site.key))[site.key] || {};
  for (const key of ["save", "react"]) {
    const box = $(`site-${key}`);
    box.checked = stored[key] !== false;
    box.addEventListener("change", async () => {
      const current = (await chrome.storage.local.get(site.key))[site.key] || {};
      await chrome.storage.local.set({ [site.key]: { ...current, [key]: box.checked } });
    });
  }
  let status = null;
  try {
    status = await chrome.tabs.sendMessage(tab.id, { type: "brain-status" });
  } catch {
    // the site's scripts aren't in this tab: it was open before the extension was loaded
  }
  $("site-status").textContent = !status
    ? "Reload this tab to start: it was open before the extension was loaded."
    : status.readable
      ? `${status.readable} of ${status.posts} post${status.posts === 1 ? "" : "s"} on this page can be read.`
      : status.posts
        ? `Found ${status.posts} posts but couldn't read their text: ${site.name} may have changed its layout.`
        : "No posts on this page yet. Scroll a little, then reopen this popup.";
  if (mode === "post" && status?.page) {
    const words = (status.page.text || status.page.shared?.text || "").split(/\s+/).slice(0, 12).join(" ");
    $("video").textContent = `${status.page.author || `${site.name} post`}: ${words}…`;
  }
  return !status || mode !== "post" || Boolean(status.page);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  const site = siteOf(url);
  mode = VIDEO_URL.test(url) ? "video" : site?.postPage.test(url) ? "post" : site ? "feed" : null;
  $("video").textContent = {
    video: cleanTitle(tab?.title),
    post: `This ${site?.name} post`,
    feed: "Right-click a post and pick “Send this post to your brain”.",
  }[mode] || "Open a YouTube video, or a post on LinkedIn or X, to send it.";
  $("video").classList.toggle("muted", !mode);
  $("focus").hidden = mode !== "video";
  $("send").textContent = mode === "post" ? "Send this post to my brain" : "Spoil it into my vault";
  $("send").closest(".row").hidden = mode === "feed";
  const canSend = mode === "video" || (mode === "post" && (await initSite(tab, site)));
  if (mode === "feed") await initSite(tab, site);

  // Re-checked every few seconds, so starting the server while the popup is open
  // turns the status green and enables the button without reopening the popup.
  const OFFLINE = "Start the server first: run server/start.cmd.";
  let wasOnline;
  const refreshServer = async () => {
    const online = await checkServer();
    if (online === wasOnline) return;
    wasOnline = online;
    $("send").disabled = !(canSend && online);
    if (!online) showMessage(OFFLINE, true);
    else if ($("message").textContent === OFFLINE) showMessage("");
  };
  await refreshServer();

  $("send").addEventListener("click", () => capture(false));
  $("focus").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !$("send").disabled) capture(false);
  });

  // The dashboard, graph and search are pages served by the brain server.
  const openApp = (hash = "") => {
    chrome.tabs.create({ url: `${SERVER}/${hash}` });
    window.close();
  };
  $("find").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("find-q").value.trim();
    openApp(q ? `#/search?q=${encodeURIComponent(q)}` : "#/search");
  });
  $("dashboard").addEventListener("click", (e) => {
    e.preventDefault();
    openApp();
  });

  renderJobs();
  chrome.storage.onChanged.addListener(renderJobs);
  send({ type: "poll" });
  setInterval(() => {
    send({ type: "poll" });
    refreshServer();
  }, 3000);
}

init();
