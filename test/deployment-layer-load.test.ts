import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDeploymentLayer, loadDeploymentLayer, replaceDeploymentLayer } from "../src/deployment/load-layer.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { parseToolDescriptor } from "../src/deployment/deployment-layer.ts";
import { BASE_EPHEMERAL_CRED_LINKS, BASE_RESIDENT_AUTH_PATHS } from "../src/credentials/resident-paths.ts";
import { evaluateCommandWithLayer } from "../src/policy/command-policy.ts";

const credentialFile = (path: string) => ({ path, kind: "file" as const });
const credentialDirectory = (path: string) => ({ path, kind: "directory" as const });

function layerDir(tools: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "layer-"));
  for (const [id, descriptor] of Object.entries(tools)) {
    const toolDir = join(dir, "tools", id);
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, "tool.json"), JSON.stringify(descriptor));
  }
  return dir;
}

const ACMECLI_SHAPED = {
  id: "acmecli",
  label: "Acme CLI",
  advertise: "acmecli (organization CLI)",
  hints: ["acmecli is authenticated ambiently; never run acmecli login"],
  approvals: [{ pattern: "\\bacmecli\\b[^;|&]*\\blogin\\b", decision: "deny", reason: "ambient authentication" }],
  auth: {
    check: "acmecli me",
    reauth: "acmecli login --use-device-code",
    credentialPaths: [credentialDirectory(".acmecli"), credentialDirectory(".aws")],
    splitEnv: { ACMECLI_ACTING_SLACK_USER_ID: "{actingSlackUserId}", ACMECLI_PLATFORM: "slack" },
  },
};

test("loadDeploymentLayer derives the runtime shapes from tool descriptors", () => {
  const layer = loadDeploymentLayer(layerDir({ acmecli: ACMECLI_SHAPED, jq: { id: "jq" } }));
  assert.deepEqual(
    layer.tools.map((t) => t.id),
    ["acmecli", "jq"],
  );
  assert.deepEqual(layer.connectors, [
    { id: "acmecli", label: "Acme CLI", check: "acmecli me", reauth: "acmecli login --use-device-code" },
  ]);
  assert.deepEqual(
    layer.advertisedTools,
    ["acmecli (organization CLI)"],
    "only tools with an explicit advertise contribute",
  );
  assert.deepEqual(layer.hints, ["acmecli is authenticated ambiently; never run acmecli login"]);
  assert.deepEqual(layer.commandRules, [
    { pattern: "\\bacmecli\\b[^;|&]*\\blogin\\b", decision: "deny", reason: "ambient authentication" },
  ]);
  assert.deepEqual(layer.credentialPaths, [credentialDirectory(".acmecli"), credentialDirectory(".aws")]);
  assert.deepEqual(layer.splitEnvTemplates, [
    { ACMECLI_ACTING_SLACK_USER_ID: "{actingSlackUserId}", ACMECLI_PLATFORM: "slack" },
  ]);
});

test("brokered tools resolve to service, binary, and quarantine roots", () => {
  const layer = loadDeploymentLayer(
    layerDir({
      acmecli: {
        ...ACMECLI_SHAPED,
        auth: {
          ...ACMECLI_SHAPED.auth,
          broker: {
            kind: "aws-role",
            roleArnEnv: "ACMECLI_BROKER_ROLE_ARN",
            regionEnv: "ACMECLI_BROKER_REGION",
            region: "us-west-2",
            sessionActions: ["execute-api:Invoke"],
          },
        },
      },
      jq: { id: "jq" },
    }),
  );
  assert.deepEqual(
    layer.brokeredTools,
    [
      {
        service: "acmecli",
        binary: "acmecli",
        roots: [".acmecli"],
        broker: {
          kind: "aws-role",
          roleArnEnv: "ACMECLI_BROKER_ROLE_ARN",
          regionEnv: "ACMECLI_BROKER_REGION",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
        },
      },
    ],
    "the quarantine roots are only the paths mapping to the tool's own service — .aws stays",
  );
});

test("a layer declaring brokers on two tools is rejected at load", () => {
  const broker = { kind: "aws-role", roleArnEnv: "R_ARN", region: "us-west-2", sessionActions: ["execute-api:Invoke"] };
  assert.throws(
    () =>
      loadDeploymentLayer(
        layerDir({
          alpha: { id: "alpha", auth: { check: "c", reauth: "r", broker } },
          beta: { id: "beta", auth: { check: "c", reauth: "r", broker } },
        }),
      ),
    /brokers on multiple tools \(alpha, beta\)/,
  );
});

