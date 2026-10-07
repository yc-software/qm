import { readFileSync } from "node:fs";

export function appAnnotationAsset(name: "js" | "css"): string {
  return readFileSync(new URL(`./vendor/devbar.${name}`, import.meta.url), "utf8");
}

export const ANNOTATE_CSS = `
  header .ann-btn { display: inline-flex; align-items: center; gap: 6px; color: var(--muted-foreground); }
  header .ann-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; }
  header .ann-btn[data-on="1"] { color: var(--foreground); background: var(--secondary); }
  #ann-status { position: fixed; bottom: 12px; left: 12px; z-index: 9; padding: 8px 12px; border-radius: 8px; background: var(--foreground); color: var(--background); font-size: 12px; }
  #ann-status:empty { display: none; }
`;

export const ANNOTATE_BUTTON = `<button type="button" class="ann-btn" id="ann-toggle" aria-pressed="false" title="Annotate the app (A)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17l3.5-.8L16 6.7a1.6 1.6 0 0 0 0-2.3l-.4-.4a1.6 1.6 0 0 0-2.3 0L3.8 13.5 3 17Z"/><path d="M12 5.3 14.7 8"/></svg><span>Annotate</span></button>`;

export const ANNOTATE_MARKUP = '<div id="ann-status" role="status"></div>';

