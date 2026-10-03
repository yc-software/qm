import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Keychain } from "../src/credentials/keychain.ts";
import {
  credTransientRemoval,
  materializeDeviceFlowLogins,
  DEVICE_FLOW_ORIGIN,
} from "../src/credentials/device-flow-persist.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const sh = (home: string, script: string, path = process.env.PATH): number => {
  try {
    execFileSync("sh", ["-c", script], { env: { ...process.env, HOME: home, PATH: path }, stdio: "pipe" });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

test("removal truncates the secret even when the unlink fails, and reports what is left", () => {
  const home = mkdtempSync(join(tmpdir(), "dfc-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rm"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "rm"), 0o755);
  writeFileSync(join(home, "blob.tar"), "SECRET");
  assert.equal(sh(home, credTransientRemoval(["blob.tar"]), `${bin}:${process.env.PATH}`), 3);
  assert.equal(readFileSync(join(home, "blob.tar"), "utf8"), "");
});

test("removal succeeds on absent paths and deletes present ones", () => {
  const home = mkdtempSync(join(tmpdir(), "dfc-"));
  writeFileSync(join(home, "a"), "SECRET");
  assert.equal(sh(home, credTransientRemoval(["a", "missing", ""])), 0);
  assert.equal(existsSync(join(home, "a")), false);
});

test("a failed restore whose cleanup also fails retries once and surfaces the leftover", async () => {
  const keychain = {
    materializeOwnFiles: async () => [
      {
        service: "acmecli",
        origin: DEVICE_FLOW_ORIGIN,
        files: [{ path: ".acmecli/token", contentBase64: Buffer.from("tok").toString("base64") }],
      },
    ],
  } as unknown as Keychain;
  const commands: string[] = [];
  const sandbox = {
    writeFileBytes: async () => {},
    run: async (_h: SandboxHandle, command: string) => {
      commands.push(command);
      if (command.includes("for p in") && !command.includes(': > "$p"')) return { code: 0, stdout: "", stderr: "" };
      if (command.startsWith("sh ")) return { code: 9, stdout: "", stderr: "boom" };
      return { code: 3, stdout: "", stderr: "left: .cred-restore" };
    },
  } as unknown as Sandbox;
  const anomalies: string[] = [];
  await assert.rejects(
    materializeDeviceFlowLogins({
      sandbox,
      handle: { id: "box", rootDir: "/home/u/workspace" },
      keychain,
      ownerId: "alice@example.com",
      onAnomaly: (service, detail) => anomalies.push(`${service}: ${detail}`),
    }),
    /restore failed/,
  );
  const removals = commands.filter((c) => c.includes(': > "$p"'));
  assert.equal(removals.length, 2);
  assert.match(removals[0]!, /\.cred-restore-.*\.tar/);
  assert.equal(anomalies.length, 1);
  assert.match(anomalies[0]!, /^credential-cleanup: .*plaintext may remain/);
});
