#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedAgentsSandbox } from "../src/sandbox/managed-agents-sandbox.ts";
import { createSdkManagedAgentsClient } from "../src/sandbox/managed-agents-client.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";

const apiToken = process.env.DO_AGENTS_API_TOKEN;
const apiBaseUrl = process.env.DO_AGENTS_API_BASE_URL;
const template = process.env.DO_AGENTS_TEMPLATE ?? "";
const agent = process.env.DO_AGENTS_AGENT;
const keep = process.env.DO_AGENTS_SMOKE_KEEP === "1";

const log = (...a: unknown[]) => console.log("[managed-agents-smoke]", ...a);

async function main(): Promise<void> {
  if (!apiToken) throw new Error("DO_AGENTS_API_TOKEN is required");

  const client = createSdkManagedAgentsClient({
    apiToken,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(agent ? { agent } : {}),
    ...(template ? { template } : {}),
  });

  const prefix = `qms${randomBytes(3).toString("hex")}`;
  const sandbox = createManagedAgentsSandbox(
    createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "managed-agents-smoke-ws-"))),
    {
      client,
      namePrefix: prefix,
    },
  );
  const scope = scopeId("personal", "smoke");
  const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];

  log(`provisioning a qm agent computer (prefix ${prefix})...`);
  const handle = await sandbox.provision(layers, { env: { QM_SMOKE: "1" } });
  log("provisioned", handle.id, "coldStart", handle.coldStart);

  try {
    log("running a command through the qm Sandbox interface...");
    const r = await sandbox.run(handle, "pwd; echo QM_SMOKE=$QM_SMOKE; whoami");
    assert.equal(r.code, 0, `run exited ${r.code}: ${r.stderr}`);
    log("stdout:", JSON.stringify(r.stdout));
    assert.match(r.stdout, /QM_SMOKE=1/);

    log("writing and reading a workspace file through qm...");
    await sandbox.writeFile(handle, "notes/hello.txt", "written by qm");
    assert.equal(await sandbox.readFile(handle, "notes/hello.txt"), "written by qm");
    log("file round-trip OK");

    log("checking the toolchain qm expects...");
    const binaryName = (entry: string) => entry.trim().split(/\s+/)[0] ?? "";
    const declaredPresent = (sandbox.profile.spec?.tools ?? []).map(binaryName).filter(Boolean);
    const declaredAbsent = (sandbox.profile.spec?.notInstalled ?? []).map(binaryName).filter(Boolean);
    const plumbingNeeds = ["sh", "timeout", "tar", "base64", "sha256sum", "setsid", "mkfifo", "cut"];
    const probe = [...new Set([...plumbingNeeds, ...declaredPresent, ...declaredAbsent])];
    const tools = await sandbox.run(
      handle,
      `for t in ${probe.join(" ")}; do printf '%s=%s ' $t $(command -v $t >/dev/null 2>&1 && echo yes || echo NO); done; echo`,
    );
    log(tools.stdout.trim());
    const onPath = new Set(
      tools.stdout
        .trim()
        .split(/\s+/)
        .flatMap((pair) => {
          const [name, state] = pair.split("=");
          return name && state === "yes" ? [name] : [];
        }),
    );
    for (const t of plumbingNeeds)
      assert.ok(onPath.has(t), `qm's own file and process plumbing needs ${t}, which the guest does not have`);
    for (const t of declaredPresent)
      assert.ok(onPath.has(t), `the computer profile advertises ${t}, which the guest does not have`);
    for (const t of declaredAbsent)
      assert.ok(!onPath.has(t), `the computer profile says ${t} is absent, but the guest has it`);

    log("checking the guest carries no managed coding agent...");
    const bare = await sandbox.run(
      handle,
      "for t in codex claude claude-code opencode cursor hermes; do command -v $t >/dev/null && echo AGENT_ON_PATH=$t; done; echo ---; ps -eo comm= | sort -u | tr '\\n' ' '",
    );
    log("guest:", bare.stdout.trim());
    assert.doesNotMatch(bare.stdout, /AGENT_ON_PATH=/, "a bare sandbox must carry no agent CLI");

    log("checking the workspace survives a pause and resume...");
    await sandbox.run(handle, "echo persisted > survives-pause.txt");
    await sandbox.teardown(handle, {});
    const resumed = await sandbox.provision(layers, { env: { QM_SMOKE: "1" } });
    const after = await sandbox.run(resumed, "cat survives-pause.txt");
    assert.match(after.stdout, /persisted/, "the workspace did not survive a pause and resume");
    log("workspace intact after pause and resume");

    if (process.env.DO_AGENTS_SMOKE_LONG === "1") {
      log("checking a command survives past the 4-minute REST exec clamp...");
      const long = await sandbox.run(resumed, "sleep 250; echo past-the-clamp", { timeoutMs: 400_000 });
      assert.equal(long.code, 0, `long run exited ${long.code}: ${long.stderr}`);
      assert.match(long.stdout, /past-the-clamp/);
      log("250s command completed over the tunnel");
    }

    log("ALL CHECKS PASSED");
  } finally {
    if (keep) {
      log("DO_AGENTS_SMOKE_KEEP=1 — leaving the sandbox alive");
    } else {
      log("tearing down and destroying the scope...");
      await sandbox.teardown(handle, { destroy: true }).catch((e: unknown) => log("teardown failed:", e));
    }
  }
}

main().catch((e: unknown) => {
  console.error("[managed-agents-smoke] FAILED", e);
  process.exit(1);
});
