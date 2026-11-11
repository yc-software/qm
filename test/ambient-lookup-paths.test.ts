import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import { brokerCredentialCall } from "../src/api/credential-broker.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { settle } from "./support/settle.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

test("a reply asking the assistant runs as the person who asked, and the broker attests that person's lookup", async (t) => {
  const built = buildApp(
    testConfig({ signingSecret: "ambient-lookup-signing".repeat(3), apiBaseUrl: "http://core.internal" }),
  );
  built.runtime.start();
  t.after(() => built.runtime.stop());
  const org = scopeId("org", "default-org");
  const here = scopeId("channel", "C-deals");
  await built.serviceCreds.setServiceCredential(org, {
    slug: "lookup",
    name: "lookup",
    secret: "synthetic",
    host: "api.lookup.example",
    injection: { actor: true, audience: "any" },
  });
  await built.acl.grant(tenant, {
    ownerScopeId: org,
    ref: encodeRef(serviceCredRef("lookup")),
    granteeScopeId: org,
    permission: "read",
    grantedBy: "admin@default-org",
  });
  await built.directory.replace([{ principalId: "a@x.com", displayName: "A", type: "internal", slackId: "U-A" }]);
  await built.directory.replaceChannels(
    [{ channelId: "C-deals", name: "deals", isPrivate: true }],
    [{ channelId: "C-deals", principalId: "a@x.com" }],
  );
  await selectDefaultSandbox(built, "a@x.com", here);
  const tokens = new Map<string, string>();
  const realRun = built.sandbox.run.bind(built.sandbox);
  built.sandbox.run = (handle, command, opts) => {
    const tag = /^echo (lookup)$/.exec(command)?.[1];
    if (tag && handle.env?.AGENT_CREDENTIAL_TOKEN) tokens.set(tag, handle.env.AGENT_CREDENTIAL_TOKEN);
    return realRun(handle, command, opts);
  };
  const exec = (tag: string) => `!execute ${JSON.stringify({ command: `echo ${tag}`, credentials: ["lookup"] })}`;
  const sent: Array<Record<string, string>> = [];
  const lookup = async (tag: string) => {
    const claims = (await verifyCapabilityToken(tokens.get(tag)!, TEST_CAPABILITY_SECRET))!;
    const res = await brokerCredentialCall({
      tenant,
      claims,
      body: { credential: "lookup", url: "https://api.lookup.example/memos?company=1" },
      orgScopeId: org,
      reader: built.serviceCreds,
      fetchImpl: async (_url, init) => {
        sent.push(init.headers);
        return { status: 200, text: async () => "{}" };
      },
    });
    return { claims, status: res.status, error: (res.json as { error?: string }).error };
  };
  const ranFor = async (ts: string) => {
    let run: any;
    await settle(async () => {
      run = (await built.runs.list()).find((r) => r.sessionId === `slack:C-deals:ambient:${ts}`);
      return !!run;
    });
    return built.runs.waitFor(run.id, 30_000);
  };

  await built.app.setChannelPolicy("C-deals", "!engage-asked", "U-admin");
  await built.app.ingestSurfaceEvents([
    { container: "C-deals", ts: "2.1", authorId: "U-A", authorName: "A", text: exec("lookup"), createdAt: 2 },
  ]);
  const asked = await ranFor("2.1");
  assert.deepEqual([asked.request.actor.id, asked.request.origin.kind], ["a@x.com", "human"]);
  const answered = await lookup("lookup");
  assert.deepEqual(
    [answered.claims.actorId, answered.claims.actAsActor, answered.claims.audienceScopeId],
    ["a@x.com", true, here],
  );
  assert.deepEqual([answered.status, answered.error], [200, undefined]);
  assert.deepEqual(
    sent.map((h) => h["x-qm-actor"]),
    ["a@x.com"],
  );
});
