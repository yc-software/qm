import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const coreUrl = process.env.AUTH_INTEGRATION_CORE_URL;
const coreSecret = process.env.AUTH_INTEGRATION_CORE_SIGNING_SECRET;
const root = fileURLToPath(new URL("../../..", import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

function cookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
  assert(value, `${name} cookie missing`);
  return value.split(";")[0]!;
}

async function requestToken(response: Response): Promise<string> {
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /type="password"/);
  const token = /name="request" value="([^"]+)"/.exec(html)?.[1];
  assert(token, "authorization form missing request token");
  return token;
}

test(
  "password login through real portal, broker, core, and PostgreSQL",
  {
    skip: !coreUrl || !coreSecret ? "set AUTH_INTEGRATION_CORE_URL and AUTH_INTEGRATION_CORE_SIGNING_SECRET" : false,
    timeout: 60_000,
  },
  async (t) => {
    const [authPort, portalPort, adminPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const authUrl = `http://127.0.0.1:${authPort}`;
    const portalUrl = `http://127.0.0.1:${portalPort}`;
    const adminEmail = process.env.AUTH_INTEGRATION_ADMIN_EMAIL ?? "admin@example.com";
    const rateEmail = "rate-limit@example.com";
    const deniedEmail = "denied@example.com";
    const externalEmail = "external-password-qa@example.test";
    const password = "Local integration password only";
    const salt = randomBytes(16);
    const hash = `scrypt$32768$8$3$${salt.toString("base64url")}$${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString("base64url")}`;
    const secret = (): string => randomBytes(32).toString("base64url");
    const clientSecret = secret();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      CORE_API_URL: coreUrl,
      CORE_SIGNING_SECRET: coreSecret,
      CORE_ORG_ID: process.env.AUTH_INTEGRATION_ORG_ID ?? "acme",
      PORTAL_SESSION_SECRET: secret(),
      PORTAL_PUBLIC_URL: portalUrl,
      PORTAL_LOCAL_AUTH_BYPASS: "0",
      ADMIN_UPSTREAM: `http://127.0.0.1:${adminPort}`,
      ADMIN_BASE_PATH: "/admin",
      AUTH_BROKER_UPSTREAM: authUrl,
      AUTH_ISSUER: `${portalUrl}/idp`,
      AUTH_CLIENT_ID: "password-integration",
      AUTH_CLIENT_SECRET: clientSecret,
      AUTH_TOKEN_SECRET: secret(),
      AUTH_REDIRECT_URI: `${portalUrl}/auth/callback`,
      AUTH_SIGNING_JWK: JSON.stringify(
        generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }),
      ),
      AUTH_LOGIN_METHOD: "password",
      AUTH_PASSWORD_HASHES: JSON.stringify({
        [adminEmail]: hash,
        [rateEmail]: hash,
        [deniedEmail]: hash,
        [externalEmail]: hash,
      }),
      AUTH_ALLOWED_EMAILS: `${adminEmail},${rateEmail},without-password@example.com`,
      AUTH_SEND_LIMIT_PER_EMAIL: "8",
      AUTH_SEND_LIMIT_PER_IP: "64",
      AUTH_SEND_WINDOW_S: "3600",
      OIDC_ISSUER: `${portalUrl}/idp`,
      OIDC_AUTH_ENDPOINT: `${portalUrl}/idp/authorize`,
      OIDC_TOKEN_ENDPOINT: `${authUrl}/token`,
      OIDC_USERINFO_ENDPOINT: `${authUrl}/userinfo`,
      OIDC_JWKS_URI: `${authUrl}/.well-known/jwks.json`,
      OIDC_CLIENT_ID: "password-integration",
      OIDC_CLIENT_SECRET: clientSecret,
      OIDC_PRINCIPAL_CLAIM: "email",
      OIDC_ALLOWED_EMAILS: adminEmail,
    };
    const children: ChildProcess[] = [];
    t.after(async () => {
      await Promise.all(children.map(stop));
    });
    const start = async (name: string, port: number, overrides: NodeJS.ProcessEnv = {}): Promise<ChildProcess> => {
      const child = spawn(process.execPath, ["src/index.ts"], {
        cwd: `${root}/plugins/${name}`,
        env: { ...env, ...overrides, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let output = "";
      child.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child.exitCode, null, `${name} failed to start: ${output}`);
        const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
        if (response?.ok) return child;
        await setTimeout(100);
      }
      throw new Error(`${name} did not become healthy: ${output}`);
    };
    let auth = await start("auth", authPort);
    await Promise.all([start("portal", portalPort), start("admin", adminPort)]);
    const submit = (request: string, email: string, candidate = password): Promise<Response> =>
      fetch(`${portalUrl}/idp/authorize`, {
        method: "POST",
        headers: { origin: portalUrl },
        body: new URLSearchParams({ request, email, password: candidate }),
        redirect: "manual",
      });
    const begin = async (): Promise<{ request: string; temporary: string }> => {
      const login = await fetch(`${portalUrl}/auth/login?returnTo=%2Fadmin%2Fapi%2Fwhoami`, { redirect: "manual" });
      assert.equal(login.status, 302);
      return {
        request: await requestToken(await fetch(login.headers.get("location")!)),
        temporary: cookie(login, "portal_oidc_tmp"),
      };
    };
    const adminSession = async (): Promise<string> => {
      const { request, temporary } = await begin();
      const authorized = await submit(request, adminEmail);
      assert.equal(authorized.status, 302, await authorized.text());
      const callback = await fetch(authorized.headers.get("location")!, {
        headers: { cookie: temporary },
        redirect: "manual",
      });
      assert.equal(callback.status, 302, await callback.text());
      const session = cookie(callback, "portal_session");
      const who = await fetch(`${portalUrl}/admin/api/whoami`, { headers: { cookie: session } });
      assert.equal(who.status, 200, await who.clone().text());
      const identity = (await who.json()) as { principal: string };
      assert.equal(identity.principal, adminEmail);
      return session;
    };
    const signIn = async (): Promise<void> => {
      const session = await adminSession();
      const logout = await fetch(`${portalUrl}/auth/logout`, {
        method: "POST",
        headers: { cookie: session, origin: portalUrl },
      });
      assert.equal(logout.status, 200);
      assert.match(cookie(logout, "portal_session"), /^portal_session=$/);
      assert.equal((await fetch(`${portalUrl}/admin/api/whoami`)).status, 401);
    };
    await t.test("signs in and out without any mail configuration", signIn);
    const { request } = await begin();
    await t.test("rejects wrong, unknown, unprovisioned, and non-allowlisted credentials", async () => {
      for (const [email, candidate] of [
        [adminEmail, "Incorrect integration password"],
        ["unknown@example.com", password],
        ["without-password@example.com", password],
        [deniedEmail, password],
      ]) {
        const response = await submit(request, email!, candidate!);
        assert.equal(response.status, 401);
        assert.match(await response.text(), /Email or password is incorrect/);
      }
    });
    await t.test("revoking an external member disables their existing password", async () => {
      const session = await adminSession();
      const headers = { cookie: session, origin: portalUrl, "content-type": "application/json" };
      const users = await fetch(`${portalUrl}/admin/api/users`, { headers });
      assert.equal(users.status, 200);
      assert.equal(
        ((await users.json()) as { inviteEmail: { configured: boolean } }).inviteEmail.configured,
        false,
        "use an isolated core with no mail service",
      );
      const membersUrl = `${portalUrl}/admin/api/external-users`;
      const invite = await fetch(membersUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: externalEmail, expiresAt: Date.now() + 3_600_000 }),
      });
      assert.equal(invite.status, 200, await invite.clone().text());
      assert.equal(((await invite.json()) as { emailSent: boolean }).emailSent, false);
      const revoke = (): Promise<Response> =>
        fetch(`${membersUrl}/${encodeURIComponent(externalEmail)}`, { method: "DELETE", headers });
      try {
        assert.equal((await submit(request, externalEmail)).status, 302);
        assert.equal((await revoke()).status, 200);
        const denied = await submit(request, externalEmail);
        assert.equal(denied.status, 401);
        assert.match(await denied.text(), /Email or password is incorrect/);
      } finally {
        await revoke();
      }
    });
    await t.test("disables old magic-link routes", async () => {
      assert.equal((await fetch(`${portalUrl}/idp/verify`)).status, 404);
      assert.equal(
        (
          await fetch(`${portalUrl}/idp/verify`, {
            method: "POST",
            headers: { origin: portalUrl },
            body: new URLSearchParams({ token: "old-link" }),
          })
        ).status,
        404,
      );
    });
    const verifier = secret();
    const codeFor = async (): Promise<string> => {
      const params = new URLSearchParams({
        client_id: env.AUTH_CLIENT_ID!,
        redirect_uri: env.AUTH_REDIRECT_URI!,
        response_type: "code",
        scope: "openid email",
        state: secret(),
        nonce: secret(),
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      });
      const token = await requestToken(await fetch(`${portalUrl}/idp/authorize?${params}`));
      const response = await submit(token, adminEmail);
      assert.equal(response.status, 302, await response.text());
      return new URL(response.headers.get("location")!).searchParams.get("code")!;
    };
    const exchange = (code: string, codeVerifier = verifier): Promise<Response> =>
      fetch(`${authUrl}/token`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${env.AUTH_CLIENT_ID}:${clientSecret}`).toString("base64")}` },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: env.AUTH_REDIRECT_URI!,
        }),
      });
    let consumedCode = "";
    await t.test("enforces PKCE and one-time authorization codes through real core", async () => {
      assert.equal((await exchange(await codeFor(), secret())).status, 400);
      consumedCode = await codeFor();
      const exchanged = await exchange(consumedCode);
      assert.equal(exchanged.status, 200);
      const tokens = (await exchanged.json()) as { access_token: string };
      const info = await fetch(`${authUrl}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
      assert.equal(info.status, 200);
      assert.equal(((await info.json()) as { email: string }).email, adminEmail);
      assert.equal((await exchange(consumedCode)).status, 400);
    });
    await t.test("persists failed-attempt limits and spent codes across broker restart", async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        assert.equal((await submit(request, rateEmail, "Incorrect integration password")).status, 401);
      }
      assert.equal((await submit(request, rateEmail)).status, 429);
      await stop(auth);
      auth = await start("auth", authPort);
      assert.equal((await submit(request, rateEmail)).status, 429);
      assert.equal((await exchange(consumedCode)).status, 400);
      await signIn();
    });
    await t.test("the portal prevents spoofing client IPs while a different client can still sign in", async () => {
      const options: RequestInit = {
        method: "POST",
        headers: { origin: portalUrl, "x-qm-client-ip": "198.51.100.42" },
        body: new URLSearchParams({ request, email: rateEmail, password }),
        redirect: "manual",
      };
      assert.equal((await fetch(`${portalUrl}/idp/authorize`, options)).status, 429);
      assert.equal((await fetch(`${authUrl}/authorize`, options)).status, 302);
    });
    await t.test("fails closed when the real core claim service is unreachable", async () => {
      const [outagePort, unreachablePort] = await Promise.all([freePort(), freePort()]);
      await start("auth", outagePort, { CORE_API_URL: `http://127.0.0.1:${unreachablePort}` });
      const response = await fetch(`http://127.0.0.1:${outagePort}/authorize`, {
        method: "POST",
        headers: { origin: portalUrl },
        body: new URLSearchParams({ request, email: adminEmail, password }),
        redirect: "manual",
      });
      assert.equal(response.status, 503);
      assert.match(await response.text(), /Sign-in is temporarily unavailable/);
      assert.equal(response.headers.get("location"), null);
    });
  },
);
