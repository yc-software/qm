import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp, signedConfig } from "./support/orchestrator-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { credentialHandle, renderKeychainManifest } from "../src/credentials/keychain.ts";
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

function call(path: string, claims: CapabilityClaims, deps: ServerDeps) {
  const url = new URL(path, "http://core.test");
  const req = Readable.from([]) as IncomingMessage;
  req.headers = { "git-protocol": "version=2" };
  const out = new PassThrough() as ServerResponse & PassThrough;
  out.getHeader = () => undefined;
  out.writeHead = ((status: number) => {
    out.statusCode = status;
    return out;
  }) as unknown as typeof out.writeHead;
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ctx = {
    req,
    res: out,
    app: {} as BaseCtx["app"],
    deps,
    secret: "s",
    auth: null,
    allowUnsignedSourceAuth: false,
    url,
    pathname: url.pathname,
    method: "GET",
    params: {},
    capability: claims,
  } as BaseCtx;
  return {
    run: async () => {
      await brokerGitHttp(ctx);
      await finished(out);
      return { status: out.statusCode, body: Buffer.concat(chunks).toString("utf8") };
    },
  };
}

test("a personal GitHub handle reaches its host through the git proxy without a token in the URL", async () => {
  const { built, github, execute } = await setup();
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
  assert.deepEqual(await call(path, claims, deps).run(), { status: 200, body: "0000" });
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

test("the git proxy never serves one person's handle to another person, even when named in their token", async () => {
  const { built, github, execute } = await setup();
  const claims = (await verifyCapabilityToken(
    (await execute(github)).AGENT_CREDENTIAL_TOKEN!,
    TEST_CAPABILITY_SECRET,
  ))!;
  let fetched = 0;
  const deps = {
    keychain: built.keychain,
    gitHttpFetch: async () => {
      fetched++;
      return { status: 200, headers: {}, body: Readable.from(["0000"]) };
    },
  } as unknown as ServerDeps;
  const path = `/v1/credentials/git/${github}/acme/repo.git/info/refs`;
  const results = {
    otherPerson: (await call(path, { ...claims, actorId: "U2", scopeId: scopeId("personal", "U2") }, deps).run())
      .status,
    notNamed: (await call(path, { ...claims, credentials: [] }, deps).run()).status,
    publishedApp: (await call(path, { ...claims, deployment: "app-1" } as CapabilityClaims, deps).run()).status,
  };
  assert.deepEqual(results, { otherPerson: 404, notNamed: 403, publishedApp: 403 });
  assert.equal(fetched, 0);
});

test("a personal credential without a git host gets no git proxy token or proxy note", async () => {
  const { built, openai, execute } = await setup();
  const env = await execute(openai);
  assert.equal(env.OPENAI_TOKEN, "sk-owner");
  assert.equal(env.AGENT_CREDENTIAL_TOKEN, undefined);
  const owned = await built.keychain!.listByOwner("U1");
  const manifest = renderKeychainManifest({
    scopeId: scopeId("personal", "U1"),
    conversationKind: "dm",
    actorId: "U1",
    members: [{ id: "U1" }],
    entriesByOwner: new Map([["U1", owned]]),
    scopeGrants: [],
    execution: owned.map((c) => ({ handle: credentialHandle(c), ownerId: "U1", credentialId: c.id, description: "" })),
  });
  assert.match(manifest, /— github; env `GITHUB_TOKEN`; git proxy github\.com$/m);
  assert.match(manifest, /— openai; env `OPENAI_TOKEN`$/m);
});
