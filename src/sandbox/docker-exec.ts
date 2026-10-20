import { spawn } from "node:child_process";

export type DockerExec = (
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function spawnDockerExec(dockerBin: string): DockerExec {
  return (args, timeoutMs = 60_000) =>
    new Promise((res) => {
      const child = spawn(dockerBin, args, { timeout: timeoutMs, killSignal: "SIGKILL" });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (r: { code: number; stdout: string; stderr: string }) => {
        if (!settled) {
          settled = true;
          res(r);
        }
      };
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => done({ code: -1, stdout, stderr: `${stderr}\n${e.message}` }));
      child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
    });
}

export async function ensureDockerNetwork(dexec: DockerExec, net: string): Promise<string> {
  if ((await dexec(["network", "inspect", net])).code === 0) return net;
  const created = await dexec(["network", "create", net]);
  if (created.code !== 0 && (await dexec(["network", "inspect", net])).code !== 0) {
    throw new Error(`docker network create ${net} failed: ${created.stderr.trim()}`);
  }
  return net;
}

export async function dockerContainerNetworks(
  dexec: DockerExec,
  container: string,
): Promise<Record<string, unknown> | null> {
  const listed = await dexec(["ps", "-aq", "--filter", `name=^/${container}$`]);
  if (listed.code !== 0) throw new Error(`docker ps ${container} failed: ${listed.stderr.trim()}`);
  if (!listed.stdout.trim()) return null;
  const inspected = await dexec(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]);
  if (inspected.code !== 0) throw new Error(`docker inspect ${container} failed: ${inspected.stderr.trim()}`);
  try {
    return JSON.parse(inspected.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`docker inspect ${container} returned invalid network state`);
  }
}