export const ANNOTATE_JS = String.raw`
  const annotationToggle = document.getElementById("ann-toggle");
  const annotationStatus = document.getElementById("ann-status");
  let annotating = false, annotationReady = false, annotationLoading = false;
  let annotationChatOpen = document.querySelector("#chat-toggle")?.getAttribute("aria-expanded") === "true";
  let draining = false, retryTimer;
  const snapshots = new Map();
  const delivered = new Map();
  const session = crypto.randomUUID();
  const notifyAnnotations = (text) => { annotationStatus.textContent = text; };
  const postAnnotationToggle = () => {
    app.contentWindow.postMessage({ type: "qm:devbar-toggle", on: annotating, chatOpen: annotationChatOpen }, location.origin);
  };
  const loadAnnotations = () => {
    if ((!annotating && !annotationChatOpen) || annotationReady || annotationLoading) return;
    try {
      const doc = app.contentDocument;
      if (!doc?.body || doc.URL === "about:blank") return;
      annotationLoading = true;
      const css = doc.createElement("link");
      css.rel = "stylesheet"; css.href = "/__claw__/annotate.css";
      doc.head.append(css);
      const script = doc.createElement("script");
      script.src = "/__claw__/annotate.js";
      script.onerror = () => { annotationLoading = false; notifyAnnotations("Couldn't load annotation tools. Toggle Annotate to retry."); };
      doc.body.append(script);
    } catch { notifyAnnotations("Annotation tools require an app on this origin."); }
  };
  const setAnnotating = (on) => {
    annotating = on;
    annotationToggle.dataset.on = on ? "1" : "0";
    annotationToggle.setAttribute("aria-pressed", String(on));
    if (annotationReady) postAnnotationToggle(); else loadAnnotations();
    if (on) { try { app.contentWindow.focus(); } catch {} }
  };
  annotationToggle.addEventListener("click", () => setAnnotating(!annotating));
  const annotationShortcut = (e) => {
    if (e.key.toLowerCase() !== "a" || e.repeat || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.target.closest?.("input,textarea,select,[contenteditable]")) return;
    e.preventDefault(); setAnnotating(!annotating);
  };
  window.addEventListener("keydown", annotationShortcut);
  const bindAnnotationShortcut = () => {
    try { app.contentWindow.addEventListener("keydown", annotationShortcut); } catch {}
  };
  bindAnnotationShortcut();
  window.addEventListener("qm:chat-open", (event) => {
    annotationChatOpen = event.detail;
    if (annotationReady) postAnnotationToggle(); else loadAnnotations();
  });
  loadAnnotations();
  app.addEventListener("load", () => {
    annotationReady = false; annotationLoading = false; bindAnnotationShortcut(); loadAnnotations();
  });
  const deliverAnnotation = (payload) => new Promise((resolve) => {
    let tries = 0;
    const onAck = (event) => {
      if (event.source !== chat.contentWindow || event.origin !== portalOrigin) return;
      if (event.data?.type !== "qm:annotations-ack" || event.data.id !== payload.id) return;
      clearInterval(timer); window.removeEventListener("message", onAck); resolve(true);
    };
    window.addEventListener("message", onAck);
    const post = () => {
      if (++tries > 20) { clearInterval(timer); window.removeEventListener("message", onAck); resolve(false); return; }
      chat.contentWindow.postMessage(payload, portalOrigin);
    };
    const timer = setInterval(post, 500); post();
  });
  const annotationContent = async (annotation, context) => {
    const data = annotation.data || {};
    const images = [data.elementScreenshot, data.screenshotDataUri, data.imageDataUri].filter((value, index, all) =>
      typeof value === "string" && value.startsWith("data:image/png;base64,") && all.indexOf(value) === index).slice(0, 2);
    const files = [];
    for (const [index, uri] of images.entries()) {
      const blob = await (await fetch(uri)).blob();
      if (blob.size <= 20 * 1024 * 1024) files.push(new File([blob], "annotation-" + (index + 1) + ".png", { type: "image/png" }));
    }
    const details = JSON.stringify(data, (key, value) => /^(elementScreenshot|imageDataUri|screenshotDataUri|videoBlobUrl|thumbnailDataUri)$/.test(key) ? undefined : value, 2);
    const text = ["App annotation: " + annotation.type, "Page: " + context.url,
      "Viewport: " + context.viewport.width + " × " + context.viewport.height,
      ...(annotation.comments || []).map((comment) => comment.text), details,
      context.consoleErrors?.length ? "Console errors:\n" + context.consoleErrors.join("\n") : "",
      context.networkErrors?.length ? "Network errors:\n" + context.networkErrors.join("\n") : ""].filter(Boolean).join("\n\n");
    return { text, files };
  };
  const drainAnnotations = async () => {
    if (draining || !snapshots.size) return;
    draining = true;
    clearTimeout(retryTimer);
    try {
      while (snapshots.size) {
        const current = snapshots.values().next().value;
        const removed = [...delivered.keys()].find((id) => id.startsWith(current.scope + ":") && !current.annotations.some((item) => current.scope + ":" + item.id === id));
        const changed = !removed && current.annotations.find((item) => delivered.get(current.scope + ":" + item.id)?.revision !== JSON.stringify(item));
        if (!changed && !removed) { snapshots.delete(current.scope); continue; }
        const annotationId = session + ":" + (changed ? current.scope + ":" + changed.id : removed);
        const revision = changed ? JSON.stringify(changed) : null;
        const content = changed ? await annotationContent(changed, current) : { text: "", files: [] };
        notifyAnnotations("Adding annotation to chat…");
        setOpen(true);
        const ok = await deliverAnnotation({ type: "qm:annotations", id: crypto.randomUUID(), annotationId, remove: !changed, ...content });
        if (!ok) {
          notifyAnnotations("Annotation waiting for chat. Free attachment space or reconnect; retrying automatically.");
          retryTimer = setTimeout(drainAnnotations, 5000);
          return;
        }
        if (changed) delivered.set(current.scope + ":" + changed.id, { revision }); else delivered.delete(removed);
      }
      notifyAnnotations("");
    } catch {
      notifyAnnotations("Couldn't attach annotation. Retrying automatically.");
      retryTimer = setTimeout(drainAnnotations, 5000);
    } finally { draining = false; }
  };
  window.addEventListener("message", (event) => {
    if (event.source !== app.contentWindow || event.origin !== location.origin) return;
    if (event.data?.type === "qm:devbar-ready") {
      annotationReady = true; annotationLoading = false; postAnnotationToggle();
      notifyAnnotations("");
    }
    if (event.data?.type === "qm:devbar-snapshot" && typeof event.data.payload?.scope === "string" && Array.isArray(event.data.payload.annotations)) {
      snapshots.set(event.data.payload.scope, event.data.payload);
      void drainAnnotations();
    }
  });
`;
