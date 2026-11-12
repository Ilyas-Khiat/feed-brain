// Screenshots of the web app, through headless Chrome's DevTools protocol (Node 22+, no packages).
//
//   node tools/screenshots/shoot.mjs tools/screenshots/readme.json docs/images
//
// Point it at a dev server (tools/dev_server.py), never at your real one. Each shot in the JSON:
//   name    file name, without .png
//   path    the app route, e.g. "#/graph" or "#/search?q=agents"
//   theme   "light" or "dark" (sets prefers-color-scheme and the app's own theme switch)
//   width, height   viewport, default 1440 x 900
//   wait    ms to let the page settle (the graph needs ~7000 for its layout)
//   steps   [{ js, wait, log }]: JavaScript to run before the shot, e.g. a click
//   clip    { x, y, width, height }: crop, in page pixels (can reach below the viewport)
// Env: BASE (default http://127.0.0.1:8766/), CHROME (path to chrome), CDP_PORT (default 9333).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [, , shotsFile, outDir] = process.argv;
if (!shotsFile || !outDir) { console.error("usage: node shoot.mjs <shots.json> <outdir>"); process.exit(2); }
const shots = JSON.parse(readFileSync(shotsFile, "utf8"));
mkdirSync(outDir, { recursive: true });
const BASE = process.env.BASE || "http://127.0.0.1:8766/";
const CHROME = process.env.CHROME || {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
}[process.platform] || "google-chrome"; // Linux: google-chrome, or set CHROME=chromium
const PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "shoot-"))}`, "about:blank"],
  { stdio: "ignore" });

let page;
for (let i = 0; i < 50 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch {}
  if (!page) await sleep(200);
}
if (!page) { chrome.kill(); throw new Error("Chrome didn't start: set CHROME to its path"); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

await send("Page.enable");
await send("Runtime.enable");
for (const s of shots) {
  const theme = s.theme || "dark";
  await send("Emulation.setDeviceMetricsOverride", { width: s.width || 1440, height: s.height || 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await send("Page.navigate", { url: BASE });  // the app's theme switch lives in localStorage
  await sleep(800);
  await evaluate(`localStorage.setItem("yb-theme", ${JSON.stringify(theme)}); 1`);
  await send("Page.navigate", { url: "about:blank" });
  await sleep(200);
  await send("Page.navigate", { url: new URL(s.path || "", BASE).href });
  await sleep(s.wait || 3000);
  for (const step of s.steps || []) {
    const out = await evaluate(step.js);
    if (step.log) console.log(s.name, "→", JSON.stringify(out));
    await sleep(step.wait || 1000);
  }
  const shot = await send("Page.captureScreenshot", s.clip
    ? { format: "png", clip: { ...s.clip, scale: 1 }, captureBeyondViewport: true }
    : { format: "png" });
  writeFileSync(join(outDir, `${s.name}.png`), Buffer.from(shot.data, "base64"));
  console.log("wrote", s.name);
}
ws.close();
chrome.kill();
process.exit(0);
