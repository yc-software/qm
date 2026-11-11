import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ANNOTATE_BUTTON, ANNOTATE_CSS, ANNOTATE_JS, ANNOTATE_MARKUP } from "./app-annotate.ts";

export const APP_SHELL_PATH_PREFIX = "/__claw__/";

const require = createRequire(import.meta.url);
let captureScript: string | undefined;

export function appCaptureScript(): string {
  captureScript ??= readFileSync(require.resolve("html-to-image/dist/html-to-image.js"), "utf8");
  return captureScript;
}

function escAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function appShellHtml(opts: {
  slug: string;
  name?: string;
  portalUrl: string;
  path: string;
  annotationsEnabled?: boolean;
}): string {
  const slug = escAttr(opts.slug);
  const path = escAttr(opts.path);
  const name = escAttr(opts.name ?? opts.slug);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name}</title>
<style>
  :root {
    --background: oklch(1 0 0);
    --foreground: oklch(0.145 0 0);
    --secondary: oklch(0.97 0 0);
    --muted-foreground: oklch(0.556 0 0);
    --border: oklch(0.922 0 0);
    --brand-accent: #4f46e5;
    --radius-sm: 8px;
    --app-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color-scheme: light;
  }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font-family: var(--app-font); font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased; background: var(--background); color: var(--foreground); }
  header { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 6px 0 12px; flex: none;
    box-sizing: border-box; user-select: none;
    border-bottom: 1px solid var(--border);
    background: var(--background);
    transition: margin-top 0.24s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.16s ease; }
  header .name { font-size: 11px; font-weight: 500; line-height: 1.25; color: var(--foreground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header .ver { display: none; }
  header .grow { flex: 1; }
  header button { appearance: none; border: 0; background: transparent;
    color: var(--foreground); border-radius: var(--radius-sm); padding: 0 8px; min-height: 24px; font: inherit;
    font-size: 11px; cursor: pointer; white-space: nowrap; }
  header button:hover { background: var(--secondary); }
  header .chat-btn { display: inline-flex; align-items: center; gap: 6px; color: var(--muted-foreground); }
  header .chat-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; }
  header .chat-btn[data-on="1"] { color: var(--foreground); }
  header .chat-btn::after { content: ""; width: 4px; height: 4px; border-radius: 50%; background: currentColor; visibility: hidden; }
  header .chat-btn[data-on="1"]::after { visibility: visible; }
  header .upd { display: none; border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
    color: var(--brand-accent); font-weight: 600; }
  header .upd.show { display: inline-block; }
  header .hide-btn { border: none; background: none; color: var(--muted-foreground); font-size: 15px; padding: 5px 7px; }
  header .hide-btn:hover { color: var(--foreground); background: none; }
  main { display: flex; flex: 1; min-height: 0; }
  #app { flex: 1; border: 0; width: 100%; height: 100%; background: var(--background); }
  aside { display: none; flex: none; width: 420px; min-width: 320px; max-width: 70vw; position: relative;
    border-left: 1px solid var(--border);
    background: color-mix(in srgb, var(--secondary) 42%, var(--background));
    transition: width 0.24s cubic-bezier(0.2, 0.8, 0.2, 1), min-width 0.24s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.16s ease; }
  aside.open { display: flex; }
  aside .drag { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; }
  #chat { border: 0; flex: 1; width: 100%; height: 100%; }
  body.leaving header { margin-top: -32px; opacity: 0; pointer-events: none; }
  body.leaving aside { flex: none; width: 0 !important; min-width: 0; opacity: 0; overflow: hidden; pointer-events: none; }
  body.leaving #chat { flex: none; }
  @media (prefers-reduced-motion: reduce) { header, aside { transition: none; } }
  button:focus-visible, .drag:focus-visible { outline: 2px solid var(--foreground); outline-offset: -2px; }
  @media (max-width: 640px) {
    aside { min-width: 0; width: min(100vw, 420px); max-width: 100vw; }
    body:not(.bare):not(.leaving) main:has(aside.open) #app { display: none; }
    aside.open { flex: 1; }
    .drag { display: none; }
  }
  body.bare header, body.bare aside { display: none; }
${opts.annotationsEnabled ? ANNOTATE_CSS : ""}</style>
</head>
<body>
<header>
  <span class="name" id="name">${name}</span>
  <span class="ver" id="ver"></span>
  <span class="grow"></span>
  <button type="button" class="upd" id="upd">Updated &#8635; Reload</button>
  ${opts.annotationsEnabled ? ANNOTATE_BUTTON : ""}
  <button type="button" class="chat-btn" id="chat-toggle" aria-expanded="false" aria-controls="panel"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H8l-5 3V4a1 1 0 0 1 1-1Z"/></svg><span>Chat</span></button>
  <button type="button" class="hide-btn" id="hide" title="Open app without bar" aria-label="Open app without bar">&#10005;</button>
</header>
<main>
  <iframe id="app" src="${path}" title="${slug}"></iframe>
  ${opts.annotationsEnabled ? ANNOTATE_MARKUP : ""}
  <aside id="panel"><div class="drag" id="drag" role="separator" tabindex="0" aria-label="Resize chat" aria-orientation="vertical"></div><iframe id="chat" title="Chat about ${slug}"></iframe></aside>
</main>
<script>
(() => {
  if (window.top !== window.self) { document.body.className = "bare"; return; }
  window.__qmAppShell = true;
  const slug = ${JSON.stringify(opts.slug).replace(/</g, "\\u003c")};
  const portal = ${JSON.stringify(opts.portalUrl.replace(/\/$/, "")).replace(/</g, "\\u003c")};
  const app = document.getElementById("app");
  const panel = document.getElementById("panel");
  const chat = document.getElementById("chat");
  const toggle = document.getElementById("chat-toggle");
  const upd = document.getElementById("upd");
  const verEl = document.getElementById("ver");
  const hide = document.getElementById("hide");
  const drag = document.getElementById("drag");
  const openKey = "qmChat:" + slug;

  const portalOrigin = new URL(portal).origin;
  const themeColors = ["--background", "--foreground", "--secondary", "--muted-foreground", "--border", "--brand-accent"];
  window.addEventListener("message", (event) => {
    if (event.source !== chat.contentWindow || event.origin !== portalOrigin) return;
    if (event.data?.type === "qm:app-check") return void poll();
    if (event.data?.type === "qm:app-shot" && typeof event.data.id === "string") return void answerShot(event.data.id);
    const theme = event.data;
    if (theme?.type !== "qm:theme" || typeof theme.dark !== "boolean" || !theme.colors) return;
    if (!themeColors.every((key) => typeof theme.colors[key] === "string" && CSS.supports("color", theme.colors[key]))) return;
    for (const key of themeColors) document.documentElement.style.setProperty(key, theme.colors[key]);
    document.documentElement.style.colorScheme = theme.dark ? "dark" : "light";
  });
  chat.addEventListener("load", () => {
    chat.contentWindow.postMessage({ type: "qm:theme-request" }, portalOrigin);
  });
  const chatUrl = portal + "/app-edit?slug=" + encodeURIComponent(slug) + "&embed=1";
  chat.src = chatUrl + "&themeOnly=1";
  let chatLoaded = false;

  const setOpen = (on) => {
    if (on && !chatLoaded) {
      chatLoaded = true;
      chat.src = chatUrl;
    }
    panel.classList.toggle("open", on);
    toggle.dataset.on = on ? "1" : "0";
    toggle.setAttribute("aria-expanded", String(on));
    window.dispatchEvent(new CustomEvent("qm:chat-open", { detail: on }));
    try { localStorage.setItem(openKey, on ? "1" : "0"); } catch {}
  };
  toggle.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  let wantOpen = false;
  try { wantOpen = localStorage.getItem(openKey) === "1"; } catch {}
  if (wantOpen) setOpen(true);

  drag.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    drag.setPointerCapture(e.pointerId);
    app.style.pointerEvents = "none"; chat.style.pointerEvents = "none";
    const move = (ev) => { panel.style.width = Math.max(320, window.innerWidth - ev.clientX) + "px"; };
    const stop = () => {
      drag.removeEventListener("pointermove", move);
      app.style.pointerEvents = ""; chat.style.pointerEvents = "";
    };
    drag.addEventListener("pointermove", move);
    drag.addEventListener("pointerup", stop, { once: true });
    drag.addEventListener("pointercancel", stop, { once: true });
  });

  drag.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    panel.style.width = Math.max(320, panel.offsetWidth + (event.key === "ArrowLeft" ? 20 : -20)) + "px";
  });
  let bare = false;
  hide.addEventListener("click", () => {
    let framed = false;
    try { framed = app.contentWindow.location.href !== "about:blank"; } catch {}
    if (!framed) {
      const target = new URL(location.href);
      target.searchParams.set("__qm_no_shell", "1");
      location.assign(target.href);
      return;
    }
    bare = true;
    lastHref = null;
    sync();
    chat.style.width = chat.offsetWidth + "px";
    document.body.classList.add("leaving");
    window.dispatchEvent(new Event("qm:shell-bare"));
    const done = () => { document.body.classList.add("bare"); chat.src = "about:blank"; };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
    else setTimeout(done, 260);
  });

  const defaultName = document.getElementById("name").textContent;
  let lastHref = null;
  const sync = () => {
    try {
      const t = app.contentDocument && app.contentDocument.title;
      document.getElementById("name").textContent = t || defaultName;
      document.title = t || defaultName;
      const loc = app.contentWindow.location;
      if (loc.href === "about:blank" || loc.href === lastHref) return;
      lastHref = loc.href;
      const shown = new URL(loc.pathname + loc.search + loc.hash, location.origin);
      if (bare) shown.searchParams.set("__qm_no_shell", "1");
      history.replaceState(null, "", shown.pathname + shown.search + shown.hash);
    } catch {}
  };
  setInterval(sync, 500);
  app.addEventListener("load", sync);
  if (location.hash) app.src += location.hash;
  let base = null;
  let reloading = false;
  app.addEventListener("load", () => {
    if (reloading) reloading = false;
    else base = null;
  });
  const reloadApp = (v) => {
    base = v;
    reloading = true;
    upd.classList.remove("show");
    try { app.contentWindow.location.reload(); } catch { app.src = app.src; }
  };
  let polls = 0;
  const checkVersion = async (force) => {
    const mine = ++polls;
    const r = await fetch("/__claw__/version", { cache: "no-store" });
    if (!r.ok) throw new Error("the version check failed with HTTP " + r.status);
    const d = await r.json();
    if (mine !== polls || typeof d.version !== "number") return;
    verEl.textContent = "v" + d.version;
    const served = d.version + ":" + (d.live ?? "");
    if (base === null) {
      base = served;
      upd.classList.remove("show");
    } else if (served !== base) {
      if (force || panel.classList.contains("open")) reloadApp(served);
      else upd.classList.add("show");
    }
  };
  const poll = async () => {
    if (document.hidden || bare) return;
    try { await checkVersion(false); } catch {}
  };
  void poll();
  setInterval(poll, 5000);

  let captureLib = null;
  let captureScript = null;
  let notDrawn = [];
  app.addEventListener("load", () => {
    if (captureScript) captureScript.remove();
    captureScript = null;
    captureLib = null;
    notDrawn = [];
  });
  const loadCapture = () => captureLib || (captureLib = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/__claw__/capture.js";
    s.onload = () => (window.htmlToImage ? resolve(window.htmlToImage) : reject(new Error("capture library missing")));
    s.onerror = () => { captureLib = null; reject(new Error("could not load the capture library")); };
    captureScript = s;
    document.head.appendChild(s);
  }));
  const placeholder = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#c8c8c8"/></svg>');
  const describe = (error) => {
    if (error instanceof Event) {
      const t = error.target;
      const where = t && (t.currentSrc || t.src || t.href || t.tagName);
      return "a " + error.type + " event" + (where ? " from " + String(where).slice(0, 300) : "");
    }
    return String(error && error.message || error);
  };
  const shoot = async () => {
    if (document.hidden) throw new Error("the app tab is hidden, so the browser will not render it; ask the person to bring it to the front");
    await checkVersion(true);
    if (reloading) await new Promise((resolve) => app.addEventListener("load", resolve, { once: true }));
    const doc = app.contentDocument;
    if (!doc || !doc.documentElement) throw new Error("the app page is not readable from its shell (it may have navigated to another site)");
    const w = app.contentWindow;
    if (doc.readyState !== "complete") await new Promise((resolve) => w.addEventListener("load", resolve, { once: true }));
    if (doc.fonts) await doc.fonts.ready;
    await new Promise((r) => w.requestAnimationFrame(() => w.requestAnimationFrame(r)));
    const lib = await loadCapture();
    const width = app.clientWidth;
    const height = app.clientHeight;
    if (!width || !height) throw new Error("the app frame has no size (" + width + "×" + height + ")");
    const sx = w.scrollX || 0;
    const sy = w.scrollY || 0;
    const bg = w.getComputedStyle(doc.body || doc.documentElement).backgroundColor;
    const htmlBg = w.getComputedStyle(doc.documentElement).backgroundColor;
    const opaque = (c) => c && c !== "transparent" && !/rgba\\([^)]*,\\s*0\\)$/.test(c);
    const notes = [];
    const { fetch: realFetch } = window;
    window.fetch = (input, init) => realFetch(input, init).catch((error) => {
      notes.push("could not fetch " + String(input && input.url || input).slice(0, 300) + " (" + describe(error) + ")");
      throw error;
    });
    const { warn, error: logError } = console;
    console.warn = (...args) => { notes.push(args.map(describe).join(" ")); warn(...args); };
    console.error = (...args) => { notes.push(args.map(describe).join(" ")); logError(...args); };
    let canvas;
    try {
      canvas = await lib.toCanvas(doc.documentElement, {
        width, height, pixelRatio: 1, cacheBust: false, imagePlaceholder: placeholder,
        backgroundColor: opaque(htmlBg) ? htmlBg : opaque(bg) ? bg : "#ffffff",
        style: { transform: "translate(" + -sx + "px," + -sy + "px)", transformOrigin: "0 0" },
      });
    } finally {
      window.fetch = realFetch;
      console.warn = warn;
      console.error = logError;
    }
    for (const note of notes) if (!notDrawn.includes(note)) notDrawn.push(note);
    let dataUrl;
    try { dataUrl = canvas.toDataURL("image/jpeg", 0.85); }
    catch (error) { throw new Error("the browser refused to read the picture back (" + (error && error.name) + ": " + (error && error.message) + ")"); }
    return {
      ok: true, image: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg",
      url: w.location.href, width, height, scrollY: Math.round(sy),
      dark: !!(w.matchMedia && w.matchMedia("(prefers-color-scheme: dark)").matches),
      version: base, notDrawn,
    };
  };
  const answerShot = async (id) => {
    let reply;
    try { reply = await shoot(); }
    catch (error) { reply = { ok: false, error: describe(error) }; }
    chat.contentWindow.postMessage({ type: "qm:app-shot-result", id, ...reply }, portalOrigin);
  };
${opts.annotationsEnabled ? ANNOTATE_JS : ""}
  upd.addEventListener("click", () => {
    void fetch("/__claw__/version", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => reloadApp(typeof d.version === "number" ? d.version + ":" + (d.live ?? "") : base))
      .catch(() => reloadApp(base));
  });
})();
</script>
</body>
</html>
`;
}
