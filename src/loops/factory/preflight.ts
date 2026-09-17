import { shq } from "../../util/shell.ts";
import { supportsProcessSessions, type Sandbox, type SandboxHandle } from "../../sandbox/sandbox.ts";

export const FACTORY_REQUIRED_TOOLS = ["bash", "git", "gh", "jq", "curl", "node", "npm", "claude"] as const;
export const FACTORY_PROOF_TOOLS = ["npx"] as const;
export const FACTORY_PREFLIGHT_TIMEOUT_MS = 30_000;

const PLAYWRIGHT_PROBE_COMMAND = "npx --no -- playwright --version";

export type PreflightResult =
  | { ok: true; versions: Record<string, string> }
  | { ok: false; reason: "no_process_sessions" }
  | { ok: false; reason: "missing_tools"; missing: string[]; versions: Record<string, string> };

export const factoryToolProbeScript = (tools: readonly string[]): string =>
  `for t in ${tools.map(shq).join(" ")}; do if command -v "$t" >/dev/null 2>&1; then printf '%s=ok %s\\n' "$t" "$("$t" --version 2>/dev/null | head -n 1)"; else printf '%s=missing\\n' "$t"; fi; done`;

export const parseFactoryToolProbe = (
  stdout: string,
  tools: readonly string[],
): { versions: Record<string, string>; missing: string[] } => {
  const reported = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const status = line.slice(separator + 1);
    if (status !== "ok" && !status.startsWith("ok ")) continue;
    reported.set(line.slice(0, separator), status.slice("ok".length).trim());
  }
  const versions: Record<string, string> = {};
  const missing: string[] = [];
  for (const tool of tools) {
    const version = reported.get(tool);
    if (version === undefined) missing.push(tool);
    else versions[tool] = version;
  }
  return { versions, missing };
};

const firstNonEmptyLine = (stdout: string): string =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

export async function preflightFactorySandbox(
  sandbox: Sandbox,
  handle: SandboxHandle,
  opts?: { requireProof?: boolean },
): Promise<PreflightResult> {
  if (!supportsProcessSessions(sandbox)) return { ok: false, reason: "no_process_sessions" };
  const requireProof = opts?.requireProof === true;
  const tools: string[] = requireProof
    ? [...FACTORY_REQUIRED_TOOLS, ...FACTORY_PROOF_TOOLS]
    : [...FACTORY_REQUIRED_TOOLS];
  const probe = await sandbox.run(handle, factoryToolProbeScript(tools), {
    timeoutMs: FACTORY_PREFLIGHT_TIMEOUT_MS,
  });
  const { versions, missing } = parseFactoryToolProbe(probe.stdout, tools);
  if (requireProof) {
    const proof = await sandbox.run(handle, PLAYWRIGHT_PROBE_COMMAND, {
      timeoutMs: FACTORY_PREFLIGHT_TIMEOUT_MS,
    });
    const version = firstNonEmptyLine(proof.stdout);
    if (proof.code !== 0 || version === "") missing.push("playwright");
    else versions.playwright = version;
  }
  return missing.length > 0 ? { ok: false, reason: "missing_tools", missing, versions } : { ok: true, versions };
}
