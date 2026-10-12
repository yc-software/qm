import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { scopeId, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { SandboxAccessPlan } from "../src/sandbox/sandbox-resources.ts";

const conversation = scopeId("channel", "C1");
const other = scopeId("channel", "C2");
const defaultBox: SandboxHandle = { id: "default", rootDir: "/workspace" };
const selectedBox: SandboxHandle = { id: "selected", rootDir: "/workspace" };

function plan(id: string, ownerScopeId: string, crossScope = false): SandboxAccessPlan {
  return {
    resource: { id, ownerScopeId, backingScopeId: `sandbox-${id}` },
    crossScope,
  } as unknown as SandboxAccessPlan;
}

function harness(opts: { access?: SandboxAccessPlan; extra?: Partial<ToolContextDeps> } = {}) {
  const disks = new Map<string, Map<string, string>>([
    ["default", new Map([["notes.md", "default copy"]])],
    ["selected", new Map([["notes.md", "selected copy"], ["app/server.js", "listen()"]])],
  ]);
  const stored: Array<{ scope: string; path: string }> = [];
  const artifacts: Array<Record<string, unknown>> = [];
  const grants: Array<Record<string, unknown>> = [];
  const deployed: Array<Record<string, unknown>> = [];
  let defaultProvisions = 0;
  const layers: WorkspaceLayer[] = [{ scopeId: conversation, mountPath: "", mode: "rw" }];
  const sandbox = {
    profile: { backend: "modal" },
    readFile: async (h: SandboxHandle, path: string) => disks.get(h.id)?.get(path) ?? null,
    readFileBytes: async (h: SandboxHandle, path: string) => {
      const v = disks.get(h.id)?.get(path);
      return v === undefined ? null : new TextEncoder().encode(v);
    },
    writeFile: async (h: SandboxHandle, path: string, data: string) => {
      disks.get(h.id)!.set(path, data);
    },
    listDir: async (h: SandboxHandle) => [...disks.get(h.id)!.keys()].filter((p) => p.startsWith("app/")),
  } as unknown as Sandbox;
  const ctx = createToolContext({
    sandbox,
    provision: async () => {
      defaultProvisions += 1;
      return defaultBox;
    },
    sandboxResources: {} as never,
    accessSandboxResource: async (id) => {
      if (!opts.access || opts.access.resource.id !== id) throw new Error(`sandbox not found: ${id}`);
      return opts.access;
    },
    provisionResource: async (input, authorize) => {
      authorize?.(input as SandboxAccessPlan);
      return selectedBox;
    },
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {
      write: async (scope: string, path: string) => {
        stored.push({ scope, path });
      },
    } as never,
    files: {
      put: async (input: Record<string, unknown>) => {
        artifacts.push(input);
        return { artifact: { ...input }, created: true };
      },
      resolveByOwnerPaths: async () => [],
    } as never,
    acl: {
      grant: async (input: Record<string, unknown>) => {
        grants.push(input);
      },
    } as never,
    deploy: {
      getDeployment: async () => ({ entrypoint: "node server.js" }),
      deployOrUpdate: async (input: Record<string, unknown>) => {
        deployed.push(input);
        return { id: "d1", name: "site", currentVersion: 2, createdInScope: input.createdInScope };
      },
      deploymentGrantees: async () => [],
    } as never,
    createdBy: "U1",
    persistWritesToStore: { excludeDirs: [] },
    ...opts.extra,
  });
  return { ctx, disks, stored, artifacts, grants, deployed, provisions: () => defaultProvisions };
}

test("a selected sandbox read never falls back to the default computer", async () => {
  const h = harness({ access: plan("sb1", conversation) });
  assert.deepEqual(await h.ctx.read("notes.md", undefined, "sb1"), {
    content: "selected copy",
    sourceScopeId: conversation,
  });
  await assert.rejects(h.ctx.read("notes.md", undefined, "missing"), /sandbox not found: missing/);
  await assert.rejects(h.ctx.read("notes.md", undefined, ""), /must name a sandbox/);
  assert.equal(h.provisions(), 0);
});

test("a selected write persists to that computer's backing store, not the conversation default", async () => {
  const h = harness({ access: plan("sb1", conversation) });
  await h.ctx.write("notes.md", "edited", undefined, "sb1");
  assert.equal(h.disks.get("selected")!.get("notes.md"), "edited");
  assert.equal(h.disks.get("default")!.get("notes.md"), "default copy");
  assert.deepEqual(h.stored, [{ scope: "sandbox-sb1", path: "notes.md" }]);
  assert.equal(h.provisions(), 0);
});

test("sharing from a selected sandbox grants a snapshot artifact owned by the computer's scope", async () => {
  const h = harness({ access: plan("sb1", conversation) });
  const result = await h.ctx.write("notes.md", undefined, [{ scope: scopeId("personal", "U2") }], "sb1");
  assert.deepEqual(h.stored, []);
  assert.equal(h.artifacts.length, 1);
  const artifact = h.artifacts[0]!;
  assert.match(String(artifact.path), /^artifacts\/[0-9a-f]{32}\/notes\.md$/);
  assert.equal(artifact.ownerScopeId, conversation);
  assert.equal(result.artifactId, artifact.id);
  assert.deepEqual(
    h.grants.map((g) => [g.ownerScopeId, g.ref, g.granteeScopeId]),
    [[conversation, artifact.path, scopeId("personal", "U2")]],
  );
});

test("another conversation's computer can be read but not written or shared from", async () => {
  const h = harness({ access: plan("sb2", other, true) });
  assert.equal((await h.ctx.read("notes.md", undefined, "sb2")).sourceScopeId, other);
  await assert.rejects(h.ctx.write("notes.md", "x", undefined, "sb2"), /owned by this conversation/);
  await assert.rejects(
    h.ctx.write("notes.md", undefined, [{ scope: scopeId("personal", "U2") }], "sb2"),
    /owned by this conversation/,
  );
  assert.equal(h.disks.get("selected")!.get("notes.md"), "selected copy");
  assert.deepEqual([h.stored, h.grants], [[], []]);
});

test("publish reads files from the selected sandbox while the app stays owned by its creator", async () => {
  const h = harness({ access: plan("sb2", other, true) });
  await h.ctx.publish({ dir: "app", entrypoint: "node server.js", name: "site", sandboxId: "sb2" });
  assert.equal(h.provisions(), 0);
  const [deploy] = h.deployed;
  assert.equal(deploy!.ownerScopeId, scopeId("personal", "U1"));
  assert.equal(deploy!.createdInScope, conversation);
  assert.deepEqual(
    (deploy!.files as Array<{ path: string }>).map((f) => f.path),
    ["server.js"],
  );
});

test("metadata-only publish needs no computer but still rejects an unknown sandbox", async () => {
  const h = harness();
  await h.ctx.publish({ name: "site", rollbackTo: 1 });
  assert.equal(h.provisions(), 0);
  await assert.rejects(h.ctx.publish({ name: "site", rollbackTo: 1, sandboxId: "missing" }), /sandbox not found/);
  assert.equal(h.deployed.length, 1);
});
