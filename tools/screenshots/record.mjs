// Record a scripted demo of the web app as frames, for ffmpeg to turn into a GIF or MP4 (Node 22+).
//
//   node tools/screenshots/record.mjs tools/screenshots/demo.json FRAMES_DIR
//
// Point it at a dev server (tools/dev_server.py), never at your real one. demo.json has
//   width, height, theme   the viewport and colour scheme
//   steps                  played in order:
//     { "go": "#/graph" }                         open a route
//     { "wait": 2000 }                            ms
//     { "click": "css selector" }                 click an element's centre
//     { "type": "css selector", "text": "…", "delay": 60 }   type into an element, key by key
//     { "key": "Enter" }                          press a key
//     { "until": "js expression", "timeout": 60000 }  wait until the page says it's ready
//     { "scroll": 400, "ms": 1200 }               scroll down smoothly
// It writes FRAMES_DIR/NNNNN.jpg plus FRAMES_DIR/frames.txt, an ffmpeg concat list with each
// frame's real duration. Env: BASE (default http://127.0.0.1:8766/), CHROME, CDP_PORT.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [, , scriptFile, outDir] = process.argv;
if (!scriptFile || !outDir) { console.error("usage: node record.mjs <demo.json> <frames dir>"); process.exit(2); }
const demo = JSON.parse(readFileSync(scriptFile, "utf8"));
mkdirSync(outDir, { recursive: true });
const BASE = process.env.BASE || "http://127.0.0.1:8766/";
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9334);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "record-"))}`, "about:blank"],
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
const frames = [];
let recording = false;
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Page.screencastFrame") {
    const { data, metadata, sessionId } = m.params;
    if (recording) frames.push({ data, t: metadata.timestamp });
    ws.send(JSON.stringify({ id: ++id, method: "Page.screencastFrameAck", params: { sessionId } }));
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const centre = (selector) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
  if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

const width = demo.width || 1280, height = demo.height || 760, theme = demo.theme || "dark";
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
await send("Page.navigate", { url: BASE });
await sleep(800);
await evaluate(`localStorage.setItem("yb-theme", ${JSON.stringify(theme)}); 1`);
await send("Page.navigate", { url: BASE });
await sleep(1500);
await send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: width, maxHeight: height });
recording = true;

for (const step of demo.steps) {
  if (step.go !== undefined) await evaluate(`location.hash = ${JSON.stringify(step.go)}; 1`);
  else if (step.wait) await sleep(step.wait);
  else if (step.click) {
    const p = await centre(step.click);
    if (!p) throw new Error(`nothing matches ${step.click}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
  } else if (step.type) {
    await evaluate(`document.querySelector(${JSON.stringify(step.type)}).focus(); 1`);
    for (const ch of step.text) { await send("Input.insertText", { text: ch }); await sleep(step.delay ?? 60); }
  } else if (step.key) {
    const code = step.key === "Enter" ? 13 : 0;
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key: step.key, code: step.key, windowsVirtualKeyCode: code, text: type === "keyDown" && step.key === "Enter" ? "\r" : undefined });
  } else if (step.until) {
    const end = Date.now() + (step.timeout || 60000);
    while (!(await evaluate(step.until))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${step.until}`);
      await sleep(250);
    }
  } else if (step.scroll) {
    const n = Math.max(1, Math.round((step.ms || 1000) / 40));
    for (let i = 0; i < n; i++) { await evaluate(`window.scrollBy(0, ${step.scroll / n}); 1`); await sleep(40); }
  }
}
await sleep(300);
recording = false;
await send("Page.stopScreencast");

// Each frame lasts until the next one; the last one is held for a moment.
const lines = [];
frames.forEach((f, i) => {
  const name = String(i).padStart(5, "0") + ".jpg";
  writeFileSync(join(outDir, name), Buffer.from(f.data, "base64"));
  const next = frames[i + 1]?.t ?? f.t + 1.5;
  lines.push(`file '${name}'`, `duration ${Math.max(0.02, next - f.t).toFixed(3)}`);
});
lines.push(`file '${String(frames.length - 1).padStart(5, "0")}.jpg'`);
writeFileSync(join(outDir, "frames.txt"), lines.join("\n") + "\n");
console.log(`${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)} s`);
ws.close();
chrome.kill();
process.exit(0);
