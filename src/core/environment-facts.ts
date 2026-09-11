import type { AgentComputerSpec } from "../sandbox/sandbox.ts";
import type { ResidentAuthConnector, ScopeLivenessRecord } from "../credentials/resident-auth.ts";
import { connectorLabel, type ConnectorStatusRecord } from "../credentials/connector-status.ts";

export interface WorkspaceLayoutInfo {
  hasGlobal: boolean;
  teamCount: number;
}

export function renderComputerBlock(spec: AgentComputerSpec | undefined, layout: WorkspaceLayoutInfo): string {
  if (!spec) return "";
  const lines: string[] = ["## Sandbox environment profile"];

  const size: string[] = [];
  if (spec.cpus) size.push(`${spec.cpus} vCPU`);
  if (spec.memoryMb) size.push(`${Math.round(spec.memoryMb / 1024)} GB RAM`);
  if (spec.diskGb) size.push(`${spec.diskGb} GB disk`);
  const head = [spec.os, size.join(" / ")].filter(Boolean).join(" · ");
  if (head) lines.push(`${head}.`);
  if (spec.runtimes?.length) lines.push(`Runtimes: ${spec.runtimes.join(", ")}.`);
  if (spec.tools?.length) lines.push(`Installed CLIs: ${spec.tools.join(", ")}.`);
  if (spec.notInstalled?.length) {
    lines.push(`NOT installed (install on demand if a task needs one): ${spec.notInstalled.join(", ")}.`);
  }

  const cwd = spec.workdir ?? ".";
  const home = spec.homeDir ?? "~";
  const ws = [
    `The workspace path is \`${cwd}\` (read-write). Recovery depends on the sandbox provider; save durable outputs to git or Files. Keep workspace outputs here, including anything you'll \`publish\` (publish ships files in your workspace, not files elsewhere under \`$HOME\`). \`$HOME\` (\`${home}\`) holds native logins and config; its recovery has the same provider limits.`,
  ];
  if (layout.hasGlobal) ws.push("Shared org files are at `./global` (read-only).");
  if (layout.teamCount > 0) {
    ws.push(`Team files are at \`./team-*\` (read-only; ${layout.teamCount} mounted).`);
  }
  lines.push(ws.join(" "));

  return lines.join("\n");
}

export function renderResidentLoginsBlock(
  record: ScopeLivenessRecord | null,
  connectors: readonly ResidentAuthConnector[],
): string {
  if (!record) return "";
  const present = connectors.filter((c) => {
    const s = record.connectors[c.id];
    return s === "active" || s === "inactive";
  });
  if (!present.length) return "";
  const lines = [
    "## Your logins",
    "Native logins on your computer (resident — each tool authenticates with its own; checked recently):",
    "Logins survive machine replacement automatically: the platform keeps an encrypted copy core-side and restores it onto a fresh machine; they are never written into workspace backups.",
    "To (re)log in, start the login command as a background process using the available process controls. A device-flow login prints a URL/code then waits for the person to approve. Relay the URL/code, then watch or poll the process until it exits; never kill it mid-flight. Capture into your keychain is automatic.",
  ];
  for (const c of present) {
    if (record.connectors[c.id] === "active") {
      lines.push(`- ${c.label} — ✓ signed in`);
    } else {
      lines.push(`- ${c.label} — ✗ not signed in; to use it: start \`${c.reauth}\` as a background process`);
    }
  }
  return lines.join("\n");
}

export function renderConnectedAppsBlock(
  record: ConnectorStatusRecord | null,
  availableProviders: readonly string[] = [],
  connectionsUrl?: string,
  setup?: { isOrgAdmin: boolean; url?: string },
): string {
  const allowed = new Set(availableProviders);
  const entries = Object.entries(record?.providers ?? {}).filter(([name]) => allowed.has(name));
  const connected = entries.filter(([, e]) => e.connected && !e.needsReconnect).map(([name]) => connectorLabel(name));
  const reconnect = entries
    .filter(([, e]) => e.needsReconnect)
    .map(([name, e]) => `${connectorLabel(name)}${e.refreshError ? ` (refresh failed: ${e.refreshError})` : ""}`);
  const lines = [
    "## Connected apps",
    "This block covers native OAuth connections only. Check other authorized sources in the live credential/login manifests and their skills before offering setup or claiming access is unavailable. Verify the user account, app capabilities, and permissions through that source; a source key alone does not prove connected account access. Reuse adequate existing access rather than asking for duplicate connections.",
  ];
  if (!availableProviders.length) {
    lines.push(
      "No native OAuth apps are enabled by the admin. Do not mint native OAuth consent links for unconfigured providers.",
    );
    if (setup?.isOrgAdmin) {
      lines.push(
        "This user is an org admin. If other authorized sources cannot meet their needs, offer to walk them through native OAuth app setup during onboarding using the admin skill. This configures native connections for the organization; it does not link their personal account. Do not mint native consent links until the chosen app is configured and enabled. If they defer setup, continue with whatever authorized access is available.",
      );
      if (setup.url) lines.push(`OAuth app setup page: ${setup.url}`);
    } else {
      lines.push(
        "If no authorized source can meet their needs, explain during onboarding that an org admin needs to configure a connection source; native OAuth is one option. Do not ask this user to configure the organization. Continue with available access, or without connections.",
      );
    }
    return lines.join("\n");
  }
  const connectedNames = new Set(entries.filter(([, e]) => e.connected).map(([name]) => name));
  const available = availableProviders.filter((name) => !connectedNames.has(name));
  if (available.length) {
    lines.push(
      `Available to connect: ${available.map(connectorLabel).join(", ")}. Only use the native OAuth consent flow for this admin-configured list.`,
    );
  } else {
    lines.push("Only use the native OAuth consent flow for the admin-configured list below.");
  }
  if (connectionsUrl) lines.push(`Connection page: ${connectionsUrl}`);
  if (connected.length) {
    lines.push(`Connected: ${connected.join(", ")}. Use them directly; their auth is wired.`);
  }
  if (reconnect.length) {
    lines.push(
      `Needs reconnect: ${reconnect.join(", ")}. Do not use these native credentials until reconnected; another authorized source may still provide access.`,
    );
  }
  return lines.join("\n");
}
