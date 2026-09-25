import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";
import {
  adminGrantEmails,
  mintSigningJwk,
  pendingSecrets,
  playbookFor,
  updateEnvContent,
  runSetup,
} from "../src/commands/setup.ts";
import { CliError } from "../src/log.ts";

function configFor(
  services: string[],
  extra = "",
  env = `{ "core": { "HARNESS": "pi" } }`,
): ReturnType<typeof loadConfigAt>["config"] {
  const dir = mkdtempSync(join(tmpdir(), "qm-setup-"));
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      `{
      "contract": 1, "orgId": "acme", "publicUrl": "http://localhost:8082", "target": "docker",
      "model": "claude-opus-4-8", "services": ${JSON.stringify(services)}, "plugins": [], "skills": [],
      "env": ${env}, "sandbox": { "app": "acme-sandboxes" }${extra}
    }`,
    );
    return loadConfigAt(join(dir, CONFIG_FILENAME)).config;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("pendingSecrets collects required deployment secrets and leaves optional integrations to Admin", () => {
  const config = configFor(["core", "slack", "web-ui"]);
  const env = new Map([
    ["ANTHROPIC_API_KEY", "sk-ant-real-value"],
    ["CORE_SIGNING_SECRET", "short"],
  ]);
  const { todo, done } = pendingSecrets(config, env);
  assert.deepEqual(
    done.map((s) => s.name),
    [],
  );
  const names = todo.map((s) => s.name);
  assert.ok(names.includes("CORE_SIGNING_SECRET"));
  assert.ok(!names.includes("ANTHROPIC_API_KEY"));
  assert.ok(!names.includes("SLACK_BOT_TOKEN"));
  assert.ok(!names.includes("SLACK_APP_TOKEN"));
  assert.ok(todo.every((secret) => secret.required));
});

test("pendingSecrets excludes terraform-managed secrets", () => {
  const config = configFor(["core"]);
  const { todo } = pendingSecrets(config, new Map());
  assert.ok(!todo.some((s) => s.managedBy !== "operator"));
});

test("pendingSecrets keeps a malformed administrator seed pending", () => {
  const config = configFor(
    ["core", "portal"],
    `,
      "secretEnv": { "core": { "ADMIN_GRANTS": "ADMIN_GRANTS" } }`,
  );
  assert.ok(
    pendingSecrets(config, new Map([["ADMIN_GRANTS", "admin@example.com"]])).todo.some(
      (secret) => secret.name === "ADMIN_GRANTS",
    ),
  );
  assert.ok(
    pendingSecrets(config, new Map([["ADMIN_GRANTS", "admin@example.com:org_admin"]])).done.some(
      (secret) => secret.name === "ADMIN_GRANTS",
    ),
  );
});

test("updateEnvContent replaces blank and commented lines in place and appends new names", () => {
  const before = [
    "# Anthropic key (core)",
    "ANTHROPIC_API_KEY=",
    "# SLACK_BOT_TOKEN=  # optional",
    "KEEP_ME=untouched",
    "",
  ].join("\n");
  const after = updateEnvContent(
    before,
    new Map([
      ["ANTHROPIC_API_KEY", "sk-ant-x"],
      ["SLACK_BOT_TOKEN", "xoxb-y"],
      ["BRAND_NEW", "z"],
    ]),
  );
  const lines = after.split("\n");
  assert.equal(lines[0], "# Anthropic key (core)");
  assert.equal(lines[1], "ANTHROPIC_API_KEY=sk-ant-x");
  assert.equal(lines[2], "SLACK_BOT_TOKEN=xoxb-y");
  assert.equal(lines[3], "KEEP_ME=untouched");
  assert.ok(after.includes("BRAND_NEW=z\n"));
});

test("updateEnvContent replaces an already-set value", () => {
  const after = updateEnvContent("A=old\nB=keep\n", new Map([["A", "new"]]));
  assert.equal(after, "A=new\nB=keep\n");
});

test("playbooks substitute the manifest names", () => {
  const config = configFor(["core"]);
  const slack = playbookFor("SLACK_BOT_TOKEN", config).join("\n");
  assert.ok(slack.includes("slack-app-manifest.yml"));
  const sso = playbookFor("OIDC_CLIENT_ID", config).join("\n");
  assert.ok(sso.includes(`${config.publicUrl}/auth/callback`));
  assert.doesNotMatch(sso, /Slack/);
  assert.match(playbookFor("ADMIN_GRANTS", config).join("\n"), /:org_admin/);
  assert.deepEqual(playbookFor("NO_SUCH_SECRET", config), []);
});

