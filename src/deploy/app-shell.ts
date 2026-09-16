export const APP_SHELL_PATH_PREFIX = "/__claw__/";

function escAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function appShellHtml(opts: { slug: string; name?: string; portalUrl: string; path: string }): string {
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
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: oklch(0.145 0 0);
      --foreground: oklch(0.985 0 0);
      --secondary: oklch(0.269 0 0);
      --muted-foreground: oklch(0.708 0 0);
      --border: oklch(0.269 0 0);
    }
  }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font-family: var(--app-font); font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased; background: var(--background); color: var(--foreground); }
  header { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 6px 0 12px; flex: none;
    box-sizing: border-box; user-select: none;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 68%, transparent);
    background: color-mix(in srgb, var(--background) 94%, var(--secondary)); }
  header .name { font-size: 12px; font-weight: 500; line-height: 1.25; color: var(--foreground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header .ver { color: var(--muted-foreground); font-size: 11px; line-height: 1.25; }
  header .grow { flex: 1; }
  header button { appearance: none; border: 0; background: transparent;
    color: var(--foreground); border-radius: var(--radius-sm); padding: 3px 8px; min-height: 28px; font: inherit;
    font-size: 12px; cursor: pointer; white-space: nowrap; }
  header button:hover { background: var(--secondary); }
  header .chat-btn[data-on="1"] { background: color-mix(in srgb, var(--foreground) 10%, transparent); color: var(--foreground); }
  header .upd { display: none; border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
    color: var(--brand-accent); font-weight: 600; }
  header .upd.show { display: inline-block; }
  header .hide-btn { border: none; background: none; color: var(--muted-foreground); font-size: 15px; padding: 5px 7px; }
  header .hide-btn:hover { color: var(--foreground); background: none; }
  main { display: flex; flex: 1; min-height: 0; }
  #app { flex: 1; border: 0; width: 100%; height: 100%; background: var(--background); }
  aside { display: none; flex: none; width: 420px; min-width: 320px; max-width: 70vw; position: relative;
    border-left: 1px solid var(--border);
    background: color-mix(in srgb, var(--secondary) 42%, var(--background)); }
  aside.open { display: flex; }
  aside .drag { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; }
  #chat { border: 0; flex: 1; width: 100%; height: 100%; }
  #peek { position: fixed; top: 8px; right: 8px; z-index: 10; display: none; cursor: pointer;
    border: 1px solid var(--border); background: color-mix(in srgb, var(--background) 88%, transparent);
    color: var(--muted-foreground); border-radius: 999px; padding: 3px 11px;
    font-family: var(--app-font); font-size: 12px; }
  button:focus-visible, .drag:focus-visible { outline: 2px solid var(--foreground); outline-offset: -2px; }
  @media (max-width: 640px) {
    aside { min-width: 0; width: min(100vw, 420px); max-width: 100vw; }
    body:not(.bare) main:has(aside.open) #app { display: none; }
    aside.open { flex: 1; }
    .drag { display: none; }
  }
  #peek:hover { color: var(--foreground); }
  body.bare header, body.bare aside { display: none; }
  body.bare #peek { display: block; }
</style>
</head>
<body>
<header>
  <span class="name" id="name">${name}</span>
  <span class="ver" id="ver"></span>
  <span class="grow"></span>
  <button type="button" class="upd" id="upd">Updated &#8635; Reload</button>
  <button type="button" class="chat-btn" id="chat-toggle" aria-expanded="false" aria-controls="panel">Chat</button>
  <button type="button" class="hide-btn" id="hide" title="Hide bar" aria-label="Hide bar">&#10005;</button>
</header>
<main>
  <iframe id="app" src="${path}" title="${slug}"></iframe>
  <aside id="panel"><div class="drag" id="drag" role="separator" tabindex="0" aria-label="Resize chat" aria-orientation="vertical"></div><iframe id="chat" title="Chat about ${slug}"></iframe></aside>
</main>
<button type="button" id="peek">${slug} &#9662;</button>
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
  const peek = document.getElementById("peek");
  const hide = document.getElementById("hide");
  const drag = document.getElementById("drag");
  const openKey = "qmChat:" + slug;

  const setOpen = (on) => {
    if (on && !chat.src) chat.src = portal + "/app-edit?slug=" + encodeURIComponent(slug) + "&embed=1";
    panel.classList.toggle("open", on);
    toggle.dataset.on = on ? "1" : "0";
    toggle.setAttribute("aria-expanded", String(on));
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
  hide.addEventListener("click", () => { document.body.className = "bare"; });
  peek.addEventListener("click", () => { document.body.className = ""; });

  const defaultName = document.getElementById("name").textContent;
  const theme = () => {
    try {
      const doc = app.contentDocument;
      if (!doc || !doc.body) return;
      const style = app.contentWindow.getComputedStyle(doc.body);
      const root = app.contentWindow.getComputedStyle(doc.documentElement);
      const custom = (key) => style.getPropertyValue("--qm-bar-" + key).trim();
      const opaque = (color) => color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)";
      const background = custom("background") || (opaque(style.backgroundColor) ? style.backgroundColor : root.backgroundColor);
      const dark = root.colorScheme === "dark" || (root.colorScheme.includes("dark") && app.contentWindow.matchMedia("(prefers-color-scheme: dark)").matches);
      const foreground = custom("color") || style.color;
      const font = custom("font-family") || style.fontFamily;
      const accent = custom("accent") || foreground;
      const target = document.documentElement.style;
      for (const [key, value] of Object.entries({ "--background": opaque(background) ? background : (dark ? "#121212" : "#ffffff"), "--foreground": foreground, "--app-font": font, "--brand-accent": accent })) {
        if (value && target.getPropertyValue(key) !== value) target.setProperty(key, value);
        else if (!value) target.removeProperty(key);
      }
      target.setProperty("--secondary", "color-mix(in srgb, var(--foreground) 5%, var(--background))");
      target.setProperty("--muted-foreground", "color-mix(in srgb, var(--foreground) 65%, var(--background))");
      target.setProperty("--border", "color-mix(in srgb, var(--foreground) 13%, var(--background))");
      document.getElementById("name").textContent = doc.title || defaultName;
    } catch {}
  };
  let lastHref = null;
  const sync = () => {
    theme();
    try {
      const loc = app.contentWindow.location;
      if (loc.href === "about:blank" || loc.href === lastHref) return;
      lastHref = loc.href;
      history.replaceState(null, "", loc.pathname + loc.search + loc.hash);
      const t = app.contentDocument && app.contentDocument.title;
      document.title = t || slug;
    } catch {}
  };
  setInterval(sync, 500);
  app.addEventListener("load", sync);
  if (location.hash) app.src += location.hash;
  let base = null;
  const reloadApp = (v) => {
    base = v;
    upd.classList.remove("show");
    try { app.contentWindow.location.reload(); } catch { app.src = app.src; }
  };
  const poll = async () => {
    if (document.hidden) return;
    try {
      const r = await fetch("/__claw__/version", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (typeof d.version !== "number") return;
      verEl.textContent = "v" + d.version;
      if (base === null) base = d.version;
      else if (d.version !== base) {
        if (panel.classList.contains("open")) reloadApp(d.version);
        else upd.classList.add("show");
      }
    } catch {}
  };
  void poll();
  setInterval(poll, 5000);
  upd.addEventListener("click", () => {
    void fetch("/__claw__/version", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => reloadApp(typeof d.version === "number" ? d.version : base))
      .catch(() => reloadApp(base));
  });
})();
</script>
</body>
</html>
`;
}
