// Devbar-style page annotation for the app bar. It runs in the app shell, which is
// same-origin with the app iframe, so it can inspect the app's DOM without injecting
// anything into the app. Marks are drawn on an overlay above the iframe; "Add to chat"
// takes one real tab screenshot (getDisplayMedia) cropped to the app, and hands the
// PNG plus a structured note to the chat iframe's composer as an ordinary attachment.

export const ANNOTATE_CSS = `
  header .ann-btn { display: inline-flex; align-items: center; gap: 6px; color: var(--muted-foreground); }
  header .ann-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; }
  header .ann-btn[data-on="1"] { color: var(--foreground); background: var(--secondary); }
  main { position: relative; }
  #ann { display: none; position: absolute; top: 0; left: 0; z-index: 5; cursor: crosshair; touch-action: none; }
  #ann.on { display: block; }
  #ann svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
  #ann .hl { position: absolute; pointer-events: none; border: 1.5px solid #e5484d; background: rgb(229 72 77 / 0.08); border-radius: 2px; }
  #ann .pin { position: absolute; pointer-events: none; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
    background: #e5484d; color: #fff; font: 600 10px/18px var(--app-font); text-align: center; box-shadow: 0 0 0 2px #fff; }
  #ann-bar { display: none; position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 7; gap: 2px; padding: 3px;
    align-items: center; border: 1px solid var(--border); border-radius: 10px; background: var(--background);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.12); font-size: 11px; white-space: nowrap; }
  #ann-bar.on { display: flex; }
  #ann-bar button { appearance: none; border: 0; background: transparent; color: var(--foreground); font: inherit;
    border-radius: 7px; padding: 4px 9px; cursor: pointer; }
  #ann-bar button:hover { background: var(--secondary); }
  #ann-bar button[aria-pressed="true"] { background: var(--secondary); font-weight: 600; }
  #ann-bar .sep { width: 1px; align-self: stretch; margin: 2px 3px; background: var(--border); }
  #ann-bar .count { color: var(--muted-foreground); padding: 0 6px; min-width: 50px; text-align: center; }
  #ann-bar .send { background: var(--foreground); color: var(--background); font-weight: 600; }
  #ann-bar .send:hover { background: var(--foreground); opacity: 0.88; }
  #ann-bar .send:disabled { opacity: 0.4; cursor: default; }
  #ann-note { display: none; position: absolute; z-index: 8; width: 260px; padding: 8px; border: 1px solid var(--border);
    border-radius: 10px; background: var(--background); box-shadow: 0 6px 20px rgb(0 0 0 / 0.16); }
  #ann-note.on { display: block; }
  #ann-note .what { font-size: 11px; color: var(--muted-foreground); margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #ann-note textarea { box-sizing: border-box; width: 100%; min-height: 56px; resize: vertical; font: inherit; font-size: 12px;
    color: var(--foreground); background: var(--background); border: 1px solid var(--border); border-radius: 6px; padding: 6px; }
  #ann-note .row { display: flex; justify-content: flex-end; gap: 4px; margin-top: 6px; }
  #ann-note button { appearance: none; border: 1px solid var(--border); background: var(--background); color: var(--foreground);
    font: inherit; font-size: 11px; border-radius: 6px; padding: 3px 9px; cursor: pointer; }
  #ann-note button.save { background: var(--foreground); color: var(--background); border-color: var(--foreground); }
  #ann-toast { display: none; position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 8;
    padding: 6px 12px; border-radius: 8px; background: var(--foreground); color: var(--background); font-size: 11px; }
  #ann-toast.on { display: block; }
  body.ann-capturing #ann-bar, body.ann-capturing #ann-note, body.ann-capturing #ann .hl { visibility: hidden; }
`;

export const ANNOTATE_BUTTON = `<button type="button" class="ann-btn" id="ann-toggle" aria-pressed="false" title="Annotate the app (A)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17l3.5-.8L16 6.7a1.6 1.6 0 0 0 0-2.3l-.4-.4a1.6 1.6 0 0 0-2.3 0L3.8 13.5 3 17Z"/><path d="M12 5.3 14.7 8"/></svg><span>Annotate</span></button>`;

