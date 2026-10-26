import { createHash } from "node:crypto";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { headSlice, tailSlice } from "../util/text.ts";
import { collectBytes } from "../util/bytes.ts";
import { swallowAs } from "../util/errors.ts";
import type { Item } from "./items.ts";

const TOOL_OUTPUT_SETTING = "tool_result_inline_tokens";
export const DEFAULT_INLINE_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;
const TOOL_OUTPUT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SETTING_CACHE_MS = 30_000;
const TOOL_OUTPUT_PATH = "tool-output/";
const DIGEST_DIR = "md5/";

export interface ToolOutputRef {
  blob: string;
  chars: number;
  shownChars: number;
}

export interface ParkedOutputKey {
  digest: string;
  callId?: string;
}

export interface ToolOutputStore {
  inlineTokens(): Promise<number>;
  save(text: string): Promise<string>;
  read(sessionId: string, key: ParkedOutputKey): Promise<{ text: string } | { expired: true } | null>;
}

export function inlineTokensFrom(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_INLINE_TOKENS;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_INLINE_TOKENS;
}

const md5Hex = (text: string): string => createHash("md5").update(text, "utf8").digest("hex");

export function parkedOutputKey(path: string): ParkedOutputKey | null {
  if (!path.startsWith(TOOL_OUTPUT_PATH)) return null;
  const name = path.slice(TOOL_OUTPUT_PATH.length);
  if (name.startsWith(DIGEST_DIR)) {
    const digest = name.slice(DIGEST_DIR.length);
    return digest.length === 32 && Buffer.from(digest, "hex").toString("hex") === digest ? { digest } : null;
  }
  return name && !name.includes("/") ? { digest: md5Hex(name), callId: name } : null;
}

export function cutToolOutput(
  text: string,
  inlineTokens: number,
  callId: string,
): { text: string; shownChars: number } | null {
  if (inlineTokens <= 0) return null;
  const budget = inlineTokens * CHARS_PER_TOKEN;
  if (text.length <= budget) return null;
  const head = headSlice(text, Math.floor(budget / 2));
  const tail = tailSlice(text, Math.floor(budget / 2));
  const marker =
    `\n…[output cut: showing the first ${head.length} and last ${tail.length} of ${text.length} chars. ` +
    `The full output is in ${TOOL_OUTPUT_PATH}${DIGEST_DIR}${md5Hex(callId)}; reading it with the files tool copies it onto the computer (kept 30 days)]…\n`;
  return { text: head + marker + tail, shownChars: head.length + tail.length };
}