test("loadDeploymentLayer: an authless tool contributes no connector or paths", () => {
  const layer = loadDeploymentLayer(layerDir({ helper: { id: "helper", advertise: "helper tool" } }));
  assert.deepEqual(layer.connectors, []);
  assert.deepEqual(layer.credentialPaths, []);
  assert.deepEqual(layer.splitEnvTemplates, []);
  assert.deepEqual(layer.advertisedTools, ["helper tool"]);
});

test("command-form approval rules target install.binary and are enforced by policy evaluation", () => {
  const layer = loadDeploymentLayer(
    layerDir({
      acme: {
        id: "acme",
        install: { binary: "acmectl" },
        approvals: [{ command: "delete", decision: "require_approval" }],
      },
    }),
  );
  assert.equal(layer.commandRules[0]?.pattern, "\\bacmectl\\s+delete(?:\\b|\\s|$)");
  const policy = { mode: "denylist" as const, rules: [] };
  assert.equal(
    evaluateCommandWithLayer("acmectl delete project", policy, layer.commandRules).decision,
    "require_approval",
  );
  assert.equal(evaluateCommandWithLayer("acmectl delete", policy, layer.commandRules).decision, "require_approval");
  assert.equal(evaluateCommandWithLayer("acmectl deleteall", policy, layer.commandRules).decision, "allow");
});

test("loadDeploymentLayer: a dir with no tools/ is a valid, empty layer", () => {
  const dir = mkdtempSync(join(tmpdir(), "layer-empty-"));
  const layer = loadDeploymentLayer(dir);
  assert.deepEqual(layer.tools, []);
  assert.deepEqual(layer.advertisedTools, []);
});

test("loadDeploymentLayer throws when the configured dir itself is missing", () => {
  assert.throws(() => loadDeploymentLayer("/definitely/does/not/exist"), /does not exist/);
});

test("loadDeploymentLayer throws on a malformed descriptor (boot fails loudly)", () => {
  const dir = mkdtempSync(join(tmpdir(), "layer-bad-"));
  const toolDir = join(dir, "tools", "broken");
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, "tool.json"), "{ not json");
  assert.throws(() => loadDeploymentLayer(dir), /not valid JSON/);
});

test("loadDeploymentLayer rejects duplicate tool ids across descriptor dirs", () => {
  const dir = layerDir({ a: { id: "same" }, b: { id: "same" } });
  assert.throws(() => loadDeploymentLayer(dir), /duplicate tool id/);
});

test("loadDeploymentLayer rejects misplaced tool entries instead of silently losing tools", () => {
  const noDescriptor = mkdtempSync(join(tmpdir(), "layer-nodesc-"));
  mkdirSync(join(noDescriptor, "tools", "empty"), { recursive: true });
  assert.throws(() => loadDeploymentLayer(noDescriptor), /has no tool\.json/);

  const strayFile = mkdtempSync(join(tmpdir(), "layer-stray-"));
  mkdirSync(join(strayFile, "tools"), { recursive: true });
  writeFileSync(join(strayFile, "tools", "tool.json"), JSON.stringify({ id: "stray" }));
  assert.throws(() => loadDeploymentLayer(strayFile), /is not a tool directory/);

  const junk = mkdtempSync(join(tmpdir(), "layer-junk-"));
  mkdirSync(join(junk, "tools", "a"), { recursive: true });
  writeFileSync(join(junk, "tools", "a", "tool.json"), JSON.stringify({ id: "a" }));
  writeFileSync(join(junk, "tools", ".DS_Store"), "finder junk");
  assert.deepEqual(
    loadDeploymentLayer(junk).tools.map((t) => t.id),
    ["a"],
    "macOS junk files never fail a boot",
  );

  const linked = mkdtempSync(join(tmpdir(), "layer-linked-"));
  mkdirSync(join(linked, "tools", "a"), { recursive: true });
  writeFileSync(join(linked, "descriptor.json"), JSON.stringify({ id: "a" }));
  symlinkSync(join(linked, "descriptor.json"), join(linked, "tools", "a", "tool.json"));
  assert.throws(() => loadDeploymentLayer(linked), /must be a regular file/);
});

