const LIST_PAGE_SIZE = 25;
const LIST_PAGE_MAX = 100;
const LIST_TASK_PREVIEW_CHARS = 200;

const flatText = (s: string): string => s.replace(/[\s\u0085]+/g, " ").trim();

export function previewText(s: string, max = LIST_TASK_PREVIEW_CHARS): string {
  const f = flatText(s);
  if (f.length <= max) return f;
  let cut = f.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export const previewTrims = (s: string | undefined): boolean =>
  s !== undefined && flatText(s).length > LIST_TASK_PREVIEW_CHARS;

export function listOrder(
  a: { id: string; enabled: boolean; archived?: boolean; createdAt: number },
  b: { id: string; enabled: boolean; archived?: boolean; createdAt: number },
): number {
  const rank = (c: { enabled: boolean; archived?: boolean }): number => {
    if (c.archived) return 2;
    if (c.enabled) return 0;
    return 1;
  };
  return rank(a) - rank(b) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

export function pageOf<T>(
  items: T[],
  opts: { offset?: number; limit?: number },
): { page: T[]; offset: number; note: string | null } {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? LIST_PAGE_SIZE), LIST_PAGE_MAX);
  const page = items.slice(offset, offset + limit);
  const last = offset + page.length;
  if (page.length === 0) return { page, offset, note: `nothing at offset ${offset} — ${items.length} total` };
  if (items.length > last)
    return { page, offset, note: `showing ${offset + 1}–${last} of ${items.length}; next page: offset: ${last}` };
  if (offset > 0) return { page, offset, note: `showing ${offset + 1}–${last} of ${items.length}; end of list` };
  return { page, offset, note: null };
}
