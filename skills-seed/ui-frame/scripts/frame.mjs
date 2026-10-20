#!/usr/bin/env node
// Show one or more web pages as movable iframe windows on the person's QM web UI canvas.
// Usage: node frame.mjs <https-url>... [--title T]... [--width PX] [--height PX] [--pin] [--always-on]
//                       [--force] [--no-check] [--dry-run]
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: "string", multiple: true, default: [] },
    width: { type: "string", default: "960" },
    height: { type: "string", default: "640" },
    pin: { type: "boolean", default: false },
    "always-on": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "no-check": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const fail = (message, code = 2) => {
  console.error(`frame: ${message}`);
  process.exit(code);
};

if (!positionals.length) fail("give at least one https:// URL");
if (positionals.length > 6) fail("at most 6 windows at once");
const size = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 160 || n > 4000) fail(`--${name} must be a whole number of pixels, 160-4000`);
  return n;
};
const width = size(values.width, "width");
const height = size(values.height, "height");

const frames = positionals.map((raw, i) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`not a URL: ${raw}`);
  }
  if (url.protocol !== "https:") fail(`only https:// pages can be framed: ${raw}`);
  if (url.username || url.password) fail(`remove credentials from the URL: ${url.host}`);
  return { url: url.href, title: values.title[i] ?? url.hostname };
});

// Pages that refuse framing render as a blank or error box; catch the common cases before sending.
function framingBlock(headers) {
  const xfo = (headers.get("x-frame-options") ?? "").trim().toLowerCase();
  if (xfo === "deny" || xfo === "sameorigin") return `X-Frame-Options: ${xfo.toUpperCase()}`;
  const csp = headers.get("content-security-policy") ?? "";
  const directive = csp
    .split(/[;,]/)
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith("frame-ancestors"));
  if (!directive) return null;
  const sources = directive.split(/\s+/).slice(1);
  if (sources.includes("*")) return null;
  if (!sources.length || sources.every((s) => ["'none'", "'self'"].includes(s.toLowerCase())))
    return `CSP ${directive}`;
  return `maybe: CSP ${directive} (the QM web origin must be listed)`;
}

