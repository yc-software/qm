import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brokerGitHttp } from "../src/api/git-http-broker.ts";
import {
  CAPABILITY_TTL_MS,
  CREDENTIAL_BROKER_AUD,
  CONTROL_PLANE_AUD,
  mintCapabilityToken,
} from "../src/auth/capability-token.ts";
import type { BaseCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";

const SECRET = "git-http-broker-test";

const token = (credentials: string[], aud: string = CREDENTIAL_BROKER_AUD) =>
  mintCapabilityToken(
    { actorId: "U1", scopeId: "personal:U1", aud, credentials, exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );

function req(headers: Record<string, string>, body = ""): IncomingMessage {
  const r = Readable.from(body ? [body] : []) as IncomingMessage;
  r.headers = headers;
  return r;
}

function res(): ServerResponse & PassThrough & { capturedHeaders?: Record<string, string> } {
  const r = new PassThrough() as ServerResponse & PassThrough & { capturedHeaders?: Record<string, string> };
  let sent = false;
  Object.defineProperty(r, "headersSent", { get: () => sent });
  r.writeHead = ((statusCode: number, headers?: Record<string, string>) => {
    r.statusCode = statusCode;
    r.capturedHeaders = headers ?? {};
    sent = true;
    return r;
  }) as unknown as typeof r.writeHead;
  return r;
}

async function text(r: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  r.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
  await finished(r);
  return Buffer.concat(chunks).toString("utf8");
}

async function ctx(
  path: string,
  method: string,
  deps: ServerDeps,
  body = "",
): Promise<BaseCtx & { res: ReturnType<typeof res> }> {
  const url = new URL(path, "http://core.test");
  const out = res();
  return {
    req: req(
      {
        "x-agent-capability": await token(["gitlab"]),
        "content-type": "application/x-git-receive-pack-request",
        "git-protocol": "version=2",
      },
      body,
    ),
    res: out,
    app: { authorizesCapabilityScope: async () => true } as unknown as BaseCtx["app"],
    deps,
    secret: SECRET,
    auth: null,
    allowUnsignedSourceAuth: false,
    url,
    pathname: url.pathname,
    method,
    params: {},
  };
}

test("git HTTP broker streams a smart-HTTP request through the pinned service credential", async () => {
  let seen: { url: string; method: string; headers: Record<string, string>; body: string } | undefined;
  let authorized: unknown;
  const deps: ServerDeps = {
    control: {} as ServerDeps["control"],
    serviceCreds: {
      getServiceCredentialSecret: async () => ({
        slug: "gitlab",
        name: "GitLab git",
        secret: "dXNlcjp0b2tlbg==",
        host: "gitlab.example",
        injection: { scheme: "Basic " },
        allowedMethods: ["GET", "POST"],
        allowedPathPrefixes: ["/acme/repo.git"],
        enabled: true,
      }),
    } as unknown as ServerDeps["serviceCreds"],
    gitHttpFetch: async (url, init) => {
      const chunks: Buffer[] = [];
      if (init.body)
        for await (const chunk of init.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      seen = { url, method: init.method, headers: init.headers, body: Buffer.concat(chunks).toString("utf8") };
      return {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
        body: Readable.from(["0000"]),
      };
    },
  };
  const c = await ctx("/v1/credentials/git/gitlab/acme/repo.git/git-receive-pack", "POST", deps, "PACK");
  c.req.headers["x-agent-capability"] = await mintCapabilityToken(
    {
      actorId: "B-LEGACY",
      scopeId: "channel:C1",
      aud: CREDENTIAL_BROKER_AUD,
      credentials: ["gitlab"],
      botActor: true,
      liveActor: true,
      members: [{ id: "B-LEGACY", type: "internal" }],
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );
  c.app.authorizesCapabilityScope = async (claims) => {
    authorized = claims;
    return true;
  };
  await brokerGitHttp(c);

  assert.equal(await text(c.res), "0000");
  assert.equal(c.res.statusCode, 200);
  assert.deepEqual(authorized, {
    actorId: "B-LEGACY",
    scopeId: "channel:C1",
    botActor: true,
    liveActor: true,
    members: [{ id: "B-LEGACY", type: "internal" }],
  });
  assert.equal(c.res.capturedHeaders?.["content-type"], "application/x-git-receive-pack-result");
  assert.deepEqual(seen, {
    url: "https://gitlab.example/acme/repo.git/git-receive-pack",
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      "git-protocol": "version=2",
      Authorization: "Basic dXNlcjp0b2tlbg==",
    },
    body: "PACK",
  });
});

test("git HTTP broker rejects the wrong audience before contacting upstream", async () => {
  const deps: ServerDeps = {
    control: {} as ServerDeps["control"],
    serviceCreds: {
      getServiceCredentialSecret: async () => {
        throw new Error("must not fetch credential");
      },
    } as unknown as ServerDeps["serviceCreds"],
  };
  const c = await ctx("/v1/credentials/git/gitlab/acme/repo.git/info/refs", "GET", deps);
  c.req.headers["x-agent-capability"] = await token(["gitlab"], CONTROL_PLANE_AUD);
  await brokerGitHttp(c);

  assert.equal(c.res.statusCode, 403);
  assert.match(await text(c.res), /credential-broker/);
});

test("git HTTP broker rejects a token whose principal is no longer active", async () => {
  const deps: ServerDeps = {
    control: {} as ServerDeps["control"],
    identity: {
      refresh: async () => {},
      classify: () => ({ type: "offboarded" }),
    } as unknown as ServerDeps["identity"],
    serviceCreds: {
      getServiceCredentialSecret: async () => {
        throw new Error("must not fetch credential");
      },
    } as unknown as ServerDeps["serviceCreds"],
  };
  const c = await ctx("/v1/credentials/git/gitlab/acme/repo.git/info/refs", "GET", deps);
  await brokerGitHttp(c);

  assert.equal(c.res.statusCode, 401);
  assert.match(await text(c.res), /no longer active/);
});

test("git HTTP broker rejects a capability whose current scope membership was revoked", async () => {
  const deps: ServerDeps = {
    control: {} as ServerDeps["control"],
    serviceCreds: {
      getServiceCredentialSecret: async () => {
        throw new Error("must not fetch credential");
      },
    } as unknown as ServerDeps["serviceCreds"],
  };
  const c = await ctx("/v1/credentials/git/gitlab/acme/repo.git/info/refs", "GET", deps);
  c.app.authorizesCapabilityScope = async () => false;
  await brokerGitHttp(c);

  assert.equal(c.res.statusCode, 403);
  assert.match(await text(c.res), /membership has been revoked/);
});

test("git HTTP broker refuses an env-delivery record like a missing credential", async () => {
  let fetched = false;
  const deps: ServerDeps = {
    control: {} as ServerDeps["control"],
    serviceCreds: {
      getServiceCredentialSecret: async () => ({
        slug: "gitlab",
        name: "GitLab git",
        secret: "dXNlcjp0b2tlbg==",
        delivery: "env",
        envKey: "GITLAB_TOKEN",
        host: "gitlab.example",
        enabled: true,
      }),
    } as unknown as ServerDeps["serviceCreds"],
    gitHttpFetch: async () => {
      fetched = true;
      return { status: 200, headers: {}, body: Readable.from(["0000"]) };
    },
  };
  const c = await ctx("/v1/credentials/git/gitlab/acme/repo.git/info/refs?service=git-upload-pack", "GET", deps);
  await brokerGitHttp(c);
  assert.equal(c.res.statusCode, 404);
  assert.equal(fetched, false, "no upstream git fetch happens");
});

test("git HTTP broker refuses encoded parent traversal past the repo path", async () => {
  for (const path of [
    "/v1/credentials/git/gitlab/acme/repo.git/..%2fother-repo.git/info/refs",
    "/v1/credentials/git/gitlab/acme/repo.git/%2e%2e%2fother-repo.git/info/refs",
    "/v1/credentials/git/gitlab/acme/repo.git/%252e%252e%252fother/info/refs",
  ]) {
    let fetched = false;
    const deps: ServerDeps = {
      control: {} as ServerDeps["control"],
      serviceCreds: {
        getServiceCredentialSecret: async () => ({
          slug: "gitlab",
          name: "GitLab git",
          secret: "dXNlcjp0b2tlbg==",
          host: "gitlab.example",
          injection: { scheme: "Basic " },
          allowedMethods: ["GET", "POST"],
          allowedPathPrefixes: ["/acme/repo.git"],
          enabled: true,
        }),
      } as unknown as ServerDeps["serviceCreds"],
      gitHttpFetch: async () => {
        fetched = true;
        return { status: 200, headers: {}, body: Readable.from(["0000"]) };
      },
    };
    const c = await ctx(path, "GET", deps);
    await brokerGitHttp(c);
    assert.equal(c.res.statusCode, 403, path);
    assert.match(await text(c.res), /path_not_allowed/);
    assert.equal(fetched, false, "no upstream git fetch happens");
  }
});