test("the sign-in allowlist derives from the administrator seed", () => {
  assert.equal(adminGrantEmails("admin@example.com:org_admin"), "admin@example.com");
  assert.equal(
    adminGrantEmails("admin@example.com:org_admin, ops@example.com:org_admin"),
    "admin@example.com,ops@example.com",
  );
  assert.equal(adminGrantEmails("U012345:org_admin"), "", "a Slack-style principal is not an email address");
  assert.equal(adminGrantEmails(undefined), "");
  assert.equal(adminGrantEmails(""), "");
});

test("the broker signing key is a fresh P-256 private JWK", () => {
  const first = JSON.parse(mintSigningJwk()) as Record<string, unknown>;
  assert.equal(first.kty, "EC");
  assert.equal(first.crv, "P-256");
  for (const field of ["d", "x", "y"]) assert.equal(typeof first[field], "string", field);
  assert.notEqual(mintSigningJwk(), JSON.stringify(first), "every deployment gets its own key");
});

test("the broker's operator secrets replace the external-IdP ones", () => {
  const external = configFor(["core", "web-ui", "admin", "portal"]);
  const externalNames = pendingSecrets(external, new Map()).todo.map((secret) => secret.name);
  assert.ok(externalNames.includes("OIDC_CLIENT_SECRET"));
  for (const name of ["AUTH_EMAIL_FROM", "RESEND_API_KEY"]) {
    assert.ok(!externalNames.includes(name), `${name} is core's optional invitation sender, never a setup prompt`);
  }

  const broker = configFor(
    ["core", "web-ui", "admin", "portal", "auth"],
    "",
    `{ "core": { "HARNESS": "pi" }, "auth": { "AUTH_EMAIL_TRANSPORT": "resend" } }`,
  );
  const brokerNames = pendingSecrets(broker, new Map()).todo.map((secret) => secret.name);
  assert.ok(!brokerNames.includes("OIDC_CLIENT_SECRET"), "the broker mints the portal's client secret");
  assert.ok(!brokerNames.includes("OIDC_CLIENT_ID"));
  assert.ok(!brokerNames.includes("PORTAL_EXPECTED_TEAM_ID"));
  for (const name of ["AUTH_ALLOWED_EMAILS", "AUTH_SIGNING_JWK", "AUTH_TOKEN_SECRET", "AUTH_CLIENT_SECRET"]) {
    assert.ok(brokerNames.includes(name), `broker mode should collect ${name}`);
  }
  for (const name of ["AUTH_EMAIL_FROM", "RESEND_API_KEY"]) {
    assert.ok(!brokerNames.includes(name), "email setup can be deferred");
    assert.ok(pendingSecrets(broker, new Map(), true).todo.some((secret) => secret.name === name));
  }
  assert.match(playbookFor("AUTH_EMAIL_FROM", broker).join("\n"), /verified sender/);
  assert.match(playbookFor("OIDC_CLIENT_ID", broker).join("\n"), /external identity provider/);
});

test("runSetup refuses to run without a TTY", async () => {
  await assert.rejects(
    () => runSetup({ dir: tmpdir() }),
    (e: unknown) => {
      assert.ok(e instanceof CliError);
      assert.match((e as Error).message, /interactive/);
      return true;
    },
  );
});

test("email setup uses declared secret names and does not reprompt for direct config values", () => {
  const aliased = configFor(
    ["core", "web-ui", "admin", "portal", "auth"],
    `, "secretEnv": { "auth": { "AUTH_EMAIL_FROM": "AUTH_SENDER", "RESEND_API_KEY": "MAIL_KEY" } }`,
    `{ "auth": { "AUTH_EMAIL_TRANSPORT": "resend" } }`,
  );
  const waiting = pendingSecrets(aliased, new Map(), true).todo.map((secret) => secret.name);
  assert.ok(waiting.includes("AUTH_SENDER"));
  assert.ok(waiting.includes("MAIL_KEY"));
  assert.ok(!waiting.includes("AUTH_EMAIL_FROM"));
  assert.ok(!waiting.includes("RESEND_API_KEY"));
  const supplied = pendingSecrets(
    aliased,
    new Map([
      ["AUTH_SENDER", "noreply@example.com"],
      ["MAIL_KEY", "re_configured"],
    ]),
    true,
  );
  assert.ok(supplied.done.some((secret) => secret.name === "AUTH_SENDER"));
  assert.ok(supplied.done.some((secret) => secret.name === "MAIL_KEY"));
  const direct = {
    ...aliased,
    secretEnv: undefined,
    env: { auth: { AUTH_EMAIL_TRANSPORT: "resend", AUTH_EMAIL_FROM: "noreply@example.com" } },
  };
  assert.ok(!pendingSecrets(direct, new Map(), true).todo.some((secret) => secret.name === "AUTH_EMAIL_FROM"));
});
