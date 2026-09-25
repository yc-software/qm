import type { SandboxHandle } from "./sandbox.ts";
import { shq } from "../util/shell.ts";
export const NONINTERACTIVE_ENV: ReadonlyArray<readonly [string, string]> = [
  ["PAGER", "cat"],
  ["GIT_PAGER", "cat"],
  ["GIT_EDITOR", "true"],
  ["GIT_TERMINAL_PROMPT", "0"],
  ["DEBIAN_FRONTEND", "noninteractive"],
  ["AWS_PAGER", ""],
];

export function nonInteractiveShellPrefix(): string {
  const exports = NONINTERACTIVE_ENV.map(([name, def]) =>
    def === "" ? `export ${name}="\${${name}-}"` : `export ${name}="\${${name}:-${def}}"`,
  ).join("; ");
  return `exec </dev/null; ${exports}; `;
}

export const DROPPED_PROXY_ENV = new Set([
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "all_proxy",
  "no_proxy",
  "NO_PROXY",
]);

export function forceThroughProxyEnv(egressProxyUrl: string, token: string): Record<string, string> {
  const u = new URL(egressProxyUrl);
  const url = `${u.protocol}//x:${token}@${u.host}`;
  const noProxy = "localhost,127.0.0.1,::1";
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: noProxy,
    https_proxy: url,
    http_proxy: url,
    no_proxy: noProxy,
  };
}

export function proxyExportPrefix(handle: SandboxHandle): string {
  const picked = Object.entries(handle.env ?? {}).filter(([key]) => DROPPED_PROXY_ENV.has(key));
  if (!picked.length) return "";
  return picked.map(([k, v]) => `export ${k}=${shq(v)}`).join("; ") + "; ";
}