if (!values["no-check"]) {
  for (const f of frames) {
    let res;
    try {
      res = await fetch(f.url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel();
    } catch (error) {
      console.error(`frame: warning: could not check ${f.url}: ${error.message}`);
      continue;
    }
    const block = framingBlock(res.headers);
    if (res.status >= 400) console.error(`frame: warning: ${f.url} answered HTTP ${res.status} from here`);
    if (!block) continue;
    if (block.startsWith("maybe:")) console.error(`frame: warning: ${f.url} ${block.slice(7)}`);
    else if (!values.force)
      fail(
        `${f.url} refuses to be framed (${block}). Link to it instead, or pass --force if it allows the QM origin.`,
        3,
      );
    else console.error(`frame: warning: ${f.url} sends ${block}; framing anyway (--force)`);
  }
}

const attr = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const html = frames
  .map(
    (f) => `<section class="qf-win" data-src="${attr(f.url)}" data-w="${width}" data-h="${height}">
  <header class="qf-bar"><span class="qf-title" title="${attr(f.url)}">${attr(f.title)}</span>
    <button class="qf-btn" data-act="reload" title="Reload">&#x21bb;</button>
    <a class="qf-btn" href="${attr(f.url)}" target="_blank" rel="noopener noreferrer" title="Open in a new tab">&#x2197;</a>
    <button class="qf-btn" data-act="min" title="Minimize">&#x2013;</button>
    <button class="qf-btn" data-act="close" title="Close window">&#x2715;</button></header>
  <iframe class="qf-frame" title="${attr(f.title)}" referrerpolicy="strict-origin-when-cross-origin"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
    allow="fullscreen; clipboard-write"></iframe>
</section>`,
  )
  .join("\n");

const css = `.qf-win{position:fixed;display:flex;flex-direction:column;min-width:240px;min-height:120px;max-width:100vw;max-height:100vh;
background:#fff;border:1px solid rgba(0,0,0,.18);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;
resize:both;pointer-events:auto;font:12px/1.2 system-ui,-apple-system,sans-serif;color:#222}
.qf-win.min{height:auto!important;min-height:0;resize:none}.qf-win.min .qf-frame{display:none}
.qf-bar{display:flex;align-items:center;gap:2px;padding:4px 6px 4px 10px;background:#f4f4f5;border-bottom:1px solid rgba(0,0,0,.1);
cursor:grab;user-select:none;touch-action:none}.qf-win.drag .qf-bar{cursor:grabbing}
.qf-title{flex:1;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.qf-btn{all:unset;cursor:pointer;width:22px;height:22px;display:grid;place-items:center;border-radius:5px;color:#555}
.qf-btn:hover{background:rgba(0,0,0,.08)}.qf-frame{flex:1;width:100%;border:0;background:#fff}
.qf-win.drag .qf-frame{pointer-events:none}.qf-note{padding:16px;color:#a00}`;

// Fixed code: the windows' URLs and titles arrive only as escaped HTML attributes above.
const js = `const wins = [...canvas.root.querySelectorAll(".qf-win")];
let z = 1;
wins.forEach((win, i) => {
  const w = Math.min(Number(win.dataset.w), innerWidth - 24), h = Math.min(Number(win.dataset.h), innerHeight - 24);
  Object.assign(win.style, { width: w + "px", height: h + "px",
    left: Math.max(12, (innerWidth - w) / 2 + i * 32) + "px", top: Math.max(12, (innerHeight - h) / 3 + i * 32) + "px" });
  const frame = win.querySelector("iframe"), src = new URL(win.dataset.src);
  if (src.protocol !== "https:" || src.origin === location.origin) {
    frame.replaceWith(Object.assign(document.createElement("div"), { className: "qf-note", textContent: "This page can't be framed here." }));
  } else frame.src = src.href;
  win.addEventListener("pointerdown", () => { win.style.zIndex = String(++z); }, { signal: canvas.signal });
  win.querySelector(".qf-bar").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "reload" && frame.isConnected) frame.src = src.href;
    if (act === "min") win.classList.toggle("min");
    if (act === "close") win.remove();
  }, { signal: canvas.signal });
  const bar = win.querySelector(".qf-bar");
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".qf-btn")) return;
    const dx = e.clientX - win.offsetLeft, dy = e.clientY - win.offsetTop;
    bar.setPointerCapture(e.pointerId);
    win.classList.add("drag");
    const move = (m) => {
      win.style.left = Math.min(Math.max(m.clientX - dx, 40 - win.offsetWidth), innerWidth - 40) + "px";
      win.style.top = Math.min(Math.max(m.clientY - dy, 0), innerHeight - 28) + "px";
    };
    const up = () => { win.classList.remove("drag"); bar.removeEventListener("pointermove", move); };
    bar.addEventListener("pointermove", move, { signal: canvas.signal });
    bar.addEventListener("pointerup", up, { once: true, signal: canvas.signal });
    bar.addEventListener("pointercancel", up, { once: true, signal: canvas.signal });
  }, { signal: canvas.signal });
});`;

const body = { html, css, js, pinned: values.pin, replace: true, ...(values["always-on"] ? { alwaysOn: true } : {}) };
if (values["dry-run"]) {
  process.stdout.write(JSON.stringify(body, null, 2) + "\n");
  process.exit(0);
}
const { AGENT_API_URL, AGENT_API_TOKEN } = process.env;
if (!AGENT_API_URL || !AGENT_API_TOKEN) fail("AGENT_API_URL and AGENT_API_TOKEN must be set");
const res = await fetch(`${AGENT_API_URL}/v1/ui/canvas`, {
  method: "POST",
  headers: { "x-agent-capability": AGENT_API_TOKEN, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
if (!res.ok) fail(`canvas write failed: HTTP ${res.status} ${text}`, 1);
process.stdout.write(text + "\n");
