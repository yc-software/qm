export function embedFrame(source: string, origin: string): HTMLElement | null {
  const [first = "", ...rest] = source.trim().split(/\s+/);
  let url: URL;
  try {
    url = new URL(first);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin === origin || url.username || url.password) return null;
  const height = Number(rest.find((token) => token.startsWith("height="))?.slice(7));
  const box = document.createElement("qm-embed");
  const bar = document.createElement("div");
  bar.className = "qm-embed-bar";
  const host = document.createElement("span");
  host.textContent = url.host;
  const open = document.createElement("a");
  Object.assign(open, { href: url.href, target: "_blank", rel: "noopener noreferrer", textContent: "Open ↗" });
  bar.append(host, open);
  const frame = document.createElement("iframe");
  frame.title = url.host;
  frame.setAttribute("src", url.href);
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
  );
  frame.setAttribute("allow", "fullscreen; clipboard-write");
  frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  frame.setAttribute("loading", "lazy");
  frame.style.height = `${height >= 120 && height <= 2000 ? height : 420}px`;
  box.append(bar, frame);
  return box;
}
