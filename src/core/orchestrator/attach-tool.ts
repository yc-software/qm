import type { OutgoingAttachment } from "../../types.ts";
import { type Sandbox, type SandboxHandle } from "../../sandbox/sandbox.ts";
import type { BlobTransferStore } from "../../persistence/blob-transfer.ts";
import type { AttachFiles, AttachResult, StagedFileMeta } from "../../tools/primitives.ts";
import type { Item } from "../../sessions/items.ts";
import { swallowAs } from "../../util/errors.ts";
import { isObj } from "../../util/objects.ts";
import {
  collectNamedOutbound,
  parseOutboundFiles,
  type OutboundFile,
  type OpenStoredFile,
  discardOutbound,
  MAX_OUTBOUND_FILES,
  type ArtifactRegistration,
} from "../attachments.ts";

export interface AttachToolsContext {
  sandbox: Sandbox;
  provision: (sandboxId?: string) => Promise<SandboxHandle>;
  blobTransfer: BlobTransferStore;
  fileRegistration: ArtifactRegistration;
  openStored?: OpenStoredFile;
  textOnly?: boolean;
  initial?: AttachmentState;
}

export interface StagedAttachments {
  attach: AttachFiles;
  staged: () => OutgoingAttachment[];
  snapshot: () => Pick<Extract<AttachResult, { ok: true }>, "stagedFiles" | "stagedRevision">;
  cleanup: () => Promise<void>;
}

interface StagedEntry {
  key: StagedFileMeta["key"];
  attachment: OutgoingAttachment;
  created: ReadonlySet<string>;
}

interface AttachmentState {
  entries: StagedEntry[];
  calls: number;
  revision: number;
}

export async function restoreAttachmentState(
  history: readonly Item[],
  runId: string | undefined,
  transfer: BlobTransferStore,
  openStored: OpenStoredFile,
  viewerId: string,
): Promise<AttachmentState> {
  const items = runId ? history.filter((item) => item.turnId === runId) : [];
  const calls = items.filter((item) => item.kind === "ToolCall" && item.tool === "attach").length;
  const delivered = items.filter((item) => item.kind === "AgentMessage" && item.variant === "files_delivered");
  const results = items.filter(
    (item) => item.kind === "ToolResult" && item.tool === "attach" && item.body.ok === true && !item.isError,
  );
  if (results.some((item) => item.body.stagingRecoveryError === true))
    throw new Error("The reply's attachment selection could not be recovered. Attach the files again in a new turn.");
  let revision = 0;
  let saved: unknown[] = [];
  const snapshots = [...results, ...delivered].filter((item) => Array.isArray(item.body.stagedFiles));
  if (snapshots.length) {
    for (const item of snapshots) {
      if (
        !Array.isArray(item.body.stagedFiles) ||
        typeof item.body.stagedRevision !== "number" ||
        !Number.isSafeInteger(item.body.stagedRevision)
      )
        throw new Error("The reply's attachment selection was not saved. Attach the files again in a new turn.");
      const next = item.body.stagedRevision;
      if (next < 1) throw new Error("The saved attachment selection has an invalid revision.");
      if (next > revision) {
        revision = next;
        saved = item.body.stagedFiles;
      }
    }
  } else if (results.length || delivered.length) {
    throw new Error("The reply's attachment selection was not saved. Attach the files again in a new turn.");
  }
  const metadata = saved.map((file): StagedFileMeta & { artifactId: string } => {
    if (
      !isObj(file) ||
      typeof file.artifactId !== "string" ||
      !file.artifactId ||
      typeof file.name !== "string" ||
      typeof file.mimetype !== "string" ||
      typeof file.sizeBytes !== "number" ||
      typeof file.created !== "boolean" ||
      !Array.isArray(file.key)
    )
      throw new Error("The saved attachment selection is incomplete.");
    const metadata = {
      artifactId: file.artifactId,
      name: file.name,
      mimetype: file.mimetype,
      sizeBytes: file.sizeBytes,
      created: file.created,
      ...(typeof file.artifactViewerId === "string" ? { artifactViewerId: file.artifactViewerId } : {}),
    };
    const key = file.key;
    if (key[0] === "file" && key.length === 2 && typeof key[1] === "string")
      return { ...metadata, key: ["file", key[1]] };
    if (
      key[0] === "path" &&
      key.length === 3 &&
      (key[1] === null || typeof key[1] === "string") &&
      typeof key[2] === "string"
    )
      return { ...metadata, key: ["path", key[1], key[2]] };
    throw new Error("The saved attachment selection has an invalid key.");
  });
  const unique = [...new Map(metadata.map((file) => [JSON.stringify(file.key), file])).values()];
  if (unique.length > MAX_OUTBOUND_FILES)
    throw new Error(`Reply attachments exceed the ${MAX_OUTBOUND_FILES}-file limit.`);
  if (!unique.length) return { entries: [], calls, revision };
  const restored = await collectNamedOutbound(
    undefined,
    undefined,
    unique.map((file) => ({ file_id: file.artifactId })),
    transfer,
    undefined,
    [],
    openStored,
  );
  if (
    restored.missing.length ||
    restored.empty.length ||
    restored.oversized.length ||
    restored.attachments.length !== unique.length
  )
    throw new Error("Previously attached files are no longer available.");
  return {
    calls,
    revision,
    entries: unique.map((file, index) => ({
      key: file.key,
      attachment: {
        ...restored.attachments[index]!,
        name: file.name,
        artifactViewerId: viewerId,
      },
      created: new Set(file.created ? [file.artifactId] : []),
    })),
  };
}

