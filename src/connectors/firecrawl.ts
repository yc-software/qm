import type {
  WebScrapeOptions,
  WebScrapeResult,
  WebSearchHit,
  WebSearchOptions,
  WebSearchResult,
  WebToolDeps,
} from "../tools/primitives.ts";
import { errMessage } from "../util/errors.ts";
import { headSlice } from "../util/text.ts";

const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";
const REQUEST_TIMEOUT_MS = 60_000;
const SEARCH_LIMIT_DEFAULT = 5;
const SEARCH_CONTENT_CHARS = 5_000;

const RECENCY_TBS: Readonly<Record<NonNullable<WebSearchOptions["recency"]>, string>> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

export interface FirecrawlOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface FirecrawlPage {
  title?: unknown;
  description?: unknown;
  snippet?: unknown;
  url?: unknown;
  date?: unknown;
  markdown?: unknown;
}

interface FirecrawlScrapeData {
  markdown?: unknown;
  metadata?: {
    title?: unknown;
    url?: unknown;
    sourceURL?: unknown;
    statusCode?: unknown;
    error?: unknown;
  };
}

const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

function failureMessage(status: number, body: unknown, apiKey: string | undefined): string {
  const reported = str((body as { error?: unknown } | null)?.error);
  const detail = reported ?? `HTTP ${status}`;
  if (status === 401 || status === 403)
    return apiKey
      ? `the web provider rejected this instance's key — ${detail}`
      : `the web provider needs an api key for this — ${detail}`;
  if (status === 402) return `the web provider is out of credits — ${detail}`;
  if (status === 429)
    return apiKey
      ? `the web provider is rate-limiting this instance — ${detail}`
      : `the web provider's keyless free tier is used up for today — ${detail}`;
  return detail;
}

function hitFrom(page: FirecrawlPage, full: boolean): WebSearchHit | null {
  const url = str(page.url);
  if (!url) return null;
  const content = full ? str(page.markdown) : undefined;
  return {
    url,
    ...(str(page.title) ? { title: str(page.title)! } : {}),
    ...((str(page.description) ?? str(page.snippet)) ? { snippet: (str(page.description) ?? str(page.snippet))! } : {}),
    ...(str(page.date) ? { published: str(page.date)! } : {}),
    ...(content ? { content: headSlice(content, SEARCH_CONTENT_CHARS) } : {}),
  };
}

export function createFirecrawlWeb(opts: FirecrawlOptions): WebToolDeps {
  const apiKey = str(opts.apiKey);
  const baseUrl = (opts.baseUrl ?? FIRECRAWL_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const call = opts.fetchImpl ?? fetch;

  async function post(
    path: string,
    body: unknown,
  ): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    let res: Response;
    try {
      res = await call(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, message: `the web provider was unreachable — ${errMessage(e)}` };
    }
    const parsed = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: failureMessage(res.status, parsed, apiKey) };
    const envelope = parsed as { success?: unknown; data?: unknown; error?: unknown } | null;
    if (!envelope || envelope.success === false)
      return { ok: false, message: failureMessage(res.status, envelope, apiKey) };
    return { ok: true, data: envelope.data };
  }

  return {
    name: "Firecrawl",

    async search(query: string, searchOpts?: WebSearchOptions): Promise<WebSearchResult> {
      const q = query.trim();
      if (!q) return { ok: false, message: "a search needs a query" };
      const full = searchOpts?.full === true;
      const news = searchOpts?.kind === "news";
      const site = str(searchOpts?.site);
      const r = await post("/search", {
        query: q,
        limit: searchOpts?.limit ?? SEARCH_LIMIT_DEFAULT,
        ignoreInvalidURLs: true,
        ...(news ? { sources: [{ type: "news" }] } : {}),
        ...(site ? { includeDomains: [site.replace(/^https?:\/\//, "").replace(/\/.*$/, "")] } : {}),
        ...(searchOpts?.recency ? { tbs: RECENCY_TBS[searchOpts.recency] } : {}),
        ...(full ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } : {}),
      });
      if (!r.ok) return r;
      const data = r.data as { web?: unknown; news?: unknown } | null;
      const pages = (news ? data?.news : data?.web) ?? [];
      if (!Array.isArray(pages)) return { ok: false, message: "the web provider returned no results array" };
      return { ok: true, hits: pages.map((p) => hitFrom(p as FirecrawlPage, full)).filter((h) => h !== null) };
    },

    async scrape(url: string, scrapeOpts?: WebScrapeOptions): Promise<WebScrapeResult> {
      const target = url.trim();
      if (!target) return { ok: false, message: "a scrape needs a url" };
      const r = await post("/scrape", {
        url: target,
        formats: ["markdown"],
        onlyMainContent: true,
        ...(scrapeOpts?.fresh ? { maxAge: 0 } : {}),
      });
      if (!r.ok) return r;
      const data = (r.data ?? {}) as FirecrawlScrapeData;
      const meta = data.metadata ?? {};
      const finalUrl = str(meta.url) ?? str(meta.sourceURL) ?? target;
      const content = str(data.markdown);
      if (!content) {
        const status = typeof meta.statusCode === "number" ? ` (HTTP ${meta.statusCode})` : "";
        return {
          ok: false,
          url: finalUrl,
          message: `${str(meta.error) ?? "the page returned no readable text"}${status}`,
        };
      }
      return {
        ok: true,
        url: finalUrl,
        ...(str(meta.title) ? { title: str(meta.title)! } : {}),
        content,
      };
    },
  };
}
