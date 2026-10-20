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

const SUDO_KEPT_ENV = [...NONINTERACTIVE_ENV.map(([name]) => name), ...DROPPED_PROXY_ENV, "GIT_HTTP_PROXY_AUTHMETHOD"];

const SUDOERS_KEEP_ENV = `Defaults env_keep += "${SUDO_KEPT_ENV.join(" ")}"`;

const INSTALL_SUDOERS_KEEP_ENV =
  "umask 337; cat > /etc/sudoers.d/.qm-env.new && " +
  "{ ! command -v visudo >/dev/null || visudo -cqf /etc/sudoers.d/.qm-env.new; } && " +
  "mv -f /etc/sudoers.d/.qm-env.new /etc/sudoers.d/qm-env";

function sudoKeepsEnvScript(): string {
  const install = shq(INSTALL_SUDOERS_KEEP_ENV);
  return (
    `{ [ ! -d /etc/sudoers.d ] || grep -qxF ${shq(SUDOERS_KEEP_ENV)} /etc/sudoers.d/qm-env || ` +
    `printf '%s\\n' ${shq(SUDOERS_KEEP_ENV)} | if [ "$(id -u)" = 0 ]; then sh -c ${install}; else sudo -n sh -c ${install}; fi; } >/dev/null 2>&1 || true`
  );
}

export function provisionPrepScript(workspaceDir: string, credLinks: string | null): string {
  return `mkdir -p ${shq(workspaceDir)}${credLinks ? ` && ${credLinks}` : ""} && { ${sudoKeepsEnvScript()}; }`;
}

export function forceThroughProxyEnv(
  egressProxyUrl: string,
  token: string,
  base: Record<string, string>,
): Record<string, string> {
  const u = new URL(egressProxyUrl);
  const url = `${u.protocol}//x:${token}@${u.host}`;
  const noProxy = "localhost,127.0.0.1,::1";
  return {
    ...base,
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: noProxy,
    https_proxy: url,
    http_proxy: url,
    no_proxy: noProxy,
    GIT_HTTP_PROXY_AUTHMETHOD: "basic",
  };
}

export function proxyExportPrefix(handle: SandboxHandle): string {
  const picked = Object.entries(handle.env ?? {}).filter(([key]) => DROPPED_PROXY_ENV.has(key));
  if (!picked.length) return "";
  return picked.map(([k, v]) => `export ${k}=${shq(v)}`).join("; ") + "; ";
}