export function attachmentSnapshot(state: Pick<AttachmentState, "entries" | "revision">) {
  return {
    stagedFiles: state.entries.map(({ key, attachment, created }) => ({
      key,
      name: attachment.name,
      mimetype: attachment.mimetype,
      sizeBytes: attachment.sizeBytes,
      ...(attachment.artifactId ? { artifactId: attachment.artifactId } : {}),
      ...(attachment.artifactViewerId ? { artifactViewerId: attachment.artifactViewerId } : {}),
      created: created.has(attachment.artifactId ?? ""),
    })),
    stagedRevision: state.revision,
  };
}

export function createAttachStaging(ctx: AttachToolsContext): StagedAttachments {
  const staged = new Map((ctx.initial?.entries ?? []).map((entry) => [JSON.stringify(entry.key), entry]));
  let calls = ctx.initial?.calls ?? 0;
  let revision = ctx.initial?.revision ?? 0;
  const retired = new Set<string>();
  const snapshot = () => attachmentSnapshot({ entries: [...staged.values()], revision });
  const attach = async (files: readonly OutboundFile[], sandboxId?: string): Promise<AttachResult> => {
    if (ctx.textOnly)
      return { ok: false, message: "This conversation takes text messages only; nothing was attached." };
    const parsed = parseOutboundFiles(files);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const keyed = new Map(
      parsed.files.map((file) => {
        const key: StagedFileMeta["key"] =
          typeof file === "string" ? ["path", sandboxId ?? null, file] : ["file", file.file_id];
        return [JSON.stringify(key), { key, file }];
      }),
    );
    const paths = [...keyed.values()].map((entry) => entry.file);
    const keys = [...keyed.keys()];
    if (!paths.length) return { ok: false, message: "attach needs at least one file" };
    const resulting = new Set([...staged.keys(), ...keys]);
    if (resulting.size > MAX_OUTBOUND_FILES)
      return {
        ok: false,
        message: `too many files — a reply carries at most ${MAX_OUTBOUND_FILES}, and ${staged.size} ${staged.size === 1 ? "is" : "are"} already staged`,
      };
    const register = { ...ctx.fileRegistration, seed: `${ctx.fileRegistration.seed}:attach:${calls}` };
    calls += 1;
    const keptNames = [...staged.entries()]
      .filter(([path]) => !keys.includes(path))
      .map(([, entry]) => entry.attachment.name);
    const r = await collectNamedOutbound(
      ctx.sandbox,
      () => ctx.provision(sandboxId),
      paths,
      ctx.blobTransfer,
      register,
      keptNames,
      ctx.openStored,
    );
    const bad = [
      ...r.missing.map((p) => `${p} (not found)`),
      ...r.empty.map((p) => `${p} (empty)`),
      ...r.oversized.map((p) => `${p} (too large)`),
    ];
    if (bad.length)
      return {
        ok: false,
        message: `couldn't attach: ${bad.join(", ")} — nothing was staged; fix the path(s) and retry`,
      };
    for (const [i, attachment] of r.attachments.entries()) {
      const path = keys[i]!;
      const superseded = staged.get(path);
      staged.set(path, { key: keyed.get(path)!.key, attachment, created: r.createdArtifactIds });
      if (superseded) {
        const referenced = [...staged.values()].some(
          (entry) => entry.attachment.artifactId === superseded.attachment.artifactId,
        );
        const id = superseded.attachment.artifactId;
        if (id && !referenced && superseded.created.has(id)) retired.add(id);
        await discardOutbound(superseded.attachment, ctx.blobTransfer);
      }
    }
    revision++;
    return {
      ok: true,
      files: r.attachments.map((a) => ({
        name: a.name,
        mimetype: a.mimetype,
        sizeBytes: a.sizeBytes,
        ...(a.artifactId ? { artifactId: a.artifactId } : {}),
        ...(a.artifactViewerId ? { artifactViewerId: a.artifactViewerId } : {}),
      })),
      staged: staged.size,
      ...snapshot(),
    };
  };
  return {
    attach,
    staged: () => [...staged.values()].map((e) => e.attachment),
    snapshot,
    async cleanup() {
      const selected = new Set([...staged.values()].map((entry) => entry.attachment.artifactId));
      for (const id of retired) {
        if (!selected.has(id))
          await ctx.fileRegistration.store
            .delete(id)
            .catch(swallowAs("attachments: superseded artifact cleanup", undefined));
      }
      retired.clear();
    },
  };
}
