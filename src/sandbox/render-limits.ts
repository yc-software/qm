export const RENDER_SANDBOX_TTL_SEC = 86400;
export const RENDER_COMPUTER_LIFETIME_SEC = 2592000;
export const RENDER_IDLE_STOP_MS = 3600_000;
export const RENDER_SNAPSHOT_RETENTION_MS = 10 * 365 * 86400_000;

export interface RenderBaseImage {
  ref: string;
  source: string;
  digest: string;
  name: string;
}

export function parseRenderSandboxImage(ref: string): RenderBaseImage {
  const at = ref.lastIndexOf("@");
  const source = at < 0 ? ref : ref.slice(0, at);
  const digest = at < 0 ? "" : ref.slice(at + 1);
  const colon = source.lastIndexOf(":");
  const repository = colon > source.lastIndexOf("/") ? source.slice(0, colon) : "";
  const tag = repository ? source.slice(colon + 1) : "";
  if (!tag || !/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new Error(`Render sandbox image must be <repository>:<tag>@sha256:<digest>, got ${ref}`);
  return { ref, source, digest, name: `qm-${repository.slice(repository.lastIndexOf("/") + 1)}-${tag.slice(0, 7)}` };
}
