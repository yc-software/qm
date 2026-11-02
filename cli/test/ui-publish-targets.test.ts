import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfigAt } from "../src/config.ts";
import { runUiPublish } from "../src/commands/ui.ts";
import { dockerScaffold, flyScaffold, renderScaffold } from "../src/provider-scaffold.ts";

function scaffolded(t: TestContext, text: string) {
  const dir = mkdtempSync(join(tmpdir(), "qm-ui-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "qm.config.jsonc");
  writeFileSync(path, text);
  return loadConfigAt(path).config;
}

test("qm ui publish sends Render and data-directory docker deployments to qm up", (t) => {
  const render = scaffolded(
    t,
    renderScaffold.renderConfig("acme", "anthropic", "resend", { repo: "https://github.com/acme/qm", branch: "main" }),
  );
  assert.throws(() => runUiPublish(render, { dir: "dist-web" }), /credentials for the deployment's MinIO.*`qm up`/);
  const docker = scaffolded(t, dockerScaffold.renderConfig("acme", "anthropic", "resend"));
  assert.throws(() => runUiPublish(docker, { dir: "dist-web" }), /serves the web UI from its data directory.*`qm up`/);
});

test("qm ui publish on Fly refuses to guess AWS S3 for the deployment's Tigris bucket", (t) => {
  const fly = scaffolded(t, flyScaffold.renderConfig("acme", "anthropic", "resend"));
  const prior = process.env.AWS_ENDPOINT_URL_S3;
  delete process.env.AWS_ENDPOINT_URL_S3;
  t.after(() => {
    if (prior !== undefined) process.env.AWS_ENDPOINT_URL_S3 = prior;
  });
  assert.throws(
    () => runUiPublish(fly, { dir: "dist-web" }),
    /keeps acme-data in Tigris, not AWS S3: export AWS_ENDPOINT_URL_S3=https:\/\/fly\.storage\.tigris\.dev/,
  );
});
