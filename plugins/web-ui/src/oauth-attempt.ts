export interface OAuthAttempt {
  user: string;
  state: string;
  expiresAt: number;
}

export function loadAttempt<T extends OAuthAttempt>(key: string, user: string): T | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null;
    return saved?.user === user && saved.expiresAt > Date.now() ? saved : null;
  } catch {
    return null;
  }
}

export function saveAttempt<T extends OAuthAttempt>(key: string, attempt: T): void {
  sessionStorage.setItem(key, JSON.stringify(attempt));
}

export function clearAttempt(key: string): void {
  sessionStorage.removeItem(key);
}

export function createReturnCapture(isReturn: (params: URLSearchParams) => boolean): {
  capture(url: string): void;
  take(): URL;
} {
  let captured: URL | null = null;
  return {
    capture(url) {
      const parsed = new URL(url);
      captured = isReturn(parsed.searchParams) ? parsed : null;
    },
    take() {
      const url = captured ?? new URL(location.href);
      captured = null;
      return url;
    },
  };
}

export function watchVisible(refresh: () => void): () => void {
  const onVisible = (): void => {
    if (!document.hidden) refresh();
  };
  window.addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
