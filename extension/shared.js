export const SERVER = "http://127.0.0.1:8765";
export const ACTIVE = ["queued", "transcript", "analyzing"];
export const VIDEO_URL = /^https:\/\/((www|m)\.)?youtube\.com\/(watch\?|shorts\/|live\/)|^https:\/\/youtu\.be\//;

// The sites whose posts the extension reads. Each has its scripts (capture.js, then the one that
// knows its pages), the source its posts become on the server (server/sources.py), its pages,
// and the popup's two switches. A new site: an entry here, its script, and its matches in manifest.json.
export const SITES = [
  {
    key: "linkedin", source: "post", name: "LinkedIn",
    url: /^https:\/\/www\.linkedin\.com\//,
    // A single post's page: /feed/update/urn:li:activity:<id>/ or /posts/<author>_<slug>-activity-<id>-…
    postPage: /^https:\/\/www\.linkedin\.com\/(feed\/update\/urn(:|%3A)li|posts\/)/i,
    patterns: ["https://www.linkedin.com/*"],
    scripts: ["capture.js", "linkedin.js"],
    save: "Send the posts I save", react: "Send the posts I react to",
  },
  {
    key: "x", source: "xpost", name: "X",
    url: /^https:\/\/(x|twitter)\.com\//,
    postPage: /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/,
    patterns: ["https://x.com/*", "https://twitter.com/*"],
    scripts: ["capture.js", "x.js"],
    save: "Send the posts I bookmark", react: "Send the posts I like or repost",
  },
];
export const siteOf = (url) => SITES.find((site) => site.url.test(url || "")) || null;

export const isActive = (job) => ACTIVE.includes(job.status);
// What a job is about: a video id or a post's id.
export const refOf = (job) => job.video_id || job.post_id;

export function cleanTitle(tabTitle) {
  return (tabTitle || "").replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "");
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "3 new concepts · 1 updated · 1 warning"
export function changeSummary(job) {
  const concepts = (list) => (list || []).filter((c) => c.kind === "concept").length;
  const created = concepts(job.changes?.created);
  const updated = concepts(job.changes?.updated);
  const warnings = job.warnings?.length || 0;
  return [
    created && `${plural(created, "new concept")}`,
    updated && `${updated} updated`,
    warnings && plural(warnings, "warning"),
  ]
    .filter(Boolean)
    .join(" · ");
}
