import type { OutgoingAttachment } from "../../types.ts";
import { hasParentPathSegment, type Sandbox, type SandboxHandle } from "../../sandbox/sandbox.ts";
import type { BlobTransferStore } from "../../persistence/blob-transfer.ts";
import type { AttachFiles, AttachResult } from "../../tools/primitives.ts";
import {
  collectNamedOutbound,
  discardOutbound,
  MAX_OUTBOUND_FILES,
  type ArtifactRegistration,
} from "../attachments.ts";

export interface AttachToolsContext {
  sandbox: Sandbox;
  provision: () => Promise<SandboxHandle>;
  blobTransfer: BlobTransferStore;
  fileRegistration: ArtifactRegistration;
}

export interface StagedAttachments {
  attach: AttachFiles;
  staged: () => OutgoingAttachment[];
}

interface StagedEntry {
  attachment: OutgoingAttachment;
  created: ReadonlySet<string>;
}

export function createAttachStaging(ctx: AttachToolsContext): StagedAttachments {
  const staged = new Map<string, StagedEntry>();
  let calls = 0;
  const attach = async (files: readonly string[]): Promise<AttachResult> => {
    const paths = [...new Set(files.map((f) => String(f ?? "").trim()).filter(Boolean))];
    if (!paths.length) return { ok: false, message: "attach needs at least one workspace file path" };
    const invalid = paths.filter(hasParentPathSegment);
    if (invalid.length)
      return {
        ok: false,
        message: `couldn't attach: ${invalid.map((p) => `${p} (not found)`).join(", ")} — nothing was staged; fix the path(s) and retry`,
      };
    const resulting = new Set([...staged.keys(), ...paths]);
    if (resulting.size > MAX_OUTBOUND_FILES)
      return {
        ok: false,
        message: `too many files — a reply carries at most ${MAX_OUTBOUND_FILES}, and ${staged.size} ${staged.size === 1 ? "is" : "are"} already staged`,
      };
    const handle = await ctx.provision();
    const register = { ...ctx.fileRegistration, seed: `${ctx.fileRegistration.seed}:attach:${calls}` };
    calls += 1;
    const keptNames = [...staged.entries()]
      .filter(([path]) => !paths.includes(path))
      .map(([, entry]) => entry.attachment.name);
    const r = await collectNamedOutbound(ctx.sandbox, handle, paths, ctx.blobTransfer, register, keptNames);
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
      const path = paths[i]!;
      const superseded = staged.get(path);
      staged.set(path, { attachment, created: r.createdArtifactIds });
      if (superseded) await discardOutbound(superseded.attachment, ctx.blobTransfer, register, superseded.created);
    }
    return {
      ok: true,
      files: r.attachments.map((a) => ({
        name: a.name,
        mimetype: a.mimetype,
        sizeBytes: a.sizeBytes,
        ...(a.artifactId ? { artifactId: a.artifactId } : {}),
      })),
      staged: staged.size,
    };
  };
  return { attach, staged: () => [...staged.values()].map((e) => e.attachment) };
}
