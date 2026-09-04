export const APP_SHELL_PATH_PREFIX = "/__claw__/";

function escAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The owner shell: a Claude-artifacts-style top bar over the deployed app, with a
 * slide-out chat column for iterating on it. Served only to a signed-in owner on
 * top-level document loads; the app itself renders untouched inside a same-origin
 * iframe (its sub-resource and iframe requests carry a non-document sec-fetch-dest,
 * so the gateway proxies them straight through).
 */
export function appShellHtml(opts: { slug: string; portalUrl: string; path: string; accent?: string }): string {
  const slug = escAttr(opts.slug);
  const path = escAttr(opts.path);
  const accent = /^[#a-zA-Z0-9(),.% -]{1,64}$/.test(opts.accent ?? "") ? (opts.accent as string) : "#4f46e5";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${slug}</title>
<style>
  /* qm web-ui tokens (mini-lit default theme + shell.css) */
  :root {
    --background: oklch(1 0 0);
    --foreground: oklch(0.145 0 0);
    --secondary: oklch(0.97 0 0);
    --muted-foreground: oklch(0.556 0 0);
    --border: oklch(0.922 0 0);
    --brand-accent: ${accent};
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
  header { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 10px 0 16px; flex: none;
    box-sizing: border-box; user-select: none;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 68%, transparent);
    background: color-mix(in srgb, var(--background) 94%, var(--secondary)); }
  header .name { font-size: 14px; font-weight: 650; line-height: 1.25; color: var(--foreground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header .ver { color: var(--muted-foreground); font-size: 12px; line-height: 1.25; padding: 1px 8px;
    border: 1px solid var(--border); border-radius: 999px; }
  header .grow { flex: 1; }
  header button { appearance: none; border: 1px solid var(--border); background: var(--background);
    color: var(--foreground); border-radius: var(--radius-sm); padding: 5px 11px; font: inherit;
    font-size: 13px; cursor: pointer; white-space: nowrap; }
  header button:hover { background: var(--secondary); }
  header .chat-btn[data-on="1"] { background: var(--brand-accent); border-color: var(--brand-accent); color: #fff; }
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
  #peek:hover { color: var(--foreground); }
  body.bare header, body.bare aside { display: none; }
  body.bare #peek { display: block; }
</style>
</head>
<body>
<header>
  <span class="name">${slug}</span>
  <span class="ver" id="ver"></span>
  <span class="grow"></span>
  <button type="button" class="upd" id="upd">Updated &#8635; Reload</button>
  <button type="button" class="chat-btn" id="chat-toggle">&#10022; Chat</button>
  <button type="button" class="hide-btn" id="hide" title="Hide bar" aria-label="Hide bar">&#10005;</button>
</header>
<main>
  <iframe id="app" src="${path}" title="${slug}"></iframe>
  <aside id="panel"><div class="drag" id="drag"></div><iframe id="chat" title="Chat about ${slug}"></iframe></aside>
</main>
<button type="button" id="peek">${slug} &#9662;</button>
<script>
(() => {
  if (window.top !== window.self) { document.body.className = "bare"; return; }
  window.__qmAppShell = true;
  const slug = ${JSON.stringify(opts.slug)};
  const portal = ${JSON.stringify(opts.portalUrl.replace(/\/$/, ""))};
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

  // --- chat panel ---
  const setOpen = (on) => {
    if (on && !chat.src) chat.src = portal + "/app-edit?slug=" + encodeURIComponent(slug) + "&embed=1";
    panel.classList.toggle("open", on);
    toggle.dataset.on = on ? "1" : "0";
    try { localStorage.setItem(openKey, on ? "1" : "0"); } catch {}
  };
  toggle.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  let wantOpen = false;
  try { wantOpen = localStorage.getItem(openKey) === "1"; } catch {}
  if (wantOpen) setOpen(true);

  // --- panel resize ---
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
  });

  // --- hide / peek ---
  hide.addEventListener("click", () => { document.body.className = "bare"; });
  peek.addEventListener("click", () => { document.body.className = ""; });

  // --- keep the address bar and title in step with the app ---
  let lastHref = null;
  const sync = () => {
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

  // --- new-version handling ---
  // Chat open = you're iterating and waiting on your own change: reload the app
  // frame automatically (the chat column is untouched, so the thread survives).
  // Chat closed = the update came from elsewhere: offer a pill, never yank the
  // page out from under someone mid-interaction.
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
