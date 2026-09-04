const DRAFTS_STORAGE_KEY = "web-ui:drafts";
const DRAFTS_CAP = 30;
const DRAFT_MAX_CHARS = 20_000;
const PERSIST_DEBOUNCE_MS = 400;

let cache: Map<string, string> | null = null;
let cachedRaw: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function newChatDraftKey(user: string | null | undefined): string {
  return `__new-chat__:${user ?? "anon"}`;
}

export function clearAllDrafts(): void {
  dropPendingPersist();
  cache = null;
  cachedRaw = null;
  try {
    localStorage.removeItem(DRAFTS_STORAGE_KEY);
  } catch {
    void 0;
  }
}

function loadDrafts(): Map<string, string> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
  } catch {
    void 0;
  }
  if (cache && (persistTimer !== null ? true : raw === cachedRaw)) return cache;
  cachedRaw = raw;
  cache = new Map();
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed)) {
      const pairs = parsed.filter(
        (p): p is [string, string] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string",
      );
      cache = new Map(pairs.slice(-DRAFTS_CAP));
    }
  } catch {
    void 0;
  }
  return cache;
}

function persistNow(): void {
  dropPendingPersist();
  if (!cache) return;
  try {
    const raw = JSON.stringify([...cache]);
    localStorage.setItem(DRAFTS_STORAGE_KEY, raw);
    cachedRaw = raw;
  } catch {
    void 0;
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

function dropPendingPersist(): void {
  if (persistTimer === null) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

export function flushDrafts(): void {
  if (persistTimer !== null) persistNow();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", flushDrafts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDrafts();
  });
}

export function storedDraft(key: string): string {
  return loadDrafts().get(key) ?? "";
}

export function saveDraft(key: string, text: string): void {
  const drafts = loadDrafts();
  drafts.delete(key);
  if (text.trim()) {
    drafts.set(key, text.slice(0, DRAFT_MAX_CHARS));
    while (drafts.size > DRAFTS_CAP) drafts.delete(drafts.keys().next().value as string);
  }
  schedulePersist();
}

export function clearDraft(key: string): void {
  const drafts = loadDrafts();
  if (drafts.delete(key)) schedulePersist();
}
