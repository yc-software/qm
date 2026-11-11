import { ACCESS_ICONS } from "../../plugins/chassis/src/app-access.ts";

const svgChildren = (icon: (typeof ACCESS_ICONS)["org"]): string =>
  icon
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(" ")}/>`,
    )
    .join("");

const SHELL_ICONS = {
  private: svgChildren(ACCESS_ICONS.restricted),
  shared: svgChildren(ACCESS_ICONS.shared),
  org: svgChildren(ACCESS_ICONS.org),
  public: svgChildren(ACCESS_ICONS.public),
};
export const SHARE_CSS = `
  header .access-btn[hidden] { display: none; }
  header .access-btn svg { stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  header .access-btn[data-level="public"] { color: var(--brand-accent); }
  header .access-btn:disabled { cursor: default; }
  header .access-btn:disabled:hover { background: transparent; }
  #share { display: none; position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 2147483000;
    background: transparent; color-scheme: normal; }
  #share.open { display: block; }
`;

export const SHARE_BUTTON = '<button type="button" class="access-btn" id="access" hidden></button>';

export const shareMarkup = (name: string): string =>
  `<iframe id="share" title="Share ${name}" allowtransparency="true"></iframe>`;

export const SHARE_JS = String.raw`
  const accessBtn = document.getElementById("access");
  const share = document.getElementById("share");
  const accessIcons = ${JSON.stringify(SHELL_ICONS).replace(/</g, "\\u003c")};
  let access = null;
  const showAccess = (next) => {
    if (!next || !accessIcons[next.level]) return;
    access = next;
    accessBtn.hidden = false;
    accessBtn.dataset.level = next.level;
    accessBtn.disabled = !next.canEdit;
    accessBtn.title = next.detail + (next.canEdit ? ". Click to change who can open it." : "");
    accessBtn.setAttribute("aria-label", "Access: " + next.label + ". " + next.detail + (next.canEdit ? ". Change access" : ""));
    accessBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + accessIcons[next.level] + "</svg>";
    const text = document.createElement("span");
    text.textContent = next.label;
    accessBtn.append(text);
  };
  const shareUrl = portal + "/app-share?slug=" + encodeURIComponent(slug);
  const closeShare = () => {
    share.classList.remove("open");
    share.src = "about:blank";
    accessBtn.focus();
    void poll();
  };
  const shareMessage = (data) => {
    if (data?.type === "qm:app-check") void poll();
    if (data?.type === "qm:app-share-closed") closeShare();
  };
  accessBtn.addEventListener("click", () => {
    if (!access?.canEdit) return;
    share.src = shareUrl + "&name=" + encodeURIComponent(document.getElementById("name").textContent || "");
    share.classList.add("open");
  });
  share.addEventListener("load", () => {
    if (share.classList.contains("open")) share.contentWindow.postMessage({ type: "qm:theme-request" }, portalOrigin);
  });
`;
