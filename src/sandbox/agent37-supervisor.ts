import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { shq } from "../util/shell.ts";
import type { ExecOptions, ExecResult } from "./sandbox.ts";

const execute = promisify(execFile);

export async function runAgent37Supervisor(
  instanceId: string,
  command: string,
  options: (ExecOptions & { input?: Uint8Array }) | undefined,
  apiKey: string,
  request: (method: string, path: string, body?: unknown) => Promise<unknown>,
): Promise<ExecResult> {
  if (!/^[a-z0-9-]+$/.test(instanceId)) throw new Error("Invalid Agent37 instance identity");
  const directory = await mkdtemp(join(tmpdir(), "qm-supervisor-ssh-"));
  let registrationId: string | undefined;
  try {
    const key = join(directory, "key");
    await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const registered = await request("POST", "/v1/ssh-keys", {
      public_key: (await readFile(`${key}.pub`, "utf8")).trim(),
      name: `qm-supervisor-${directory.split("/").at(-1)}`,
    });
    if (!registered || typeof registered !== "object" || !("id" in registered) || typeof registered.id !== "string")
      throw new Error("Agent37 SSH key registration returned no identity");
    registrationId = registered.id;
    const tunnel = new URL("./agent37-supervisor-tunnel.mjs", import.meta.url).pathname;
    const proxy = `${shq(process.execPath)} ${shq(tunnel)} %h`;
    try {
      const pending = execute(
        "ssh",
        [
          "-F",
          "/dev/null",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "LogLevel=ERROR",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "ConnectTimeout=30",
          "-o",
          `ProxyCommand=${proxy}`,
          "-i",
          key,
          `root@${instanceId}.agent37.app`,
          command,
        ],
        {
          env: { AGENT37_API_KEY: apiKey },
          timeout: options?.timeoutMs ?? 600_000,
          signal: options?.signal,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      pending.child.stdin?.end(options?.input ? Buffer.from(options.input) : undefined);
      const result = await pending;
      return { ...result, code: 0, timedOut: false };
    } catch (error) {
      if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
        const code = "code" in error && typeof error.code === "number" ? error.code : 1;
        return {
          stdout: String(error.stdout),
          stderr: String(error.stderr),
          code,
          timedOut: "killed" in error && error.killed === true,
        };
      }
      throw error;
    }
  } finally {
    try {
      if (registrationId) await request("DELETE", `/v1/ssh-keys/${encodeURIComponent(registrationId)}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