export const ANNOTATE_MARKUP = `<div id="ann" aria-hidden="true"><div class="hl" id="ann-hl" hidden></div><svg id="ann-ink"></svg><div id="ann-pins"></div></div>
  <div id="ann-bar" role="toolbar" aria-label="Annotate">
    <button type="button" data-mode="select" aria-pressed="true" title="Click an element (S)">Select</button>
    <button type="button" data-mode="draw" aria-pressed="false" title="Draw freehand (D)">Draw</button>
    <button type="button" data-mode="region" aria-pressed="false" title="Drag a region (R)">Region</button>
    <span class="sep"></span><span class="count" id="ann-count">No notes</span>
    <button type="button" id="ann-clear" title="Remove all notes">Clear</button>
    <button type="button" class="send" id="ann-send" disabled title="Screenshot and add to chat">Add to chat</button>
    <button type="button" id="ann-done" title="Stop annotating (Esc)">Done</button>
  </div>
  <form id="ann-note"><div class="what" id="ann-what"></div><textarea id="ann-text" placeholder="What should change?" aria-label="Note"></textarea>
    <div class="row"><button type="button" id="ann-cancel">Cancel</button><button type="submit" class="save">Save</button></div></form>
  <div id="ann-toast" role="status"></div>`;

// Browser code, spliced into the shell's IIFE. Relies on: app, slug, setOpen, chat, chatLoaded, portalOrigin.
export const ANNOTATE_JS = String.raw`
  const ann = {
    root: document.getElementById("ann"), bar: document.getElementById("ann-bar"), hl: document.getElementById("ann-hl"),
    ink: document.getElementById("ann-ink"), pins: document.getElementById("ann-pins"), note: document.getElementById("ann-note"),
    text: document.getElementById("ann-text"), what: document.getElementById("ann-what"), toast: document.getElementById("ann-toast"),
    toggle: document.getElementById("ann-toggle"), send: document.getElementById("ann-send"), count: document.getElementById("ann-count"),
    on: false, mode: "select", items: [], pending: null, stroke: null, start: null, logs: { errors: [], requests: [] },
  };
  const NS = "http://www.w3.org/2000/svg";
  const appDoc = () => { try { return app.contentDocument; } catch { return null; } };
  const appWin = () => { try { return app.contentWindow; } catch { return null; } };
  const scroll = () => { const w = appWin(); return { x: w ? w.scrollX : 0, y: w ? w.scrollY : 0 }; };
  const fit = () => { ann.root.style.width = app.clientWidth + "px"; ann.root.style.height = app.clientHeight + "px"; };
  const toast = (msg) => { ann.toast.textContent = msg; ann.toast.classList.add("on"); clearTimeout(ann.toastT); ann.toastT = setTimeout(() => ann.toast.classList.remove("on"), 3500); };

  const hookLogs = () => {
    const w = appWin();
    if (!w || w.__qmAnnHooked) return;
    w.__qmAnnHooked = true;
    const push = (list, v) => { list.push(String(v).slice(0, 300)); if (list.length > 20) list.shift(); };
    const err = w.console.error.bind(w.console);
    w.console.error = (...a) => { push(ann.logs.errors, a.map((x) => (x && x.message) || String(x)).join(" ")); err(...a); };
    w.addEventListener("error", (e) => push(ann.logs.errors, e.message || "error"));
    w.addEventListener("unhandledrejection", (e) => push(ann.logs.errors, "Unhandled rejection: " + ((e.reason && e.reason.message) || e.reason)));
    if (w.fetch) {
      const f = w.fetch.bind(w);
      w.fetch = async (input, init) => {
        const method = (init && init.method) || (input && input.method) || "GET";
        const url = typeof input === "string" ? input : (input && input.url) || String(input);
        try { const r = await f(input, init); if (!r.ok) push(ann.logs.requests, method + " " + url + " → " + r.status); return r; }
        catch (e) { push(ann.logs.requests, method + " " + url + " → failed"); throw e; }
      };
    }
  };
  app.addEventListener("load", () => { ann.logs = { errors: [], requests: [] }; hookLogs(); if (ann.on) fit(); });

  const selectorFor = (el) => {
    const doc = el.ownerDocument;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== doc.documentElement && parts.length < 5; n = n.parentElement) {
      if (n.id && doc.querySelectorAll("#" + CSS.escape(n.id)).length === 1) { parts.unshift("#" + CSS.escape(n.id)); break; }
      const test = n.getAttribute("data-testid");
      if (test) { parts.unshift("[data-testid=\"" + test + "\"]"); break; }
      let part = n.localName;
      const cls = [...n.classList].filter((c) => !/^(css|sc|jsx)-|[0-9a-f]{6,}/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      const sibs = n.parentElement ? [...n.parentElement.children].filter((s) => s.localName === n.localName) : [];
      if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(n) + 1) + ")";
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  const reactPath = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    const names = [];
    for (let f = key ? el[key] : null; f && names.length < 6; f = f.return) {
      const t = f.type;
      const name = t && typeof t !== "string" ? t.displayName || t.name : null;
      if (name && !/^[a-z]/.test(name) && names[0] !== name) names.unshift(name);
    }
    return names.length ? names.join(" > ") : null;
  };
  const describe = (el) => {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const r = el.getBoundingClientRect();
    return { selector: selectorFor(el), tag: el.localName, text, role: el.getAttribute("role") || null,
      label: el.getAttribute("aria-label") || el.getAttribute("alt") || null, component: reactPath(el),
      size: Math.round(r.width) + "×" + Math.round(r.height) };
  };
  const elementAt = (x, y) => { const d = appDoc(); return (d && d.elementFromPoint(x, y)) || null; };
  const elementsIn = (box) => {
    const d = appDoc(); if (!d) return [];
    const hits = [];
    for (const el of d.body ? d.body.querySelectorAll("*") : []) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.left < box.x || r.top < box.y || r.right > box.x + box.w || r.bottom > box.y + box.h) continue;
      if (hits.some((h) => h.contains(el))) continue;
      hits.push(el);
      if (hits.length >= 6) break;
    }
    return hits;
  };

  const redraw = () => {
    const s = scroll();
    ann.pins.replaceChildren(); ann.ink.replaceChildren();
    ann.items.forEach((it, i) => {
      const dx = it.scroll.x - s.x, dy = it.scroll.y - s.y;
      if (it.points) {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", it.points.map((pt, j) => (j ? "L" : "M") + (pt.x + dx) + "," + (pt.y + dy)).join(" "));
        p.setAttribute("fill", "none"); p.setAttribute("stroke", "#e5484d"); p.setAttribute("stroke-width", "3");
        p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
        ann.ink.append(p);
      } else {
        const r = document.createElementNS(NS, "rect");
        r.setAttribute("x", it.box.x + dx); r.setAttribute("y", it.box.y + dy); r.setAttribute("width", it.box.w); r.setAttribute("height", it.box.h);
        r.setAttribute("fill", "rgb(229 72 77 / 0.08)"); r.setAttribute("stroke", "#e5484d"); r.setAttribute("stroke-width", "2"); r.setAttribute("rx", "2");
        if (it.kind === "region") r.setAttribute("stroke-dasharray", "5 3");
        ann.ink.append(r);
      }
      const pin = document.createElement("div");
      pin.className = "pin"; pin.textContent = String(i + 1);
      pin.style.left = it.box.x + it.box.w + dx + "px"; pin.style.top = it.box.y + dy + "px";
      ann.pins.append(pin);
    });
    const n = ann.items.length;
    ann.count.textContent = n ? n + (n === 1 ? " note" : " notes") : "No notes";
    ann.send.disabled = !n;
  };
  setInterval(() => { if (ann.on && ann.items.length && !ann.stroke && !ann.pending) redraw(); }, 250);

  const setMode = (mode) => {
    ann.mode = mode;
    for (const b of ann.bar.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    ann.hl.hidden = true;
  };
  const setAnnotating = (on) => {
    ann.on = on;
    ann.root.classList.toggle("on", on); ann.bar.classList.toggle("on", on);
    ann.toggle.dataset.on = on ? "1" : "0"; ann.toggle.setAttribute("aria-pressed", String(on));
    if (on) { fit(); hookLogs(); redraw(); } else closeNote();
  };
  ann.toggle.addEventListener("click", () => setAnnotating(!ann.on));
  document.getElementById("ann-done").addEventListener("click", () => setAnnotating(false));
  document.getElementById("ann-clear").addEventListener("click", () => { ann.items = []; redraw(); });
  for (const b of ann.bar.querySelectorAll("[data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
  window.addEventListener("resize", () => { if (ann.on) fit(); });

  const openNote = (pending) => {
    ann.pending = pending;
    ann.what.textContent = pending.label;
    ann.text.value = "";
    const x = Math.min(pending.box.x, app.clientWidth - 280), y = pending.box.y + pending.box.h + 8;
    ann.note.style.left = Math.max(8, x) + "px";
    ann.note.style.top = (y + 150 > app.clientHeight ? Math.max(8, pending.box.y - 150) : y) + "px";
    ann.note.classList.add("on");
    ann.text.focus();
  };
  const closeNote = () => { ann.pending = null; ann.note.classList.remove("on"); ann.hl.hidden = true; ann.ink.querySelector(".live")?.remove(); };
  ann.note.addEventListener("submit", (e) => {
    e.preventDefault();
    const p = ann.pending; if (!p) return;
    ann.items.push({ ...p, note: ann.text.value.trim() });
    closeNote(); redraw();
  });
  ann.text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ann.note.requestSubmit(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeNote(); }
  });
  document.getElementById("ann-cancel").addEventListener("click", closeNote);

  const local = (e) => { const r = ann.root.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const boxOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  ann.root.addEventListener("pointermove", (e) => {
    const pt = local(e);
    if (ann.stroke) {
      ann.stroke.push(pt);
      ann.ink.querySelector(".live")?.setAttribute("d", ann.stroke.map((q, j) => (j ? "L" : "M") + q.x + "," + q.y).join(" "));
      return;
    }
    if (ann.start) {
      const b = { x: Math.min(ann.start.x, pt.x), y: Math.min(ann.start.y, pt.y), w: Math.abs(pt.x - ann.start.x), h: Math.abs(pt.y - ann.start.y) };
      Object.assign(ann.hl.style, { left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px" }); ann.hl.hidden = false;
      return;
    }
    if (ann.mode !== "select" || ann.pending) return;
    const el = elementAt(pt.x, pt.y);
    if (!el) { ann.hl.hidden = true; return; }
    const b = boxOf(el);
    Object.assign(ann.hl.style, { left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px" }); ann.hl.hidden = false;
  });
  ann.root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || ann.pending) return;
    e.preventDefault();
    ann.root.setPointerCapture(e.pointerId);
    const pt = local(e);
    if (ann.mode === "draw") {
      ann.stroke = [pt];
      const p = document.createElementNS(NS, "path");
      p.setAttribute("class", "live"); p.setAttribute("fill", "none"); p.setAttribute("stroke", "#e5484d"); p.setAttribute("stroke-width", "3");
      p.setAttribute("stroke-linecap", "round"); ann.ink.append(p);
    } else if (ann.mode === "region") ann.start = pt;
  });
  ann.root.addEventListener("pointerup", (e) => {
    const pt = local(e);
    const s = scroll();
    if (ann.mode === "select" && !ann.pending) {
      const el = elementAt(pt.x, pt.y); if (!el) return;
      const info = describe(el);
      openNote({ kind: "element", box: boxOf(el), scroll: s, elements: [info], label: info.selector });
    } else if (ann.stroke) {
      const pts = ann.stroke; ann.stroke = null;
      if (pts.length < 3) { ann.ink.querySelector(".live")?.remove(); return; }
      const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      let els = elementsIn(box);
      if (!els.length) { const c = elementAt(box.x + box.w / 2, box.y + box.h / 2); if (c) els = [c]; }
      const infos = els.map(describe);
      openNote({ kind: "drawing", points: pts, box, scroll: s, elements: infos, label: infos.length ? "Drawing over " + infos[0].selector : "Drawing" });
    } else if (ann.start) {
      const b = { x: Math.min(ann.start.x, pt.x), y: Math.min(ann.start.y, pt.y), w: Math.abs(pt.x - ann.start.x), h: Math.abs(pt.y - ann.start.y) };
      ann.start = null;
      if (b.w < 6 || b.h < 6) { ann.hl.hidden = true; return; }
      const infos = elementsIn(b).map(describe);
      openNote({ kind: "region", box: b, scroll: s, elements: infos, label: "Region " + Math.round(b.w) + "×" + Math.round(b.h) });
    }
  });
  ann.root.addEventListener("wheel", (e) => { const w = appWin(); if (w) w.scrollBy(e.deltaX, e.deltaY); }, { passive: true });
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape" && ann.on) { e.preventDefault(); ann.pending ? closeNote() : setAnnotating(false); }
    else if (ann.on && ({ s: "select", d: "draw", r: "region" })[e.key]) setMode(({ s: "select", d: "draw", r: "region" })[e.key]);
  });

  // One native tab capture, cropped to the app iframe. Marks on the overlay are part of the frame.
  const screenshot = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false,
        preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude" });
    } catch { return null; }
    try {
      document.body.classList.add("ann-capturing");
      const video = document.createElement("video");
      video.muted = true; video.srcObject = stream; await video.play();
      await new Promise((r) => setTimeout(r, 350));
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = vw / window.innerWidth;
      const r = app.getBoundingClientRect();
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(r.width * scale); canvas.height = Math.round(r.height * scale);
      canvas.getContext("2d").drawImage(video, r.left * scale, r.top * scale, r.width * scale, r.height * scale, 0, 0, canvas.width, canvas.height);
      if (!vw || !vh) return null;
      return await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
    } finally {
      document.body.classList.remove("ann-capturing");
      for (const track of stream.getTracks()) track.stop();
    }
  };
  const feedbackText = (hasShot) => {
    const w = appWin();
    const where = w ? w.location.pathname + w.location.search : "/";
    const lines = ["Feedback on " + where + " (" + app.clientWidth + "×" + app.clientHeight + ")", ""];
    ann.items.forEach((it, i) => {
      const note = it.note || "(no note)";
      lines.push((i + 1) + ". " + note);
      const kind = it.kind === "element" ? "Element" : it.kind === "drawing" ? "Drawn over" : "Region containing";
      for (const el of it.elements.slice(0, 4)) {
        const bits = ["\x60" + el.selector + "\x60"];
        if (el.text) bits.push("\"" + el.text + "\"");
        if (el.label) bits.push("label \"" + el.label + "\"");
        if (el.component) bits.push("component " + el.component);
        bits.push(el.size);
        lines.push("   " + kind + ": " + bits.join(" · "));
      }
      if (!it.elements.length) lines.push("   " + kind + " empty area at " + Math.round(it.box.x) + "," + Math.round(it.box.y + it.scroll.y));
    });
    lines.push("");
    lines.push(hasShot ? "The attached screenshot shows each note by number." : "No screenshot: screen capture was declined or unavailable.");
    if (ann.logs.errors.length) lines.push("", "Console errors:", ...ann.logs.errors.slice(-5).map((x) => "- " + x));
    if (ann.logs.requests.length) lines.push("", "Failed requests:", ...ann.logs.requests.slice(-5).map((x) => "- " + x));
    return lines.join("\n");
  };
  const deliver = (payload) => new Promise((resolve) => {
    let tries = 0;
    const onAck = (event) => {
      if (event.source !== chat.contentWindow || event.origin !== portalOrigin) return;
      if (event.data?.type !== "qm:annotations-ack" || event.data.id !== payload.id) return;
      clearInterval(timer); window.removeEventListener("message", onAck); resolve(true);
    };
    window.addEventListener("message", onAck);
    const post = () => {
      if (++tries > 60) { clearInterval(timer); window.removeEventListener("message", onAck); resolve(false); return; }
      try { chat.contentWindow.postMessage(payload, portalOrigin); } catch {}
    };
    const timer = setInterval(post, 500);
    post();
  });
  ann.send.addEventListener("click", async () => {
    if (!ann.items.length) return;
    ann.send.disabled = true;
    closeNote();
    const shot = await screenshot();
    const files = shot ? [new File([shot], "annotated-" + slug + ".png", { type: "image/png" })] : [];
    const text = feedbackText(!!shot);
    const loading = chatLoaded ? null : new Promise((resolve) => chat.addEventListener("load", resolve, { once: true }));
    setOpen(true);
    if (loading) await loading;
    const ok = await deliver({ type: "qm:annotations", id: Date.now() + "-" + Math.random().toString(36).slice(2), text, files });
    if (ok) { ann.items = []; setAnnotating(false); toast(shot ? "Added to chat with screenshot" : "Added to chat (no screenshot)"); }
    else { toast("Chat didn't respond. Your notes are still here."); }
    redraw();
  });
`;
