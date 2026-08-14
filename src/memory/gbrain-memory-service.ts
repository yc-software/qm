import { createHash } from "node:crypto";
import { parseScopeId, type ScopeId } from "../types.ts";
import type { MemoryService } from "./memory-service.ts";

export interface GbrainOptions {
  mcpUrl: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  deadlineMs?: number;
  onError?: (e: unknown) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface GbrainClient {
  search(scopeId: ScopeId, q: string, limit: number): Promise<string[]>;
}

const DEFAULT_DEADLINE_MS = 4000;
const DEFAULT_QUERY_LIMIT = 20;
const TOKEN_SKEW_MS = 30_000;
const MAX_SNIPPET_CHARS = 400;
const MAX_RESPONSE_BYTES = 2_000_000;
const SCOPE_NAMESPACE = "qm";
const OVERFETCH = 3;

function slugSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

export function scopeMemoryPrefix(scopeId: ScopeId): string {
  const { kind, ref } = parseScopeId(scopeId);
  const digest = createHash("sha256").update(scopeId).digest("hex").slice(0, 12);
  return `${SCOPE_NAMESPACE}/${slugSegment(kind ?? "unknown")}/${slugSegment(ref)}-${digest}`;
}

export function isVisibleToScope(scopeId: ScopeId, slug: string | undefined): boolean {
  if (!slug) return false;
  const normalized = slug
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (!normalized.startsWith(`${SCOPE_NAMESPACE}/`)) return true;
  return normalized.startsWith(`${scopeMemoryPrefix(scopeId)}/`);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function boundedText(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("gbrain response too large");
  }
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("gbrain response too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function rpcEnvelopes(body: string): unknown[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (!/^(event|data|id|retry):/m.test(trimmed)) {
    try {
      return [JSON.parse(trimmed)];
    } catch {
      return [];
    }
  }
  const out: unknown[] = [];
  for (const frame of trimmed.split(/\n\s*\n/)) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      continue;
    }
  }
  return out;
}

function toolResultText(body: string, id: number): string {
  const envelopes = rpcEnvelopes(body) as Array<{
    id?: unknown;
    error?: { message?: string };
    result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  }>;
  const match = envelopes.find((e) => e.id === id && (e.result !== undefined || e.error !== undefined));
  if (!match) throw new Error("gbrain response carried no result for this request");
  if (match.error) throw new Error(match.error.message ?? "gbrain rpc error");
  const text = match.result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (match.result?.isError) throw new Error(text || "gbrain tool error");
  return text;
}

function searchRows(text: string): Array<{ slug?: string; title?: string; body: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { results?: unknown[] })?.results)
      ? (parsed as { results: unknown[] }).results
      : [];
  const out: Array<{ slug?: string; title?: string; body: string }> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { slug?: string; title?: string; chunk_text?: string; excerpt?: string; content?: string };
    out.push({
      ...(typeof r.slug === "string" ? { slug: r.slug } : {}),
      ...(typeof r.title === "string" ? { title: r.title } : {}),
      body: (r.chunk_text ?? r.excerpt ?? r.content ?? "").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

export function createGbrainClient(options: GbrainOptions): GbrainClient {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const report = options.onError ?? (() => {});
  let token: { value: string; expiresAt: number } | undefined;
  let minting: Promise<string> | undefined;
  let rpcId = 0;

  async function mintToken(signal: AbortSignal): Promise<string> {
    const res = await doFetch(`${stripTrailingSlash(options.issuerUrl)}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: options.clientId,
        client_secret: options.clientSecret,
        scope: "read",
      }).toString(),
      redirect: "error",
      signal,
    });
    const text = await boundedText(res);
    if (!res.ok) throw new Error(`gbrain token ${res.status}`);
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("gbrain token response missing access_token");
    const lifetimeMs = Number.isFinite(body.expires_in) ? (body.expires_in as number) * 1000 : 0;
    token = { value: body.access_token, expiresAt: now() + lifetimeMs };
    return body.access_token;
  }

  async function accessToken(signal: AbortSignal): Promise<string> {
    if (token && token.expiresAt - TOKEN_SKEW_MS > now()) return token.value;
    minting ??= mintToken(signal).finally(() => {
      minting = undefined;
    });
    return minting;
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const signal = AbortSignal.timeout(deadlineMs);
    const id = ++rpcId;
    const send = async (bearer: string) =>
      doFetch(options.mcpUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
        redirect: "error",
        signal,
      });

    const bearer = await accessToken(signal);
    let res = await send(bearer);
    if (res.status === 401) {
      await res.body?.cancel();
      if (token?.value === bearer) token = undefined;
      res = await send(await accessToken(signal));
    }
    const text = await boundedText(res);
    if (!res.ok) throw new Error(`gbrain ${name} ${res.status}`);
    return toolResultText(text, id);
  }

  return {
    async search(scopeId, q, limit) {
      try {
        const text = await callTool("search", { query: q, limit: limit * OVERFETCH });
        const out: string[] = [];
        for (const row of searchRows(text)) {
          if (!isVisibleToScope(scopeId, row.slug)) continue;
          const label = row.title ?? row.slug;
          const line = label && row.body ? `${label}: ${row.body}` : row.body || label || "";
          if (line) out.push(line.slice(0, MAX_SNIPPET_CHARS));
          if (out.length >= limit) break;
        }
        return out;
      } catch (e) {
        report(e);
        return [];
      }
    },
  };
}

export function createGbrainMemory(base: MemoryService, client: GbrainClient | undefined): MemoryService {
  if (!client) return base;
  return {
    ...base,
    async query(scopeId, q, limit) {
      const cap = limit ?? DEFAULT_QUERY_LIMIT;
      const local = await base.query(scopeId, q, cap);
      if (local.length >= cap) return local;
      const remote = await client.search(scopeId, q, cap).catch(() => []);
      const seen = new Set(local.map((line) => line.toLowerCase().replace(/\s+/g, " ").trim()));
      const merged = [...local];
      for (const line of remote) {
        const key = line.toLowerCase().replace(/\s+/g, " ").trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(line);
        if (merged.length >= cap) break;
      }
      return merged;
    },
  };
}
