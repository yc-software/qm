import { parseScopeId, type ScopeKind } from "../types.ts";
import { ANNOTATE_BUTTON, ANNOTATE_CSS, ANNOTATE_JS, ANNOTATE_MARKUP } from "./app-annotate.ts";

export const APP_SHELL_PATH_PREFIX = "/__claw__/";

export type AppShellAccess = {
  level: "private" | "people" | "context" | "org" | "public";
  label: string;
  detail: string;
  canEdit: boolean;
};

const NOUNS: Partial<Record<ScopeKind, [one: string, many: string]>> = {
  personal: ["person", "people"],
  channel: ["channel", "channels"],
  group: ["group chat", "group chats"],
  team: ["team", "teams"],
};
const OTHER_NOUN: [string, string] = ["project", "projects"];

export function appShellAccess(opts: {
  ownerScopeId: string;
  public: boolean;
  grantees: ReadonlyArray<{ scope: string }>;
  viewer: string;
}): AppShellAccess {
  const ownedByViewer = opts.ownerScopeId === `personal:${opts.viewer}`;
  const canEdit = ownedByViewer;
  const kindOf = (scope: string) => parseScopeId(scope).kind;
  if (opts.public)
    return { level: "public", label: "Public", detail: "Anyone on the internet with the link can open", canEdit };
  if (opts.grantees.some((g) => g.scope === "org" || kindOf(g.scope) === "org"))
    return { level: "org", label: "Organization", detail: "Anyone signed in to your organization can open", canEdit };
  const owner = kindOf(opts.ownerScopeId) === "personal" ? [] : [opts.ownerScopeId];
  const reach = new Set([...owner, ...opts.grantees.map((g) => g.scope)]);
  if (!reach.size)
    return {
      level: "private",
      label: "Private",
      detail: ownedByViewer ? "Only you can open" : "Only the owner can open",
      canEdit,
    };
  const counts = new Map<[string, string], number>();
  for (const scope of reach) {
    const kind = kindOf(scope);
    const noun = (kind && NOUNS[kind]) || OTHER_NOUN;
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  const words = [...counts].map(([[one, many], n]) => `${n} ${n === 1 ? one : many}`);
  const onlyPeople = counts.size === 1 && counts.has(NOUNS.personal!);
  const [[[one], n] = [[""], 0]] = counts;
  let label = counts.size === 1 ? words[0]! : "Shared";
  if (counts.size === 1 && n === 1 && !onlyPeople) label = one[0]!.toUpperCase() + one.slice(1);
  return {
    level: onlyPeople ? "people" : "context",
    label,
    detail: `Shared with ${new Intl.ListFormat("en", { type: "conjunction" }).format(words)}`,
    canEdit,
  };
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
  deploymentId?: string;
  access?: AppShellAccess;
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
  header .access-btn { display: inline-flex; align-items: center; gap: 5px; color: var(--muted-foreground); }
  header .access-btn[hidden] { display: none; }
  header .access-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5;
    stroke-linecap: round; stroke-linejoin: round; }
  header .access-btn[data-level="public"] { color: #b45309; }
  header .access-btn:disabled { cursor: default; }
  header .access-btn:disabled:hover { background: transparent; }
  #share { display: none; position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 2147483000;
    background: transparent; color-scheme: normal; }
  #share.open { display: block; }
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
  <button type="button" class="access-btn" id="access" hidden></button>
  <button type="button" class="upd" id="upd">Updated &#8635; Reload</button>
  ${opts.annotationsEnabled ? ANNOTATE_BUTTON : ""}
  <button type="button" class="chat-btn" id="chat-toggle" aria-expanded="false" aria-controls="panel"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H8l-5 3V4a1 1 0 0 1 1-1Z"/></svg><span>Chat</span></button>
  <button type="button" class="hide-btn" id="hide" title="Open app without bar" aria-label="Open app without bar">&#10005;</button>
</header>
<main>
  <iframe id="app" src="${path}" title="${slug}"></iframe>
  ${opts.annotationsEnabled ? ANNOTATE_MARKUP : ""}
  <iframe id="share" title="Share ${name}" allowtransparency="true"></iframe>
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
  const accessBtn = document.getElementById("access");
  const share = document.getElementById("share");
  const deploymentId = ${JSON.stringify(opts.deploymentId ?? opts.slug).replace(/</g, "\\u003c")};
  const accessIcons = {
    private: '<rect x="4" y="9" width="12" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
    people: '<circle cx="8" cy="7" r="2.75"/><path d="M3 16.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/><path d="M13 4.6a2.75 2.75 0 0 1 0 4.8M15 12.8c1.1.6 1.8 1.9 2 3.7"/>',
    context: '<circle cx="8" cy="7" r="2.75"/><path d="M3 16.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/><path d="M13 4.6a2.75 2.75 0 0 1 0 4.8M15 12.8c1.1.6 1.8 1.9 2 3.7"/>',
    org: '<rect x="4" y="3" width="12" height="14" rx="1"/><path d="M8 17v-3h4v3M8 6.5h.01M12 6.5h.01M8 10h.01M12 10h.01"/>',
    public: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2 2 2.8 4.4 2.8 7S12 15 10 17c-2-2-2.8-4.4-2.8-7S8 5 10 3Z"/>',
  };
  let access = ${JSON.stringify(opts.access ?? null).replace(/</g, "\\u003c")};
  const showAccess = (next) => {
    if (!next || !accessIcons[next.level]) return;
    access = next;
    accessBtn.hidden = false;
    accessBtn.dataset.level = next.level;
    accessBtn.disabled = !next.canEdit;
    accessBtn.title = next.detail + (next.canEdit ? ". Click to change who can open it." : "");
    accessBtn.setAttribute("aria-label", "Access: " + next.label + ". " + next.detail + (next.canEdit ? ". Change access" : ""));
    accessBtn.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true">' + accessIcons[next.level] + "</svg>";
    const text = document.createElement("span");
    text.textContent = next.label;
    accessBtn.append(text);
  };
  showAccess(access);
  const shareUrl = portal + "/app-share?id=" + encodeURIComponent(deploymentId) + "&slug=" + encodeURIComponent(slug) + "&embed=1";
  const closeShare = () => {
    share.classList.remove("open");
    share.src = "about:blank";
    accessBtn.focus();
    void poll();
  };
  accessBtn.addEventListener("click", () => {
    if (!access?.canEdit) return;
    share.src = shareUrl + "&name=" + encodeURIComponent(document.getElementById("name").textContent || "");
    share.classList.add("open");
  });
  share.addEventListener("load", () => {
    if (share.classList.contains("open")) share.contentWindow.postMessage({ type: "qm:theme-request" }, portalOrigin);
  });

  const portalOrigin = new URL(portal).origin;
  const themeColors = ["--background", "--foreground", "--secondary", "--muted-foreground", "--border", "--brand-accent"];
  window.addEventListener("message", (event) => {
    if (event.origin !== portalOrigin) return;
    if (event.source === share.contentWindow) {
      if (event.data?.type === "qm:app-check") void poll();
      if (event.data?.type === "qm:app-share-closed") closeShare();
      return;
    }
    if (event.source !== chat.contentWindow) return;
    if (event.data?.type === "qm:app-check") return void poll();
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
  const poll = async () => {
    if (document.hidden || bare) return;
    const mine = ++polls;
    try {
      const r = await fetch("/__claw__/version", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (mine !== polls || typeof d.version !== "number") return;
      verEl.textContent = "v" + d.version;
      if (d.access) showAccess(d.access);
      const served = d.version + ":" + (d.live ?? "");
      if (base === null) {
        base = served;
        upd.classList.remove("show");
      } else if (served !== base) {
        if (panel.classList.contains("open")) reloadApp(served);
        else upd.classList.add("show");
      }
    } catch {}
  };
  void poll();
  setInterval(poll, 5000);
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
