import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfigAt } from "../src/config.ts";
import { runUiPublish } from "../src/commands/ui.ts";
import { dockerScaffold, renderScaffold } from "../src/provider-scaffold.ts";

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
