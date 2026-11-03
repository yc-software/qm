import { SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import { setTimeout as wait } from "node:timers/promises";
import type { KeyedRows, RowTable } from "../persistence/keyed-rows.ts";
import { sleep } from "../util/async.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import type { RenderClient, RenderSnapshot } from "./render-client.ts";
import { parseRenderSandboxImage } from "./render-limits.ts";

const BUILDER_LIFETIME_SEC = 3600;
const PREPARE_POLL_MS = 15_000;
const PREPARE_RETRY_MS = 5 * 60_000;
const READY_POLL_MS = 5_000;
const READY_WAIT_MS = 45 * 60_000;

export interface StoredRenderBase {
  ref: string;
  snapshot?: RenderSnapshot;
  readyAtMs?: number;
  error?: string;
}

export const RENDER_SANDBOX_BASES: RowTable<StoredRenderBase, "digest"> = {
  table: "render_sandbox_bases",
  key: "digest",
  global: true,
  columns: { digest: "text", ref: "text", snapshot: "jsonb", readyAtMs: "bigint", error: "text" },
  migrations: [
    {
      id: "tenancy/render_sandbox_bases/0001-typed",
      statements: [
        `SET LOCAL lock_timeout = '5s'`,
        `CREATE TABLE IF NOT EXISTS render_sandbox_bases(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
        `ALTER TABLE render_sandbox_bases RENAME TO render_sandbox_bases_kv`,
        `ALTER INDEX render_sandbox_bases_pkey RENAME TO render_sandbox_bases_kv_pkey`,
        `CREATE TABLE render_sandbox_bases(
           digest TEXT PRIMARY KEY,
           ref TEXT NOT NULL,
           snapshot JSONB,
           ready_at_ms BIGINT,
           error TEXT
         )`,
        `INSERT INTO render_sandbox_bases(digest, ref, snapshot, ready_at_ms, error)
           SELECT id, json->>'ref', json->'snapshot', (json->>'readyAtMs')::bigint, json->>'error'
             FROM render_sandbox_bases_kv WHERE json->>'ref' IS NOT NULL`,
        `DROP TABLE render_sandbox_bases_kv`,
        `DO $drop_version$ BEGIN
           IF to_regclass('durable_map_versions') IS NOT NULL THEN
             DELETE FROM durable_map_versions WHERE tbl = 'render_sandbox_bases';
           END IF;
         END $drop_version$`,
      ],
    },
  ],
};

interface RenderGolden {
  ref: string;
  snapshotId: string;
}

type Progress = "ready" | "pending" | "failed";

export interface RenderBase {
  ready(onStatus?: (text: string) => void): Promise<RenderGolden>;
  prepare(signal: AbortSignal): Promise<void>;
}

export interface RenderBaseOptions {
  client: RenderClient;
  store: Pick<KeyedRows<StoredRenderBase>, "get" | "entries" | "putIfAbsent" | "merge" | "update">;
  image: string;
  hold?: <T>(work: () => Promise<T>) => Promise<T | null>;
  pollMs?: number;
  waitMs?: number;
  prepareMs?: number;
  retryMs?: number;
  onError?: (e: { category: string; code: string; message: string }) => void;
}

const isReady = (record: StoredRenderBase): boolean =>
  record.readyAtMs !== undefined && record.snapshot !== undefined && record.snapshot.expiresAtMs > Date.now();

export function createRenderBase(opts: RenderBaseOptions): RenderBase {
  const { client, store } = opts;
  const image = parseRenderSandboxImage(opts.image);
  const hold = opts.hold ?? (<T>(work: () => Promise<T>) => work());
  const pollMs = opts.pollMs ?? READY_POLL_MS;
  const waitMs = opts.waitMs ?? READY_WAIT_MS;
  const prepareMs = opts.prepareMs ?? PREPARE_POLL_MS;
  const retryMs = opts.retryMs ?? PREPARE_RETRY_MS;
  let ownGolden: RenderGolden | undefined;

  async function finish(snapshot: RenderSnapshot): Promise<Progress> {
    try {
      const available = await client.waitSnapshot(snapshot);
      await store.merge(image.digest, { snapshot: available, readyAtMs: Date.now() });
      return "ready";
    } catch (error) {
      const current = await client
        .getSnapshot(snapshot)
        .catch((lookup: unknown) =>
          lookup instanceof SandboxSnapshotNotFoundError
            ? undefined
            : swallowAs(`render-base: look up golden ${snapshot.id}`, { ...snapshot, status: "creating" as const })(
                lookup,
              ),
        );
      if (current?.status === "creating") {
        swallow(`render-base: golden ${snapshot.id} is not available yet`, error);
        return "pending";
      }
      await store
        .update(image.digest, (value) =>
          value.snapshot?.id === snapshot.id ? { ...value, snapshot: undefined } : value,
        )
        .catch(swallowAs(`render-base: clear failed golden ${snapshot.id}`, undefined));
      await client
        .deleteSnapshot(snapshot)
        .catch(swallowAs(`render-base: delete unfinished golden ${snapshot.id}`, undefined));
      throw error;
    }
  }

  async function build(imageId: string): Promise<Progress> {
    const builder = await client.create({ image: imageId, lifetimeSec: BUILDER_LIFETIME_SEC });
    let progress: Progress = "failed";
    try {
      const staged = await client.createSnapshot(builder.id, image.name);
      await store.merge(image.digest, { snapshot: staged });
      progress = await finish(staged);
      return progress;
    } finally {
      if (progress !== "pending")
        await client.terminate(builder.id).catch(swallowAs(`render-base: terminate builder ${builder.id}`, undefined));
    }
  }

  async function step(): Promise<Progress> {
    const record = (await store.get(image.digest)) ?? (await store.putIfAbsent(image.digest, { ref: image.ref }));
    if (isReady(record)) return "ready";
    try {
      if (record.error) await store.merge(image.digest, { error: undefined });
      if (record.snapshot) return await finish(record.snapshot);
      const imported = await client.importImage(image.source, image.name);
      if (imported.status === "failed")
        throw new Error(`Render image ${imported.id} failed: ${imported.failureReason || "no provider reason"}`);
      if (imported.status !== "succeeded") return "pending";
      if (imported.sourceDigest !== image.digest)
        throw new Error(`Render imported ${image.source} as ${imported.sourceDigest}, not the pinned ${image.digest}`);
      return await build(imported.id);
    } catch (error) {
      const message = errMessage(error);
      opts.onError?.({ category: "sandbox_image", code: "base_image_failed", message });
      await store
        .merge(image.digest, { error: message })
        .catch(swallowAs("render-base: record the build error", undefined));
      return "failed";
    }
  }

  return {
    async prepare(signal) {
      while (!signal.aborted) {
        const progress = await hold(step).catch((error: unknown): Progress => {
          if (signal.aborted) return "failed";
          opts.onError?.({ category: "sandbox_image", code: "base_image_failed", message: errMessage(error) });
          return "failed";
        });
        if (progress === "ready") return;
        await wait(progress === "failed" ? retryMs : prepareMs, undefined, { signal, ref: false }).catch(() => {});
      }
    },
    async ready(onStatus) {
      if (ownGolden) return ownGolden;
      const deadline = Date.now() + waitMs;
      for (let announced = false; ; announced = true) {
        const entries = await store.entries();
        const own = entries.find(([digest]) => digest === image.digest)?.[1];
        if (own && isReady(own)) return (ownGolden = { ref: own.ref, snapshotId: own.snapshot!.id });
        const older = entries
          .map(([, record]) => record)
          .filter(isReady)
          .sort((a, b) => b.readyAtMs! - a.readyAtMs!)[0];
        if (older) return { ref: older.ref, snapshotId: older.snapshot!.id };
        if (own?.error) throw new Error(`Render sandbox image ${image.ref} is not ready: ${own.error}`);
        if (Date.now() >= deadline)
          throw new Error(
            `Render sandbox image ${image.ref} is still being prepared after ${waitMs / 60_000} minutes; try again later`,
          );
        if (!announced)
          onStatus?.("Preparing the sandbox image for this deployment; the first start takes a few minutes");
        await sleep(pollMs);
      }
    },
  };
}
