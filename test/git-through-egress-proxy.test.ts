import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEgressAuthzServer } from "../src/egress-authz-main.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import { forceThroughProxyEnv } from "../src/sandbox/sandbox-env.ts";
import { scopeId } from "../src/types.ts";

// The regression this pins: git's default http.proxyAuthMethod ("anyauth") may withhold the
// proxy credential until the proxy answers 407 + Proxy-Authenticate. A proxy that answers a
// bare 403 strands git ("CONNECT tunnel failed, response 403") while curl — preemptive Basic —
// works. The egress stack must (a) challenge with 407 and (b) hand git an env that sends Basic
// preemptively. Both are exercised here through a front proxy wired to the real authz server
// exactly like the Envoy Lua filter.

const SECRET = "git-proxy-test-secret";
const listen = (s: Server): Promise<number> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));
const sh = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    execFile(cmd, args, { ...opts, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code as number) || 1 : 0, out: `${stdout}\n${stderr}` }),
    );
  });

function frontProxy(authzPort: number, targetPort: number): Server {
  // Minimal stand-in for deploy/egress-proxy/envoy.yaml: consult the authz service per request,
  // mirror 407 challenges, forward allowed absolute-form HTTP to the target.
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://invalid.test");
    const authority = url.host || req.headers.host || "";
    const checkHeaders: Record<string, string> = {
      "x-egress-authority": authority,
      "x-egress-scheme": "http",
    };
    if (req.headers["proxy-authorization"]) {
      checkHeaders["proxy-authorization"] = req.headers["proxy-authorization"] as string;
    }
    const check = request({ port: authzPort, host: "127.0.0.1", path: "/check", headers: checkHeaders }, (cr) => {
      cr.resume();
      if (cr.statusCode !== 200) {
        const headers: Record<string, string> = {};
        if (cr.statusCode === 407 && cr.headers["proxy-authenticate"]) {
          headers["proxy-authenticate"] = cr.headers["proxy-authenticate"] as string;
        }
        res.writeHead(cr.statusCode === 407 ? 407 : 403, headers).end();
        req.resume();
        return;
      }
      const fwd = request(
        {
          port: targetPort,
          host: "127.0.0.1",
          path: url.pathname + url.search,
          method: req.method,
          headers: { host: authority },
        },
        (tr) => {
          res.writeHead(tr.statusCode ?? 502, tr.headers);
          tr.pipe(res);
        },
      );
      fwd.on("error", () => res.writeHead(502).end());
      req.pipe(fwd);
    });
    check.on("error", () => res.writeHead(403).end());
    check.end();
  });
}

function dumbGitTarget(repoDir: string): Server {
  return createServer((req, res) => {
    const path = join(repoDir, new URL(req.url ?? "/", "http://x").pathname.replace(/^\/repo\.git/, ""));
    if (existsSync(path) && statSync(path).isFile()) res.end(readFileSync(path));
    else {
      res.statusCode = 404;
      res.end();
    }
  });
}

async function boot() {
  const authz = buildEgressAuthzServer({
    capabilitySecret: SECRET,
    audit: { record: () => {} },
    lookup: async () => ["93.184.216.34"],
  });
  const authzPort = await listen(authz);
  const dir = mkdtempSync(join(tmpdir(), "git-proxy-"));
  const repo = join(dir, "repo.git");
  const src = join(dir, "src");
  assert.equal((await sh("git", ["init", "-q", "--bare", repo])).code, 0);
  assert.equal((await sh("git", ["init", "-q", src])).code, 0);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  await sh(
    "bash",
    [
      "-c",
      `echo hello > file.txt && git add . && git commit -qm x && git push -q ${JSON.stringify(repo)} HEAD:refs/heads/main`,
    ],
    { cwd: src, env: gitEnv },
  );
  assert.equal((await sh("git", ["-C", repo, "update-server-info"])).code, 0);
  assert.equal((await sh("git", ["-C", repo, "symbolic-ref", "HEAD", "refs/heads/main"])).code, 0);
  const target = dumbGitTarget(repo);
  const targetPort = await listen(target);
  const front = frontProxy(authzPort, targetPort);
  const frontPort = await listen(front);
  const token = await mintCapabilityToken(
    {
      actorId: "U_git",
      scopeId: scopeId("personal", "U_git"),
      aud: EGRESS_PROXY_AUD,
      exp: Date.now() + 60_000,
      egress: { allowedHosts: [], deniedHosts: [] },
    },
    SECRET,
  );
  return { authz, target, front, frontPort, token, dir };
}

test("challenge-based proxy auth (git anyauth wire sequence): 407 + Proxy-Authenticate, then Basic succeeds", async () => {
  const b = await boot();
  try {
    const get = (headers: Record<string, string>) =>
      new Promise<{ status: number; challenge?: string }>((resolve, reject) => {
        const r = request(
          {
            port: b.frontPort,
            host: "127.0.0.1",
            path: "http://gitrepo.test:80/repo.git/HEAD",
            headers: { host: "gitrepo.test", ...headers },
          },
          (res) => {
            res.resume();
            resolve({
              status: res.statusCode ?? 0,
              challenge: res.headers["proxy-authenticate"] as string | undefined,
            });
          },
        );
        r.on("error", reject);
        r.end();
      });
    // 1. No credential yet — exactly what git anyauth sends first. Must be challenged, not 403'd.
    const first = await get({});
    assert.equal(first.status, 407);
    assert.equal(first.challenge, 'Basic realm="egress"');
    // 2. Retry with Basic, as libcurl does after the challenge.
    const basic = Buffer.from(`x:${b.token}`).toString("base64");
    const second = await get({ "proxy-authorization": `Basic ${basic}` });
    assert.equal(second.status, 200);
  } finally {
    await close(b.front);
    await close(b.target);
    await close(b.authz);
  }
});

test("git clone through the authz-gated proxy with forceThroughProxyEnv succeeds", async (t) => {
  if ((await sh("git", ["--version"])).code !== 0) return t.skip("git unavailable");
  const b = await boot();
  try {
    const dest = join(b.dir, "clone");
    const proxyEnv = forceThroughProxyEnv(`http://127.0.0.1:${b.frontPort}`, b.token);
    // Sanity: the env we hand sandboxes must force preemptive Basic for git.
    assert.equal(proxyEnv.GIT_HTTP_PROXY_AUTHMETHOD, "basic");
    const res = await sh("git", ["clone", "-q", "http://gitrepo.test/repo.git", dest], {
      env: { ...process.env, ...proxyEnv, GIT_TERMINAL_PROMPT: "0" },
    });
    assert.equal(res.code, 0, `git clone failed: ${res.out}`);
    assert.equal(readFileSync(join(dest, "file.txt"), "utf8").trim(), "hello");
  } finally {
    await close(b.front);
    await close(b.target);
    await close(b.authz);
  }
});
