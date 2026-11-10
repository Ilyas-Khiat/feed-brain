import { SERVER, VIDEO_URL, SITES, siteOf, isActive, cleanTitle, changeSummary, refOf } from "./shared.js";

async function getJobs() {
  const { jobs = [] } = await chrome.storage.local.get("jobs");
  return jobs;
}

async function saveJobs(jobs) {
  await chrome.storage.local.set({ jobs: jobs.slice(0, 30) });
  const n = jobs.filter(isActive).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#F04854" });
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(SERVER + path, options);
  } catch {
    throw new Error("Brain server is offline. Run server/start.cmd.");
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Server error ${res.status}`);
  return body;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// Queue a video or a post on the server, and list it in the popup's recent runs.
async function submit(body, title) {
  const job = await api("/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const entry = { ...job, title: job.title || title, key: job.id || `exists-${refOf(job)}` };
  const jobs = (await getJobs()).filter((j) => j.key !== entry.key && refOf(j) !== refOf(entry));
  jobs.unshift(entry);
  await saveJobs(jobs);
  if (isActive(entry)) chrome.alarms.create("poll", { periodInMinutes: 0.5 });
  return entry;
}

async function capture(tab, { focus = "", force = false } = {}) {
  if (!tab || !VIDEO_URL.test(tab.url || "")) throw new Error("Open a YouTube video first.");
  const title = cleanTitle(tab.title);
  return submit({ url: tab.url, title, focus, force }, title);
}

// Chrome only adds a site's scripts to pages opened after the extension (re)loads: add them to a
// tab of that site that was already open.
const addScripts = (tabId, site) => chrome.scripting.executeScript({ target: { tabId }, files: site.scripts });

// A post, as the tab's content scripts (capture.js and the site's own) read it. Only the top frame has them.
async function readPost(tab, type) {
  const site = siteOf(tab?.url);
  if (!site) throw new Error("Open a post on LinkedIn or X first.");
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 });
  } catch (e) {
    console.warn(`The ${site.name} page didn't answer ${type}, adding the scripts to the tab:`, e);
    try {
      await addScripts(tab.id, site);
    } catch {
      throw new Error(`Reload this ${site.name} tab first: it was open before the extension was loaded.`);
    }
    // The click that opened the menu happened before the script was there.
    throw new Error("Feed Brain is ready on this page now: right-click the post again.");
  }
  if (!res?.post) throw new Error(res?.error || "Couldn't find a post here.");
  return res.post;
}

// A post read whole from its own page, in a background tab that closes right after: what a
// timeline shows of an X article is its title and a few lines (x.js marks it `partial`).
async function readFromPage(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: "brain-read-page" }, { frameId: 0 });
        if (res?.post && !res.post.partial) return res.post;
      } catch {
        // the page or its scripts aren't there yet
      }
    }
    return null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// `source` is the server's name for the kind of post (sources.py): "post" for LinkedIn, "xpost" for X.
async function capturePost(post, action, source, force = false) {
  const page = typeof post?.page === "string" ? post.page : "";
  if (post?.partial && siteOf(page)?.postPage.test(page)) {
    // If the page can't be read in time, the start is sent, marked as cut short.
    post = (await readFromPage(page).catch(() => null)) || post;
  }
  return submit({ kind: "post", source, post, action, force });
}

// The post a page is about (a post's own page), sent by hand.
async function capturePagePost(tab, force = false) {
  const post = await readPost(tab, "brain-read-page");
  return capturePost(post, "manual", siteOf(tab.url).source, force);
}

// Tell the page what happened (capture.js shows it at the bottom of the page), or fall back to a
// notification when the page can't show it.
function tellPage(tab, text, tone) {
  chrome.tabs.sendMessage(tab.id, { type: "brain-toast", text, tone }, { frameId: 0 }).catch(() => message("Feed Brain", text));
}