test("overlapping credential paths across tools are rejected while disjoint exact paths work", () => {
  const dir = layerDir({
    a: { id: "a", auth: { check: "c", reauth: "r", credentialPaths: [credentialDirectory(".acme")] } },
    b: { id: "b", auth: { check: "c", reauth: "r", credentialPaths: [credentialFile(".acme/token")] } },
  });
  assert.throws(() => loadDeploymentLayer(dir), /incompatible credential paths/);
  const ok = layerDir({
    a: { id: "a", auth: { check: "c", reauth: "r", credentialPaths: [credentialFile(".acme/token")] } },
    b: { id: "b", auth: { check: "c", reauth: "r", credentialPaths: [credentialFile(".acme/sub/key")] } },
  });
  assert.doesNotThrow(() => loadDeploymentLayer(ok));
});

const withCredentialPaths = (paths: Array<{ path: string; kind: "file" | "directory" }>): string =>
  JSON.stringify({ id: "t", auth: { check: "c", reauth: "r", credentialPaths: paths } });

test("a credentialPath overlapping a built-in resident path is rejected (ancestors and descendants)", () => {
  const platformManaged = new Set<string>([
    ...BASE_RESIDENT_AUTH_PATHS,
    ...BASE_EPHEMERAL_CRED_LINKS.map((l) => l.rel),
  ]);
  for (const base of platformManaged) {
    assert.throws(
      () => parseToolDescriptor(withCredentialPaths([credentialFile(`${base}/leaf`)]), "t.json"),
      /overlaps the built-in credential path/,
      `descendant of ${base}`,
    );
    const ancestor = base.split("/").slice(0, -1).join("/");
    if (ancestor) {
      assert.throws(
        () => parseToolDescriptor(withCredentialPaths([credentialDirectory(ancestor)]), "t.json"),
        /overlaps the built-in credential path/,
        `ancestor of ${base}`,
      );
    }
  }
  assert.doesNotThrow(() =>
    parseToolDescriptor(withCredentialPaths([credentialDirectory(".aws"), credentialDirectory(".acmecli")]), "t.json"),
  );
});

test("credentialPaths within one descriptor must be disjoint", () => {
  assert.throws(
    () =>
      parseToolDescriptor(withCredentialPaths([credentialDirectory(".acme"), credentialFile(".acme/token")]), "t.json"),
    /overlap — declare disjoint paths/,
  );
  assert.doesNotThrow(() =>
    parseToolDescriptor(withCredentialPaths([credentialDirectory(".acme"), credentialFile(".other/token")]), "t.json"),
  );
});

test("credentialPaths reject empty segments alongside traversal", () => {
  for (const bad of ["", "/abs", "~/home", "a/../b", "./a", "a//b", "a/"]) {
    assert.throws(
      () => parseToolDescriptor(withCredentialPaths([credentialFile(bad)]), "t.json"),
      /must be a \$HOME-relative path with no traversal/,
      JSON.stringify(bad),
    );
  }
});

const BROKERED_ACME = {
  id: "acme",
  install: { binary: "acmectl" },
  auth: {
    check: "acmectl me",
    reauth: "acmectl login",
    broker: {
      kind: "aws-role",
      roleArnEnv: "ACME_ROLE_ARN",
      region: "us-west-2",
      sessionActions: ["execute-api:Invoke"],
    },
  },
};

test("a layer installed after boot reaches the app that booted without one", () => {
  const built = buildApp(testConfig({ orgId: "acme" }));
  assert.equal(
    built.brokeredTools.length,
    0,
    "a deployment with no DEPLOYMENT_LAYER boots empty; the layer arrives over the API afterwards",
  );
  replaceDeploymentLayer(built.deploymentLayer, loadDeploymentLayer(layerDir({ acme: BROKERED_ACME })));
  assert.equal(
    built.brokeredTools.length,
    1,
    "credential vending reads this array; a copy taken at boot would stay empty forever",
  );
  assert.equal(built.brokeredTools[0]?.service, "acme");
});

test("replaceDeploymentLayer reaches every holder of the runtime arrays", () => {
  const runtime = emptyDeploymentLayer();
  const brokeredTools = runtime.brokeredTools;
  const commandRules = runtime.commandRules;
  replaceDeploymentLayer(
    runtime,
    loadDeploymentLayer(
      layerDir({
        acme: { ...BROKERED_ACME, approvals: [{ command: "delete", decision: "deny" }] },
      }),
    ),
  );
  assert.equal(brokeredTools.length, 1, "credential vending reads this array");
  assert.equal(brokeredTools[0]?.service, "acme");
  assert.equal(commandRules.length, 1, "the command policy reads this array, and already sees post-boot layers");
});
