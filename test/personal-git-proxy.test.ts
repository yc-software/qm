import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { buildApp, signedConfig } from "./support/orchestrator-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { credentialHandle } from "../src/credentials/keychain.ts";
import { verifyCapabilityToken, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { brokerGitHttp } from "../src/api/git-http-broker.ts";
import type { BaseCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";

const actor = { externalId: "U1" };

async function setup() {
  const built = buildApp(signedConfig());
  await selectDefaultSandbox(built, "U1", scopeId("personal", "U1"));
  const github = await built.keychain!.save({
    ownerId: "U1",
    service: "github",
    secret: "ghp-owner-token",
    envKey: "GITHUB_TOKEN",
  });
  const openai = await built.keychain!.save({ ownerId: "U1", service: "openai", secret: "sk-owner" });
  const seen: Array<Record<string, string>> = [];
  const run = built.sandbox.run.bind(built.sandbox);
  built.sandbox.run = (handle, command, opts) => {
    if (command === "echo git") seen.push({ ...handle.env });
    return run(handle, command, opts);
  };
  const execute = async (handle: string) => {
    seen.length = 0;
    const res = await built.app.turn({
      surface: "test",
      actor,
      conversation: { kind: "dm", threadRef: "dm:U1:git" },
      text: `!execute ${JSON.stringify({ command: "echo git", credentials: [handle] })}`,
    } as TurnRequest);
    assert.equal(res.status, "ok", res.reason);
    assert.equal(seen.length, 1);
    return seen[0]!;
  };
  return { built, github: credentialHandle(github), openai: credentialHandle(openai), execute };
}

async function call(path: string, claims: CapabilityClaims, deps: ServerDeps) {
  const url = new URL(path, "http://core.test");
  const req = Object.assign(Readable.from([]), { headers: { "git-protocol": "version=2" } });
  const res = Object.assign(new PassThrough(), { getHeader: () => undefined, statusCode: 0 });
  Object.assign(res, { writeHead: (status: number) => Object.assign(res, { statusCode: status }) });
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  await brokerGitHttp({
    req,
    res,
    deps,
    url,
    pathname: url.pathname,
    method: "GET",
    capability: claims,
  } as unknown as BaseCtx);
  await finished(res);
  return { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") };
}

test("a personal GitHub handle reaches github.com through the git proxy for its owner only", async () => {
  const { built, github, openai, execute } = await setup();
  assert.equal((await execute(openai)).AGENT_CREDENTIAL_TOKEN, undefined);
  const env = await execute(github);
  assert.equal(env.GITHUB_TOKEN, "ghp-owner-token");
  const claims = (await verifyCapabilityToken(env.AGENT_CREDENTIAL_TOKEN!, TEST_CAPABILITY_SECRET))!;
  assert.deepEqual(claims.credentials, [github]);
  const fetched: Array<{ url: string; headers: Record<string, string> }> = [];
  const deps = {
    keychain: built.keychain,
    gitHttpFetch: async (url: string, init: { headers: Record<string, string> }) => {
      fetched.push({ url, headers: init.headers });
      return { status: 200, headers: {}, body: Readable.from(["0000"]) };
    },
  } as unknown as ServerDeps;
  const path = `/v1/credentials/git/${github}/acme/repo.git/info/refs?service=git-upload-pack`;
  const status = async (c: CapabilityClaims) => (await call(path, c, deps)).status;
  assert.deepEqual(
    {
      otherPerson: await status({ ...claims, actorId: "U2", scopeId: scopeId("personal", "U2") }),
      notNamed: await status({ ...claims, credentials: [] }),
      publishedApp: await status({ ...claims, deployment: "app-1" } as CapabilityClaims),
    },
    { otherPerson: 404, notNamed: 403, publishedApp: 403 },
  );
  assert.deepEqual(await call(path, claims, deps), { status: 200, body: "0000" });
  assert.deepEqual(fetched, [
    {
      url: "https://github.com/acme/repo.git/info/refs?service=git-upload-pack",
      headers: {
        "git-protocol": "version=2",
        Authorization: `Basic ${Buffer.from("x-access-token:ghp-owner-token").toString("base64")}`,
      },
    },
  ]);
});
