import type { AgentComputerSpec } from "../sandbox/sandbox.ts";
import type { ResidentAuthConnector, ScopeLivenessRecord } from "../credentials/resident-auth.ts";
import { connectorLabel, type ConnectorStatusRecord } from "../credentials/connector-status.ts";

export interface WorkspaceLayoutInfo {
  hasGlobal: boolean;
  teamCount: number;
}

export function renderComputerBlock(spec: AgentComputerSpec | undefined, layout: WorkspaceLayoutInfo): string {
  if (!spec) return "";
  const lines: string[] = ["## This machine"];

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
    `Your workspace is \`${cwd}\` (read-write) and persists across turns — keep your work here, including anything you'll \`publish\` (publish ships files in your workspace, not files elsewhere under \`$HOME\`). \`$HOME\` (\`${home}\`) also persists and holds your logins and config.`,
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
    "To (re)log in, run the login command with the `background` tool (action=start), not `execute` — a device-flow login prints a URL/code then blocks waiting for the person to approve. Relay the URL/code, then `watch`/`poll` until it exits; never kill it mid-flight. Capture into your keychain is automatic.",
  ];
  for (const c of present) {
    if (record.connectors[c.id] === "active") {
      lines.push(`- ${c.label} — ✓ signed in`);
    } else {
      lines.push(`- ${c.label} — ✗ not signed in; to use it: \`background\` start \`${c.reauth}\``);
    }
  }
  return lines.join("\n");
}

export function renderConnectedAppsBlock(
  record: ConnectorStatusRecord | null,
  availableProviders: readonly string[] = [],
  connectionsUrl?: string,
): string {
  const allowed = new Set(availableProviders);
  const entries = Object.entries(record?.providers ?? {}).filter(([name]) => allowed.has(name));
  const connected = entries.filter(([, e]) => e.connected && !e.needsReconnect).map(([name]) => connectorLabel(name));
  const reconnect = entries
    .filter(([, e]) => e.needsReconnect)
    .map(([name, e]) => `${connectorLabel(name)}${e.refreshError ? ` (refresh failed: ${e.refreshError})` : ""}`);
  const lines = ["## Connected apps"];
  if (!availableProviders.length) {
    lines.push("No app connections are enabled by the admin. Do not suggest or offer any app connection.");
    return lines.join("\n");
  }
  const connectedNames = new Set(entries.filter(([, e]) => e.connected).map(([name]) => name));
  const available = availableProviders.filter((name) => !connectedNames.has(name));
  if (available.length) {
    lines.push(
      `Available to connect: ${available.map(connectorLabel).join(", ")}. Only suggest or offer app connections in this admin-configured list.`,
    );
  } else {
    lines.push("Only suggest or offer app connections in the admin-configured list below.");
  }
  if (connectionsUrl) lines.push(`Connection page: ${connectionsUrl}`);
  if (connected.length) {
    lines.push(`Connected: ${connected.join(", ")}. Use them directly; their auth is wired.`);
  }
  if (reconnect.length) {
    lines.push(`Needs reconnect: ${reconnect.join(", ")}. Do not use these apps until the user reconnects them.`);
  }
  return lines.join("\n");
}
