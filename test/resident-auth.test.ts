import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  buildResidentAuthProbeScript,
  createLivenessCache,
  probeResidentAuth,
  residentAuthProbeIsStale,
  RESIDENT_AUTH_CONNECTORS,
  type ScopeLivenessRecord,
} from "../src/credentials/resident-auth.ts";
import type { ExecResult, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const HANDLE = {} as SandboxHandle;

function fakeSandbox(run: (cmd: string) => ExecResult): Sandbox {
  return { run: async (_h: SandboxHandle, cmd: string) => run(cmd) } as unknown as Sandbox;
}

test("liveness cache: put/get round-trips a scope record", async () => {
  const cache = createLivenessCache(createMemoryMap<ScopeLivenessRecord>());
  assert.equal(await cache.get("personal:U1"), null);
  const rec: ScopeLivenessRecord = { scopeId: "personal:U1", checkedAt: 100, connectors: { "aws-sso": "active" } };
  await cache.put(rec);
  assert.deepEqual(await cache.get("personal:U1"), rec);
  assert.equal(await cache.get("personal:U2"), null);
});

test("staleness: null is stale, fresh is fresh, past-TTL is stale", () => {
  const now = 1_000_000;
  assert.equal(residentAuthProbeIsStale(null, now), true);
  const fresh: ScopeLivenessRecord = { scopeId: "s", checkedAt: now - 1000, connectors: {} };
  assert.equal(residentAuthProbeIsStale(fresh, now, 5000), false);
  const old: ScopeLivenessRecord = { scopeId: "s", checkedAt: now - 6000, connectors: {} };
  assert.equal(residentAuthProbeIsStale(old, now, 5000), true);
});

test("probe script: command -v guards each check, bounds with timeout, emits id|state", () => {
  const script = buildResidentAuthProbeScript(RESIDENT_AUTH_CONNECTORS, 6);
  assert.match(script, /command -v gh/);
  assert.match(script, /timeout 6 gh auth status/);
  assert.match(script, /echo "gh\|active"/);
  assert.match(script, /echo "gcloud\|absent"/);
  assert.match(script, /\nwait$/);
});

test("probe: parses id|state output and writes the cache", async () => {
  const cache = createLivenessCache(createMemoryMap<ScopeLivenessRecord>());
  const sandbox = fakeSandbox(() => ({
    stdout: "gh|active\nglab|inactive\ngcloud|absent\n",
    stderr: "",
    code: 0,
    timedOut: false,
  }));
  await probeResidentAuth({ sandbox, handle: HANDLE, cache, scopeId: "personal:U1", now: 500 });
  const rec = await cache.get("personal:U1");
  assert.equal(rec?.checkedAt, 500);
  assert.equal(rec?.connectors["gh"], "active");
  assert.equal(rec?.connectors["glab"], "inactive");
  assert.equal(rec?.connectors["gcloud"], "absent");
});

test("probe: a connector the probe didn't report keeps its prior cached state", async () => {
  const cache = createLivenessCache(createMemoryMap<ScopeLivenessRecord>());
  await cache.put({ scopeId: "personal:U1", checkedAt: 1, connectors: { gh: "active", glab: "active" } });
  const sandbox = fakeSandbox(() => ({ stdout: "gh|inactive\n", stderr: "", code: 0, timedOut: false }));
  await probeResidentAuth({ sandbox, handle: HANDLE, cache, scopeId: "personal:U1", now: 2 });
  const rec = await cache.get("personal:U1");
  assert.equal(rec?.connectors["gh"], "inactive");
  assert.equal(rec?.connectors["glab"], "active");
});

test("probe: an empty/timed-out result does NOT reset the staleness window", async () => {
  const cache = createLivenessCache(createMemoryMap<ScopeLivenessRecord>());
  await cache.put({ scopeId: "personal:U1", checkedAt: 1, connectors: { "aws-sso": "active" } });
  const sandbox = fakeSandbox(() => ({ stdout: "", stderr: "", code: 124, timedOut: true }));
  await probeResidentAuth({ sandbox, handle: HANDLE, cache, scopeId: "personal:U1", now: 9999 });
  const rec = await cache.get("personal:U1");
  assert.equal(rec?.checkedAt, 1);
  assert.equal(rec?.connectors["aws-sso"], "active");
});

test("catalog: includes the known resident connectors with check + reauth commands", () => {
  const ids = RESIDENT_AUTH_CONNECTORS.map((c) => c.id);
  assert.deepEqual([...ids].sort(), ["gcloud", "gh", "glab"]);
  const gh = RESIDENT_AUTH_CONNECTORS.find((c) => c.id === "gh");
  assert.equal(gh?.check, "gh auth status");
  assert.match(gh?.reauth ?? "", /gh auth login/);
  assert.equal(
    RESIDENT_AUTH_CONNECTORS.find((c) => c.id === "acmecli"),
    undefined,
  );
  assert.equal(
    RESIDENT_AUTH_CONNECTORS.find((c) => c.id === "aws-sso"),
    undefined,
  );
});
