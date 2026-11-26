import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companyTest } from "./support/app-handle.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { personalScope } from "../src/types.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { testDeployBackings } from "./support/test-database.ts";

companyTest("inviting by email to a published app sends through the configured Resend mailer", async (t) => {
  const sent: { to: string[]; from: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== "https://api.resend.com/emails") return realFetch(input, init);
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "email-1" });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const backings = testDeployBackings();
  const config = testConfig({
    databaseUrl: backings.databaseUrl,
    dataDir: mkdtempSync(join(tmpdir(), "app-invite-email-")),
  });
  const built = buildApp({
    ...config,
    resendApiKey: "re_test",
    emailFrom: "Apps <apps@example.com>",
    awsDeploy: { ...config.awsDeploy, appsDomain: "apps.example.com" },
  });
  await built.app.upsertDirectory([{ principalId: "invitee@example.com", displayName: "Invitee", type: "internal" }]);
  const owner = { ownerScopeId: personalScope("U1"), createdBy: "U1" };
  const app = await createDeployStore(backings).create({ ...owner, name: "status", entrypoint: "x" });
  const result = await built.app.inviteToApp(app.id, "Invitee@Example.com", owner);
  assert.deepEqual(result.invitation, { emailSent: true, appUrl: "https://acme1-status.apps.example.com/" });
  assert.deepEqual(
    sent.map((m) => [m.to, m.from]),
    [[["invitee@example.com"], "Apps <apps@example.com>"]],
  );
});
