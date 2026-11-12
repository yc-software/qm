import { GENERAL_ACCESS_ICONS } from "../../plugins/chassis/src/app-access.ts";

export const SHARE_CSS = `
  header .access-btn[hidden] { display: none; }
  header .access-btn[data-level="public"] { color: var(--brand-accent); }
  header .access-btn:disabled { cursor: default; }
  header .access-btn:disabled:hover { background: transparent; }
  #share-dialog { width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0; border: 0;
    background: transparent; }
  #share-dialog::backdrop { background: transparent; }
  #share-dialog:focus { outline: none; }
  #share { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: normal; }
`;

export const SHARE_BUTTON = '<button type="button" class="access-btn" id="access" hidden></button>';

export const shareMarkup = (name: string): string =>
  `<dialog id="share-dialog" tabindex="-1" aria-label="Share ${name}"><iframe id="share" title="Share ${name}" allowtransparency="true"></iframe></dialog>`;

const ACCESS_ICON_SVG = Object.fromEntries(
  Object.entries(GENERAL_ACCESS_ICONS).map(([level, nodes]) => [
    level,
    nodes
      .map(
        ([tag, attrs]) =>
          `<${tag}${Object.entries(attrs)
            .map(([k, v]) => ` ${k}="${v}"`)
            .join("")}/>`,
      )
      .join(""),
  ]),
);

export const SHARE_JS = String.raw`
  const accessBtn = document.getElementById("access");
  const shareDialog = document.getElementById("share-dialog");
  const share = document.getElementById("share");
  const accessIcons = ${JSON.stringify(ACCESS_ICON_SVG)};
  const showAccess = (next) => {
    if (!next || !accessIcons[next.level]) return;
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
  const closeShare = () => shareDialog.close();
  shareDialog.addEventListener("close", () => {
    share.src = "about:blank";
  });
  accessBtn.addEventListener("click", () => {
    share.src = shareUrl + "&name=" + encodeURIComponent(document.getElementById("name").textContent || "");
    shareDialog.showModal();
    shareDialog.focus();
  });
  share.addEventListener("load", () => {
    if (shareDialog.open) share.contentWindow.postMessage({ type: "qm:theme-request" }, portalOrigin);
  });
`;
