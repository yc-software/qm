import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { buildApp } from "../src/wiring.ts";
import { scopeId } from "../src/types.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function filesAt(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => !["coverage", "dist", "node_modules"].includes(name))
    .flatMap((name) => filesAt(join(path, name)));
}

test("retired subsystems stay deleted while Keychain, connectors and the live surfaces remain", () => {
  for (const path of [
    "plugins/wallet",
    "plugins/vault",
    "plugins/link",
    "deploy/vault",
    "electron",
    "skills-seed/claude-design",
    "skills-seed/connect-credentials",
    "skills-seed/custom-emoji",
    "skills-seed/design-md",
    "skills-seed/setup-openclaw",
    "skills-seed/slack-gif-creator",
    "skills-seed/x",
    "src/credentials/credential-fs.ts",
    "src/credentials/vault.ts",
    "src/credentials/wallet-pairing.ts",
    "src/external-agents",
    "src/api/routes/external-agents.ts",
    "src/credentials/vault.ts",
    ".github/workflows/publish-images.yml",
    "scripts/prepare-release-manifest.mjs",
    "cli/scripts/verify-release-manifest.mjs",
    "skills-seed/connect-credentials",
    "src/credentials/credential-fs.ts",
    "src/credentials/wallet-pairing.ts",
    "test/credential-capability-routes.test.ts",
    "test/wallet-pairing.test.ts",
    "src/webhooks",
    "src/api/routes/webhooks.ts",
    "src/gmail",
    "src/api/routes/gmail.ts",
    "plugins/web-ui/src/webhooks.ts",
    "scripts/setup-gmail-pubsub.sh",
    "docs/gmail-pubsub-setup.md",
    "test/webhook-receiver.test.ts",
    "test/webhook-routes.test.ts",
    "test/webhook-store.test.ts",
    "test/webhook-verifiers.test.ts",
    "test/web-ui-webhooks.test.ts",
    "test/gmail-client.test.ts",
    "test/gmail-filter.test.ts",
    "test/gmail-oidc.test.ts",
    "test/gmail-watch.test.ts",
    "src/insights/grader-queue.ts",
    "src/insights/grader-ignore.ts",
    "test/grader-queue.test.ts",
  ]) {
    assert.equal(existsSync(join(root, path)), false, `${path} must stay deleted`);
  }
  for (const path of [
    "src/credentials/connector-token.ts",
    "src/credentials/keychain.ts",
    "src/connectors/oauth.ts",
    "src/runs/session-state-bus.ts",
    "plugins/onboarding/skills",
    ".github/workflows/release-package.yml",
    "test/live-slack",
  ]) {
    assert.equal(existsSync(join(root, path)), true, `${path} must survive`);
  }
});

test("active source and public documentation do not expose retired credential features", () => {
  const paths = [
    ".github",
    ".gitignore",
    "README.md",
    "cli",
    "deploy",
    "fly",
    "knip.json",
    "package-lock.json",
    "package.json",
    "plugins",
    "scripts",
    "skills-seed",
    "src",
    "test",
  ]
    .flatMap((path) => filesAt(join(root, path)))
    .filter((path) => {
      const rel = relative(root, path);
      return (
        rel !== "test/removed-features.test.ts" &&
        rel !== "test/release-workflows.test.ts" &&
        !rel.startsWith("deploy/layers/")
      );
    });
  const forbidden = [
    ["/v1", "/wallet/"].join(""),
    ["WALLET", "_BOOTSTRAP_AUD"].join(""),
    ["plugins", "/wallet"].join(""),
    ["connect", "-credentials"].join(""),
    ["@qm/credential", "-wallet"].join(""),
    ["credential", " wallet"].join(""),
    ["wallet", " pair"].join(""),
    ["wallet", "-bootstrap"].join(""),
    ["wallet", "pairing"].join(""),
    ["wallet", "_pairing"].join(""),
    ["wallet", " plugin"].join(""),
    ["oauth", " wallet"].join(""),
    ["credential", "-fs"].join(""),
    ["credentials", ".env"].join(""),
    ["cred", "-inbox"].join(""),
    ["src", "/webhooks"].join(""),
    ["webhook", "-receiver"].join(""),
    ["webhook", "-store"].join(""),
    ["webhook", "-verifiers"].join(""),
    ["gmail", "-pubsub"].join(""),
    ["gmail", "-watch"].join(""),
    ["setup", "-gmail-pubsub"].join(""),
    ["gmail", "/watches"].join(""),
    ["qm", "-link"].join(""),
    ["qm", "_link"].join(""),
    ["external", "-agents"].join(""),
    ["external", "_agents"].join(""),
    ["setup", "-openclaw"].join(""),
    ["personal ", "openclaw"].join(""),
    ["claude", "-design"].join(""),
    ["design", "-md"].join(""),
    ["custom", "-emoji"].join(""),
    ["slack", "-gif-creator"].join(""),
    ["aws", "-cli/SKILL"].join(""),
    ["plugins", "/vault"].join(""),
    ["deploy", "/vault"].join(""),
    ["vault", " plugin"].join(""),
    ["connect", "-1password"].join(""),
    ["VAULT", "_BIND"].join(""),
    ["plugins", "/link"].join(""),
    ["electron", "/main.js"].join(""),
    ["electron", "/package.json"].join(""),
    ["publish", "-images"].join(""),
    ["prepare", "-release-manifest"].join(""),
    ["verify", "-release-manifest"].join(""),
    ["prepublish", "Only"].join(""),
  ].map((value) => value.toLowerCase());
  const matches = paths.flatMap((path) => {
    const source = readFileSync(path, "utf8").toLowerCase();
    return forbidden.filter((value) => source.includes(value)).map((value) => `${relative(root, path)}: ${value}`);
  });
  assert.deepEqual(matches, []);
});

