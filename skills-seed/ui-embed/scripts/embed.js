const rows = ".assistant-row:not(.streaming) code-block, .inbox-chat-msg.agent:not(.streaming) code-block";
const embeds = new Map();

const decode = (b64) => {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
};

const spec = (block) => {
  if ((block.getAttribute("language") || "").toLowerCase() !== "embed") return null;
  const [first = "", ...rest] = decode(block.getAttribute("code") || "")
    .trim()
    .split(/\s+/);
  let url;
  try {
    url = new URL(first);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin === location.origin || url.username || url.password) return null;
  const height = Number(rest.find((t) => t.startsWith("height="))?.slice(7));
  return { src: url.href, host: url.host, height: height >= 120 && height <= 2000 ? height : 420 };
};

const build = (s) => {
  const box = document.createElement("div");
  box.dataset.qmEmbed = "";
  Object.assign(box.style, {
    margin: "8px 0",
    border: "1px solid var(--border, #d0d0d0)",
    borderRadius: "var(--radius-md, 10px)",
    overflow: "hidden",
  });
  const bar = document.createElement("div");
  Object.assign(bar.style, {
    display: "flex",
    justifyContent: "space-between",
    padding: "4px 10px",
    font: "12px var(--app-font, system-ui)",
    color: "var(--muted-foreground, #555)",
    background: "var(--secondary, #f4f4f5)",
    borderBottom: "1px solid var(--border, #d0d0d0)",
  });
  const host = document.createElement("span");
  host.textContent = s.host;
  const open = document.createElement("a");
  Object.assign(open, { href: s.src, target: "_blank", rel: "noopener noreferrer", textContent: "Open ↗" });
  open.style.color = "inherit";
  bar.append(host, open);
  const frame = document.createElement("iframe");
  Object.assign(frame, {
    title: s.host,
    referrerPolicy: "strict-origin-when-cross-origin",
    allow: "fullscreen; clipboard-write",
  });
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals",
  );
  Object.assign(frame.style, {
    display: "block",
    width: "100%",
    height: `${s.height}px`,
    border: "0",
    background: "#fff",
  });
  frame.src = s.src;
  box.append(bar, frame);
  return box;
};

const restore = (block) => {
  const e = embeds.get(block);
  e.box.remove();
  block.style.display = e.display;
  embeds.delete(block);
};

const sync = () => {
  for (const block of [...embeds.keys()]) if (!block.isConnected || !block.matches(rows)) restore(block);
  for (const block of document.querySelectorAll(rows)) {
    const s = spec(block);
    const e = embeds.get(block);
    if (e && (e.src !== s?.src || e.height !== s?.height)) restore(block);
    if (!s) continue;
    if (!embeds.has(block)) {
      embeds.set(block, { ...s, box: build(s), display: block.style.display });
      block.style.display = "none";
    }
    const { box } = embeds.get(block);
    if (box.previousElementSibling !== block) block.after(box);
  }
};

let timer;
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(sync, 150);
};
const observer = new MutationObserver((records) => {
  if (records.some((r) => !r.target.closest?.("[data-qm-embed]"))) schedule();
});
observer.observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["class", "code", "language"],
});
canvas.onDispose(() => {
  observer.disconnect();
  clearTimeout(timer);
  for (const block of [...embeds.keys()]) restore(block);
});
sync();
