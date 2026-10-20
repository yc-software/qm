#!/usr/bin/env node
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: "string", multiple: true, default: [] },
    width: { type: "string", default: "960" },
    height: { type: "string", default: "640" },
    pin: { type: "boolean", default: false },
  },
});

const fail = (message, code = 2) => {
  console.error(`frame: ${message}`);
  process.exit(code);
};

if (!positionals.length) fail("give at least one https:// URL");
const size = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 160 || n > 4000) fail(`--${name} must be a whole number of pixels, 160-4000`);
  return n;
};
const width = size(values.width, "width");
const height = size(values.height, "height");

const attr = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const html = positionals
  .map((raw, i) => {
    let url;
    try {
      url = new URL(raw);
    } catch {
      fail(`not a URL: ${raw}`);
    }
    if (url.protocol !== "https:") fail(`only https:// pages can be framed: ${raw}`);
    if (url.username || url.password) fail(`remove credentials from the URL: ${url.host}`);
    const src = attr(url.href);
    const title = attr(values.title[i] ?? url.hostname);
    return `<section class="qf-win" data-src="${src}" style="width:${width}px;height:${height}px">
  <header class="qf-bar"><span class="qf-title" title="${src}">${title}</span>
    <a class="qf-btn" href="${src}" target="_blank" rel="noopener noreferrer" title="Open in a new tab">&#x2197;</a>
    <button class="qf-btn" title="Close">&#x2715;</button></header>
  <iframe title="${title}" referrerpolicy="strict-origin-when-cross-origin" allow="fullscreen; clipboard-write"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"></iframe>
</section>`;
  })
  .join("\n");

const css = `.qf-win{position:fixed;display:flex;flex-direction:column;min-width:240px;min-height:120px;max-width:100vw;max-height:100vh;
overflow:hidden;resize:both;pointer-events:auto;background:var(--background,#fff);color:var(--foreground,#222);
border:1px solid var(--border,#d0d0d0);border-radius:var(--radius-md,10px);box-shadow:0 12px 40px rgb(0 0 0 / .25);font:12px var(--app-font,system-ui)}
.qf-bar{display:flex;align-items:center;gap:2px;padding:4px 6px 4px 10px;border-bottom:1px solid var(--border,#d0d0d0);
background:var(--secondary,#f4f4f5);cursor:grab;user-select:none;touch-action:none}
.qf-title{flex:1;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.qf-btn{all:unset;cursor:pointer;width:22px;height:22px;display:grid;place-items:center;border-radius:var(--radius-sm,5px);color:var(--muted-foreground,#555)}
.qf-btn:hover{background:var(--muted,rgb(0 0 0 / .08))}
iframe{flex:1;width:100%;border:0;background:#fff}.qf-win.drag iframe{pointer-events:none}`;

const js = `const on = { signal: canvas.signal };
canvas.root.querySelectorAll(".qf-win").forEach((win, i) => {
  win.style.left = Math.max(12, (innerWidth - win.offsetWidth) / 2 + i * 32) + "px";
  win.style.top = Math.max(12, (innerHeight - win.offsetHeight) / 3 + i * 32) + "px";
  const src = new URL(win.dataset.src);
  if (src.protocol === "https:" && src.origin !== location.origin) win.querySelector("iframe").src = src.href;
  win.addEventListener("pointerdown", () => win.parentNode.append(win), on);
  win.querySelector("button").addEventListener("click", () => win.remove(), on);
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
    bar.addEventListener("pointermove", move, on);
    bar.addEventListener("lostpointercapture", () => {
      win.classList.remove("drag");
      bar.removeEventListener("pointermove", move);
    }, { once: true, signal: canvas.signal });
  }, on);
});`;

const { AGENT_API_URL, AGENT_API_TOKEN } = process.env;
if (!AGENT_API_URL || !AGENT_API_TOKEN) fail("AGENT_API_URL and AGENT_API_TOKEN must be set");
const res = await fetch(`${AGENT_API_URL}/v1/ui/canvas`, {
  method: "POST",
  headers: { "x-agent-capability": AGENT_API_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ html, css, js, pinned: values.pin, replace: true }),
});
const text = await res.text();
if (!res.ok) fail(`canvas write failed: HTTP ${res.status} ${text}`, 1);
process.stdout.write(text + "\n");