test("stale Wallet state cannot override or resurrect Keychain credentials", async () => {
  const built = buildApp(testConfig());
  const actor = { externalId: "U1" };
  const personal = scopeId("personal", actor.externalId);
  await built.workspace.write(personal, ".config/agent/credentials.env", "export TEST_API_TOKEN='wallet-stale'\n");
  const initial = await built.keychain!.save({
    ownerId: actor.externalId,
    service: "test-api",
    secret: "keychain-initial",
    envKey: "TEST_API_TOKEN",
  });
  const run = (threadRef: string) =>
    built.app.turn({
      surface: "test",
      actor,
      conversation: { kind: "dm", threadRef },
      text: "!run printf '%s' \"${TEST_API_TOKEN-unset}\"",
    });

  const initialTurn = await run("dm:U1:initial");
  assert.equal(initialTurn.status, "ok", initialTurn.reason);
  assert.equal(initialTurn.reply, "keychain-initial");
  const rotated = await built.keychain!.save({
    ownerId: actor.externalId,
    service: "test-api",
    secret: "keychain-rotated",
    envKey: "TEST_API_TOKEN",
  });
  assert.equal(rotated.id, initial.id);
  const rotatedTurn = await run("dm:U1:rotated");
  assert.equal(rotatedTurn.status, "ok", rotatedTurn.reason);
  assert.equal(rotatedTurn.reply, "keychain-rotated");
  assert.equal(await built.keychain!.remove(actor.externalId, initial.id), true);
  const deletedTurn = await run("dm:U1:deleted");
  assert.equal(deletedTurn.status, "ok", deletedTurn.reason);
  assert.equal(deletedTurn.reply, "unset");
});

test("retired Wallet, webhook and Gmail-watch endpoints return not found", async () => {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    for (const [method, path] of [
      ["POST", "/v1/wallet/pair/start"],
      ["POST", "/v1/credentials/bootstrap"],
      ["POST", "/v1/credentials/revoke"],
      ["GET", "/v1/credentials"],
      ["POST", "/v1/keychain/import"],
      ["POST", "/v1/webhooks"],
      ["GET", "/v1/webhooks"],
      ["POST", "/v1/connectors/google/gmail/watches"],
      ["GET", "/v1/connectors/google/gmail/watches"],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an unexpired Wallet capability cannot enter a surviving API", async () => {
  const built = buildApp(testConfig());
  const server = createServer(built.app, {
    signingSecret: "retired-feature-ingress-secret-at-least-32-characters",
    capabilitySecret: TEST_CAPABILITY_SECRET,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const token = await mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: scopeId("personal", "U1"),
        aud: ["wallet", "-bootstrap"].join(""),
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      TEST_CAPABILITY_SECRET,
    );
    const response = await fetch(`${base}/v1/keychain/overview`, {
      headers: { "x-agent-capability": token },
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /audience not valid/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
