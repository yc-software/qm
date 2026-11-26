import { trimTrailingSlashes } from "./text.ts";

function webUiUrl(publicWebUrl: string | undefined, path: string): string | undefined {
  const raw = publicWebUrl?.trim();
  if (!raw || !/^https?:\/\//i.test(raw) || /[?#]/.test(raw)) return undefined;
  try {
    const base = new URL(raw);
    if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) return undefined;
    base.pathname = `${trimTrailingSlashes(base.pathname)}${path}`;
    return base.toString();
  } catch {
    return undefined;
  }
}

export function conversationWebUrl(publicWebUrl: string | undefined, sessionId: string): string | undefined {
  return webUiUrl(publicWebUrl, `/s/${encodeURIComponent(sessionId)}`);
}

export function fileWebUrl(publicWebUrl: string | undefined, fileId: string): string | undefined {
  return webUiUrl(publicWebUrl, `/files/${encodeURIComponent(fileId)}`);
}
