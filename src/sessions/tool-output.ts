import { createHash } from "node:crypto";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { headSlice, tailSlice } from "../util/text.ts";
import { collectBytes } from "../util/bytes.ts";
import { swallowAs } from "../util/errors.ts";
import { currentTenant } from "../tenants/context.ts";

const TOOL_OUTPUT_SETTING = "tool_result_inline_tokens";
export const DEFAULT_INLINE_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;
export const TOOL_OUTPUT_RETENTION_DAYS = 30;
const SETTING_CACHE_MS = 30_000;
const TOOL_OUTPUT_PATH = "tool-output/";
const DIGEST_DIR = "md5/";
const UNPARKED_NOTE =
  " The full output was not kept; rerun the call narrower (filter or paginate it) if you need the rest";

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

export function inlineChars(inlineTokens: number): number {
  return inlineTokens > 0 ? inlineTokens * CHARS_PER_TOKEN : Infinity;
}

export function cutToInline(
  text: string,
  inlineTokens: number,
  where = "",
): { text: string; shownChars: number } | null {
  const budget = inlineChars(inlineTokens);
  if (text.length <= budget) return null;
  const head = headSlice(text, Math.floor(budget / 2));
  const tail = tailSlice(text, Math.floor(budget / 2));
  const marker = `\n…[output cut: showing the first ${head.length} and last ${tail.length} of ${text.length} chars.${where}]…\n`;
  return { text: head + marker + tail, shownChars: head.length + tail.length };
}

export function cutToolOutput(
  text: string,
  inlineTokens: number,
  callId: string,
): { text: string; shownChars: number } | null {
  return cutToInline(
    text,
    inlineTokens,
    ` The full output is in ${TOOL_OUTPUT_PATH}${DIGEST_DIR}${md5Hex(callId)}; reading it with the files tool copies it onto the computer (kept ${TOOL_OUTPUT_RETENTION_DAYS} days)`,
  );
}

export async function inlineTokensOf(store: Pick<ToolOutputStore, "inlineTokens"> | undefined): Promise<number> {
  return store
    ? store.inlineTokens().catch(swallowAs("tool output: inline cap", DEFAULT_INLINE_TOKENS))
    : DEFAULT_INLINE_TOKENS;
}

export interface InlineCut {
  text: string;
  unparkedText: string;
  shownChars: number;
}

export async function cutIfOverCap(
  store: Pick<ToolOutputStore, "inlineTokens">,
  text: string,
  callId: string,
): Promise<InlineCut | null> {
  const inlineTokens = await inlineTokensOf(store);
  const cut = cutToolOutput(text, inlineTokens, callId);
  return cut ? { ...cut, unparkedText: cutToInline(text, inlineTokens, UNPARKED_NOTE)!.text } : null;
}

export async function parkFullText(
  store: Pick<ToolOutputStore, "save">,
  text: string,
  cut: InlineCut,
): Promise<ToolOutputRef | null> {
  const blob = await store.save(text).catch(swallowAs("tool output: park full text", null));
  return blob ? { blob, chars: text.length, shownChars: cut.shownChars } : null;
}

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
  const tenantBytes = (id: string): DurableByteStore => opts.bytesFor(`${TOOL_OUTPUT_PATH}${id}/`);
  return {
    async inlineTokens() {
      if (setting && now() - setting.at < SETTING_CACHE_MS) return setting.value;
      const rows = await opts.pool.q("SELECT value FROM qm_settings WHERE key = $1", [TOOL_OUTPUT_SETTING]);
      setting = { value: inlineTokensFrom(rows[0]?.value), at: now() };
      return setting.value;
    },
    async save(text) {
      const id = currentTenant();
      const put = await tenantBytes(id).put(Buffer.from(text, "utf8"));
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
          now() + TOOL_OUTPUT_RETENTION_DAYS * 24 * 60 * 60_000,
        ],
      );
      return put.sha256;
    },
    async read(sessionId, ref) {
      const rows = await opts.pool.q(
        `SELECT b.storage_key, i.tenant_id::text AS tenant, i.created_at <= now() - make_interval(days => $4) AS expired
           FROM items i
      LEFT JOIN blobs b ON b.tenant_id = i.tenant_id AND b.sha256 = i.blob_sha
          WHERE i.tenant_id = qm_bound_tenant() AND i.session_id = $1 AND i.kind = 'ToolResult'
            AND md5(i.call_id) = $2 AND ($3::text IS NULL OR i.call_id = $3)
            AND i.blob_sha IS NOT NULL`,
        [sessionId, ref.digest, ref.callId ?? null, TOOL_OUTPUT_RETENTION_DAYS],
      );
      const row = rows[0];
      if (!row) return null;
      if (row.expired === true) return { expired: true };
      if (typeof row.storage_key !== "string")
        throw new Error(`tool output ${ref.digest}: the result names a parked blob with no blobs row`);
      const id = String(row.tenant);
      const key = String(row.storage_key).slice(`${TOOL_OUTPUT_PATH}${id}/`.length);
      const text = await readText(tenantBytes(id), key);
      if (text === null)
        throw new Error(`tool output ${ref.digest}: parked bytes ${row.storage_key} are missing from storage`);
      return { text };
    },
  };
}
