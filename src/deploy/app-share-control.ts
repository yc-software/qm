export const SHARE_CSS = `
  header .access-btn[hidden] { display: none; }
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
  const accessIcons = {
    private: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    shared: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
    org: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
    public: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  };
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
  accessBtn.addEventListener("click", () => {
    if (!access?.canEdit) return;
    share.src = shareUrl + "&name=" + encodeURIComponent(document.getElementById("name").textContent || "");
    share.classList.add("open");
  });
  share.addEventListener("load", () => {
    if (share.classList.contains("open")) share.contentWindow.postMessage({ type: "qm:theme-request" }, portalOrigin);
  });
`;
