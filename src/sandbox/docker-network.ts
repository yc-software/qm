import { createHash } from "node:crypto";
import type { DockerExec } from "./docker-exec.ts";

export interface DockerNetworkOptions {
  member?: string;
  memberAlias?: string;
  labels?: Record<string, string>;
}

function subnet(network: string, attempt: number): string {
  const value = createHash("sha256").update(`${network}\0${attempt}`).digest().readUInt32BE(0);
  const index = value % 16384;
  return `198.${18 + (index >>> 13)}.${(index >>> 5) & 255}.${(index & 31) * 8}/29`;
}

async function networkLabel(dexec: DockerExec, network: string, label: string): Promise<string | null> {
  const inspected = await dexec(["network", "inspect", "-f", `{{index .Labels "${label}"}}`, network]);
  return inspected.code === 0 ? inspected.stdout.trim() : null;
}

export async function connectDockerNetwork(
  dexec: DockerExec,
  network: string,
  member: string,
  alias?: string,
): Promise<boolean> {
  const connected = await dexec(["network", "connect", ...(alias ? ["--alias", alias] : []), network, member]);
  if (connected.code === 0 || /already exists/i.test(connected.stderr)) return true;
  if (/not found|no such/i.test(connected.stderr)) return false;
  throw new Error(`docker network connect ${network} ${member} failed: ${connected.stderr.trim()}`);
}

export async function ensureDockerNetwork(
  dexec: DockerExec,
  network: string,
  opts: DockerNetworkOptions = {},
): Promise<void> {
  if ((await dexec(["network", "inspect", network])).code !== 0) {
    for (let attempt = 0; ; attempt++) {
      const labels = Object.entries(opts.labels ?? {}).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
      const created = await dexec(["network", "create", "--subnet", subnet(network, attempt), ...labels, network]);
      if (created.code === 0 || /already exists/i.test(created.stderr)) break;
      if (/overlap/i.test(created.stderr) && attempt < 255) continue;
      throw new Error(`docker network create ${network} failed: ${created.stderr.trim()}`);
    }
  }
  for (const [label, value] of Object.entries(opts.labels ?? {})) {
    if ((await networkLabel(dexec, network, label)) !== value) {
      throw new Error(`Docker network ${network} is not owned by ${label}=${value}`);
    }
  }
  if (!opts.member) return;
  if (!(await connectDockerNetwork(dexec, network, opts.member, opts.memberAlias))) {
    throw new Error(`docker network connect ${network} ${opts.member} failed: network not found`);
  }
}

export async function removeDockerNetwork(dexec: DockerExec, network: string, member?: string): Promise<void> {
  if (member) {
    const disconnected = await dexec(["network", "disconnect", "-f", network, member]);
    if (disconnected.code !== 0 && !/not found|no such|not connected/i.test(disconnected.stderr)) {
      throw new Error(`docker network disconnect ${network} ${member} failed: ${disconnected.stderr.trim()}`);
    }
  }
  const removed = await dexec(["network", "rm", network]);
  if (removed.code !== 0 && !/not found|no such/i.test(removed.stderr)) {
    throw new Error(`docker network rm ${network} failed: ${removed.stderr.trim()}`);
  }
}
