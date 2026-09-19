import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext, type SkillResult } from "../src/tools/primitives.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

function ctx(useSkill: (name: string, path: string, sandboxId?: string) => Promise<SkillResult>) {
  const calls: string[] = [];
  const sandbox = {
    readFile: async (_h: SandboxHandle, _p: string) => null,
    run: async (_h: SandboxHandle, command: string) => {
      calls.push(command);
      return { stdout: "ran", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  const backgroundBroker = {
    start: async (_h: SandboxHandle, command: string) => {
      calls.push(command);
      return { processId: "p1", output: "ran", cursor: 0, status: { state: "exited", exitCode: 0 }, reattached: false };
    },
  };
  const tc = createToolContext({
    sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    useSkill,
    backgroundBroker: backgroundBroker as never,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
  return { tc, calls };
}

test("skill loads SKILL.md by default and passes the requested path through", async () => {
  const seen: Array<[string, string, string | undefined]> = [];
  const { tc } = ctx(async (name, path, sandboxId) => {
    seen.push([name, path, sandboxId]);
    return { content: `${name}:${path}`, sourceScopeId: scopeId("personal", "U1") };
  });
  assert.equal((await tc.skill("send")).content, "send:SKILL.md");
  assert.equal((await tc.skill("send", { path: "references/notes.md" })).content, "send:references/notes.md");
  assert.deepEqual(seen, [
    ["send", "SKILL.md", undefined],
    ["send", "references/notes.md", undefined],
  ]);
});

test("skill reports the synced directory when the skill ships files", async () => {
  const { tc } = ctx(async () => ({
    content: "BODY",
    sourceScopeId: scopeId("personal", "U1"),
    dir: "skills/google-workspace",
    packDir: "skills/.packs/workspace",
  }));
  const r = await tc.skill("google-workspace");
  assert.equal(r.dir, "skills/google-workspace");
  assert.equal(r.packDir, "skills/.packs/workspace");
});

test("execute, read, write and background never trigger skill synchronization", async () => {
  let loads = 0;
  const { tc, calls } = ctx(async () => {
    loads++;
    return { content: "BODY", sourceScopeId: scopeId("personal", "U1") };
  });
  await tc.execute("cd skills/google-workspace && python scripts/gmail.py");
  await tc.read("skills/google-workspace/SKILL.md");
  await tc.backgroundStart("sh skills/.packs/selected/job.sh");
  assert.equal(loads, 0);
  assert.equal(calls.length, 2);
});

test("skill without a materializer reports no file", async () => {
  const { tc } = createToolContextWithout();
  assert.deepEqual(await tc.skill("send"), { content: null, sourceScopeId: null });
});

function createToolContextWithout() {
  const tc = createToolContext({
    sandbox: {} as unknown as Sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
  return { tc };
}
