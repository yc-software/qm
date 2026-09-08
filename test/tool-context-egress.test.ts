import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { scopeId, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createEgressStampStore, type EgressStamp } from "../src/admin/egress-stamp-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const TURN_PROXY = "http://x:turn-token@egress.test:48080";

function harness(opts: { proxied?: boolean; egress?: boolean } = {}) {
  const runs: Array<{ command: string; proxy: string | undefined }> = [];
  const minted: string[] = [];
  const stamps = createEgressStampStore(createMemoryMap<EgressStamp>());
  const handle: SandboxHandle = {
    id: "h",
    rootDir: "/workspace",
    ...(opts.proxied === false ? {} : { env: { HTTPS_PROXY: TURN_PROXY, https_proxy: TURN_PROXY } }),
  };
  const sandbox = {
    async run(h: SandboxHandle, command: string) {
      runs.push({ command, proxy: h.env?.HTTPS_PROXY });
      return { stdout: "out", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  const scope = scopeId("personal", "U1");
  const layers: WorkspaceLayer[] = [{ scopeId: scope, mountPath: "", mode: "rw" }];
  const deps: ToolContextDeps = {
    sandbox,
    provision: async () => handle,
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    ...(opts.egress === false
      ? {}
      : {
          egress: {
            async tokenFor(execId: string) {
              minted.push(execId);
              return `tok-${execId}`;
            },
            stamps,
          },
        }),
  };
  return { ctx: createToolContext(deps), runs, minted, stamps };
}

const tokenIn = (proxy: string | undefined) => (proxy ? new URL(proxy).password : undefined);

test("every execute runs under its own egress credential carrying a fresh execution id", async () => {
  const { ctx, runs, minted } = harness();
  await ctx.execute("cat README.md");
  await ctx.execute("./fetch-report.sh");
  assert.equal(minted.length, 2);
  assert.notEqual(minted[0], minted[1]);
  assert.deepEqual(
    runs.map((r) => tokenIn(r.proxy)),
    minted.map((id) => `tok-${id}`),
    "the sandbox sees the per-command token, not the turn token",
  );
  assert.ok(
    runs.every((r) => new URL(r.proxy!).host === "egress.test:48080"),
    "the proxy host is unchanged",
  );
});

test("execute reports egressed from the proxy's stamp for that execution, not from the command text", async () => {
  const { ctx, minted, stamps } = harness();
  const quiet = await ctx.execute("curl https://looks-like-network.example");
  assert.equal(quiet.egressed, false, "a command that never reached the proxy is not external, whatever it says");

  const original = stamps.has.bind(stamps);
  stamps.has = async (execId) => {
    if (execId === minted.at(-1)) {
      await stamps.stamp(execId, { scopeLabel: scopeId("personal", "U1"), principalId: "U1", host: "api.example" });
    }
    return original(execId);
  };
  const noisy = await ctx.execute("./innocent-looking.sh");
  assert.equal(noisy.egressed, true, "the stamp, not the command, decides");
});

test("without an egress proxy on the handle or without egress accounting, execute reports nothing", async () => {
  const unproxied = harness({ proxied: false });
  assert.equal((await unproxied.ctx.execute("ls")).egressed, undefined);
  assert.equal(unproxied.minted.length, 0, "no token is minted when the sandbox has no proxy to present it to");
  const unaccounted = harness({ egress: false });
  assert.equal((await unaccounted.ctx.execute("ls")).egressed, undefined);
  assert.equal(unaccounted.runs[0]!.proxy, TURN_PROXY, "the turn credential is left alone");
});
