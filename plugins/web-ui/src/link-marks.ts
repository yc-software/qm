import { sessionLinkTarget, UI_BASE } from "./deep-link.ts";

const GITHUB_MARK_PATH =
  "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z";

const GITHUB_MARK = `<svg class="github-mark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="${GITHUB_MARK_PATH}"></path></svg>`;

const CONVERSATION_MARK = `<svg class="conversation-mark" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"></path></svg>`;

function isGitHubUrl(href: string): boolean {
  if (!URL.canParse(href)) return false;
  const url = new URL(href);
  return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname === "www.github.com");
}

function isConversationUrl(href: string): boolean {
  const origin = globalThis.location?.origin;
  return !!href && !!origin && origin !== "null" && sessionLinkTarget(href, origin, UI_BASE) !== null;
}

function linkMark(href: string): string | null {
  if (isGitHubUrl(href)) return GITHUB_MARK;
  if (isConversationUrl(href)) return CONVERSATION_MARK;
  return null;
}

export function markLink(anchor: Element): void {
  const mark = linkMark(anchor.getAttribute("href") ?? "");
  if (!mark) return;
  const lead = anchor.ownerDocument.createElement("span");
  lead.className = "link-mark-lead";
  lead.innerHTML = mark;
  const first = anchor.firstChild;
  if (first?.nodeType === 3) {
    const text = first as Text;
    const space = text.data.indexOf(" ");
    if (space > 0) text.splitText(space);
    lead.append(text);
  }
  anchor.prepend(lead);
}
