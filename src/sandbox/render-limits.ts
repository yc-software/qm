import { isIP } from "node:net";

export const RENDER_SANDBOX_TTL_SEC = 86400;
export const RENDER_COMPUTER_LIFETIME_SEC = 2592000;
export const RENDER_IDLE_STOP_MS = 3600_000;

export const RENDER_BASE_TOOLS: ReadonlyArray<readonly [label: string, command: string]> = [
  ["git", "git"],
  ["curl", "curl"],
  ["wget", "wget"],
  ["jq", "jq"],
  ["unzip", "unzip"],
  ["gnupg", "gpg"],
  ["python3", "python3"],
  ["gh", "gh"],
  ["aws (CLI v2)", "aws"],
  ["gcloud", "gcloud"],
  ["kubectl", "kubectl"],
  ["flyctl", "flyctl"],
  ["glab", "glab"],
];

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

export function renderEgressAllowlist(egressProxyUrl: string): string[] {
  const url = new URL(egressProxyUrl);
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    isIP(url.hostname.replace(/^\[|\]$/g, ""))
  )
    throw new Error(
      "EGRESS_PROXY_URL must be an https URL with a host name on port 443: Render network policies admit only HTTPS to named hosts",
    );
  return [url.hostname.toLowerCase()];
}