async function poll() {
  const jobs = await getJobs();
  const active = jobs.filter((j) => j.id && isActive(j));
  if (!active.length) {
    await chrome.alarms.clear("poll");
    return;
  }
  let fresh;
  try {
    fresh = (await api(`/jobs?ids=${active.map((j) => j.id).join(",")}`)).jobs;
  } catch {
    return; // server offline for now; try again on the next tick
  }
  const byId = Object.fromEntries(fresh.map((j) => [j.id, j]));
  for (const job of active) {
    const update = byId[job.id] || {
      status: "failed",
      error: "The server restarted and lost this job. Send it again.",
    };
    Object.assign(job, update, { key: job.key });
    if (!isActive(job)) notify(job);
  }
  await saveJobs(jobs);
}

function notify(job) {
  const done = job.status === "done";
  const verdict = job.verdict ? job.verdict[0].toUpperCase() + job.verdict.slice(1) : "Saved";
  const changes = changeSummary(job);
  chrome.notifications.create(`job:${job.key}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: done ? `${verdict}: ${job.title}` : `Failed: ${job.title || refOf(job)}`,
    message: done
      ? [changes, job.summary || "Saved to your vault. Click to open it in Obsidian."].filter(Boolean).join("\n")
      : job.error || "Unknown error",
    silent: Boolean(job.post_id), // posts (LinkedIn, X…) arrive as you scroll: no sound for each one
  });
}

function message(title, text) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message: text });
}

// After a capture you asked for (shortcut, right-click): say it's on its way, or already there.
function sent(job) {
  if (job.status === "exists") return notify({ ...job, status: "done", summary: "Already in your vault. Click to open it." });
  chrome.notifications.create(`queued:${job.key}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Sent to your brain",
    message: job.title || refOf(job),
  });
}

async function openInObsidian(uri) {
  // Opening an external protocol keeps the current page and just asks to launch Obsidian.
  if (uri) await chrome.tabs.update({ url: uri });
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const job = (await getJobs()).find((j) => `job:${j.key}` === id);
  if (job?.obsidian_uri) openInObsidian(job.obsidian_uri);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll") poll();
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "capture") return;
  try {
    tab = tab || (await activeTab());
    const site = siteOf(tab?.url);
    if (site?.postPage.test(tab.url)) return sent(await capturePagePost(tab));
    if (site) throw new Error("On the feed, right-click a post and pick “Send this post to your brain”.");
    sent(await capture(tab));
  } catch (e) {
    message("Feed Brain", e.message);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  // Right-click a post on LinkedIn or X → "Send this post to your brain".
  chrome.contextMenus.removeAll(() =>
    chrome.contextMenus.create({
      id: "send-post",
      title: "Send this post to your brain",
      contexts: ["page", "selection", "link", "image", "video"],
      documentUrlPatterns: SITES.flatMap((site) => site.patterns),
    }),
  );
  // So saves and reactions work in the tabs already open, without reloading them.
  for (const site of SITES) {
    for (const tab of await chrome.tabs.query({ url: site.patterns })) {
      addScripts(tab.id, site).catch((e) => console.warn(`Couldn't add the ${site.name} scripts to an open tab:`, e));
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "send-post" || !tab) return;
  try {
    if (info.frameId) throw new Error("Right-click the post's text: what's inside its attachment can't be read.");
    const job = await capturePost(await readPost(tab, "brain-read-clicked"), "manual", siteOf(tab.url)?.source);
    tellPage(tab, job.status === "exists" ? "Already in your brain." : `Sent to your brain: ${job.title}`, "ok");
  } catch (e) {
    console.warn("Send this post failed:", e);
    tellPage(tab, e.message, "error");
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    capture: async () => capture(await activeTab(), msg),
    "capture-page-post": async () => capturePagePost(await activeTab(), msg.force),
    "capture-post": async () => capturePost(msg.post, msg.action, msg.source), // from capture.js: a save or a reaction
    poll: async () => poll(),
    health: async () => api("/health"),
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // keep the channel open for the async response
});

chrome.runtime.onStartup.addListener(async () => {
  if ((await getJobs()).some(isActive)) chrome.alarms.create("poll", { periodInMinutes: 0.5 });
});