export async function parkIfOverCap(
  store: Pick<ToolOutputStore, "inlineTokens" | "save">,
  text: string,
  callId: string,
): Promise<{ text: string; output: ToolOutputRef } | null> {
  const inlineTokens = await store.inlineTokens().catch(swallowAs("tool output: inline cap", DEFAULT_INLINE_TOKENS));
  const cut = cutToolOutput(text, inlineTokens, callId);
  if (!cut) return null;
  const blob = await store.save(text).catch(swallowAs("tool output: park full text", null));
  return blob ? { text: cut.text, output: { blob, chars: text.length, shownChars: cut.shownChars } } : null;
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

async function readText(bytes: DurableByteStore, blobKey: string): Promise<string | null> {
  const opened = await bytes.open(blobKey);
  if (!opened) return null;
  const { data } = await collectBytes(opened.stream, {});
  return data.toString("utf8");
}

export function createPostgresToolOutputStore(opts: {
  pool: Pick<PgPool, "q">;
  bytesFor: (prefix: string) => DurableByteStore;
  now?: () => number;
}): ToolOutputStore {
  const now = opts.now ?? (() => Date.now());
  let setting: { value: number; at: number } | null = null;
  let tenant: Promise<{ id: string; bytes: DurableByteStore }> | null = null;
  const tenantBytes = (): Promise<{ id: string; bytes: DurableByteStore }> =>
    (tenant ??= opts.pool.q("SELECT qm_tenant_id()::text AS id").then((rows) => {
      const id = rows[0]?.id as string;
      return { id, bytes: opts.bytesFor(`${TOOL_OUTPUT_PATH}${id}/`) };
    })).catch((err: unknown) => {
      tenant = null;
      throw err;
    });
  return {
    async inlineTokens() {
      if (setting && now() - setting.at < SETTING_CACHE_MS) return setting.value;
      const rows = await opts.pool.q("SELECT value FROM qm_settings WHERE key = $1", [TOOL_OUTPUT_SETTING]);
      setting = { value: inlineTokensFrom(rows[0]?.value), at: now() };
      return setting.value;
    },
    async save(text) {
      const { id, bytes } = await tenantBytes();
      const put = await bytes.put(Buffer.from(text, "utf8"));
      await opts.pool.q(
        `INSERT INTO blobs(tenant_id, sha256, size, mime, storage_key, created_at, expires_at)
         VALUES ($1::uuid, decode($2, 'hex'), $3, 'text/plain; charset=utf-8', $4,
                 to_timestamp($5::double precision / 1000), to_timestamp($6::double precision / 1000))
         ON CONFLICT (tenant_id, sha256) DO NOTHING`,
        [
          id,
          put.sha256,
          put.sizeBytes,
          `${TOOL_OUTPUT_PATH}${id}/${put.blobKey}`,
          now(),
          now() + TOOL_OUTPUT_RETENTION_MS,
        ],
      );
      return put.sha256;
    },
    async read(sessionId, ref) {
      const rows = await opts.pool.q(
        `SELECT b.storage_key, i.created_at <= now() - interval '30 days' AS expired
           FROM items i
      LEFT JOIN blobs b ON b.tenant_id = i.tenant_id AND b.sha256 = i.blob_sha
          WHERE i.tenant_id = qm_tenant_id() AND i.session_id = $1 AND i.kind = 'ToolResult'
            AND md5(i.call_id) = $2 AND ($3::text IS NULL OR i.call_id = $3)
            AND i.blob_sha IS NOT NULL`,
        [sessionId, ref.digest, ref.callId ?? null],
      );
      const row = rows[0];
      if (!row) return null;
      if (row.expired === true) return { expired: true };
      if (typeof row.storage_key !== "string")
        throw new Error(`tool output ${ref.digest}: the result names a parked blob with no blobs row`);
      const { bytes, id } = await tenantBytes();
      const key = String(row.storage_key).slice(`${TOOL_OUTPUT_PATH}${id}/`.length);
      const text = await readText(bytes, key);
      if (text === null)
        throw new Error(`tool output ${ref.digest}: parked bytes ${row.storage_key} are missing from storage`);
      return { text };
    },
  };
}

export function createMemoryToolOutputStore(
  opts: { inlineTokens?: number; sessions?: { getItems(sessionId: string): Promise<Item[]> } } = {},
): ToolOutputStore & { setInlineTokens(n: number): void; parked: Map<string, string> } {
  let cap = opts.inlineTokens ?? DEFAULT_INLINE_TOKENS;
  const parked = new Map<string, string>();
  return {
    parked,
    setInlineTokens(n) {
      cap = n;
    },
    async inlineTokens() {
      return cap;
    },
    async save(text) {
      const sha = sha256Hex(text);
      parked.set(sha, text);
      return sha;
    },
    async read(sessionId, ref) {
      const items = (await opts.sessions?.getItems(sessionId)) ?? [];
      const results = items.filter(
        (e) =>
          e.kind === "ToolResult" &&
          e.callId !== null &&
          md5Hex(e.callId) === ref.digest &&
          (ref.callId === undefined || e.callId === ref.callId),
      );
      if (results.length > 1) throw new Error(`tool output ${ref.digest}: more than one call matches`);
      const blob = results[0]?.blobSha;
      if (!blob) return null;
      const text = parked.get(blob);
      if (text === undefined) throw new Error(`tool output ${ref.digest}: parked blob ${blob} is missing`);
      return { text };
    },
  };
}
