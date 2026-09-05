import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { adminLoginUrl } from "../../cli/src/commands/admin-login.ts";
import { deriveKey, openSession, seal } from "../../plugins/portal/src/session.ts";

const envPath = process.env.QM_ADMIN_LOGIN_ENV_FILE;
const env = envPath ? (JSON.parse(readFileSync(envPath, "utf8")) as Record<string, string>) : null;
const root = fileURLToPath(new URL("../../", import.meta.url));

test(
  "operator login against real QM core, Postgres, admin, portal, and email broker",
  {
    skip: !env && "Set QM_ADMIN_LOGIN_ENV_FILE to the isolated live deployment environment JSON",
  },
  async (t) => {
    assert.ok(env);
    const publicUrl = env.PORTAL_PUBLIC_URL!;
    const secret = env.PORTAL_SESSION_SECRET!;
    const configuredAdmin = env.ADMIN_GRANTS!.split(":")[0]!.toLowerCase();
    const cli = () => {
      const command = spawnSync(process.execPath, ["cli/bin/qm.ts", "admin-login"], {
        cwd: root,
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
      });
      assert.equal(command.status, 0, command.stderr);
      return new URL(command.stdout.trim());
    };
    const tokenOf = (url: URL) => new URLSearchParams(url.hash.slice(1)).get("token")!;
    const post = (token: string, extraHeaders: Record<string, string> = {}) =>
      fetch(`${publicUrl}/auth/admin-login`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: publicUrl, "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
        body: new URLSearchParams({ token }),
      });
    const cookieOf = (res: Response) => {
      const cookie = res.headers
        .getSetCookie()
        .find((value) => value.startsWith("portal_session=") && !value.startsWith("portal_session=;"));
      assert.ok(cookie);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      if (publicUrl.startsWith("https:")) assert.match(cookie, /Secure/);
      return cookie.split(";")[0]!;
    };

    await t.test("all services start without email, and email sign-in reports its unavailable state", async () => {
      assert.equal(env.RESEND_API_KEY ?? "", "");
      assert.equal(env.AUTH_EMAIL_FROM ?? "", "");
      for (const base of [env.CORE_API_URL!, env.ADMIN_UPSTREAM!, env.AUTH_BROKER_UPSTREAM!, publicUrl]) {
        assert.equal((await fetch(`${base}/healthz`)).status, 200, base);
      }
      const redirect = await fetch(`${publicUrl}/auth/login`, { redirect: "manual" });
      assert.equal(redirect.status, 302);
      const emailPage = await fetch(redirect.headers.get("location")!);
      assert.equal(emailPage.status, 503);
      assert.match(await emailPage.text(), /Email delivery (?:isn.t|isn&#39;t) configured/);
    });

    await t.test("CLI link requires confirmation and establishes the existing QM admin session once", async () => {
      const url = cli();
      const confirmation = await fetch(url);
      assert.equal(confirmation.status, 200);
      assert.equal(confirmation.headers.get("cache-control"), "no-store");
      assert.equal(confirmation.headers.get("referrer-policy"), "no-referrer");
      assert.equal(confirmation.headers.getSetCookie().length, 0);
      assert.match(await confirmation.text(), /Only continue if you generated this link/);
      const res = await post(tokenOf(url));
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "/admin/");
      const cookie = cookieOf(res);
      const claims = openSession(
        decodeURIComponent(cookie.slice("portal_session=".length)),
        deriveKey(secret, "portal.session.v1"),
        Date.now(),
        env.CORE_ORG_ID,
      );
      assert.equal(claims?.sub, configuredAdmin);
      assert.ok(res.headers.getSetCookie().some((value) => value.startsWith("portal_impersonate=;")));
      const whoami = await fetch(`${publicUrl}/admin/api/whoami`, { headers: { cookie } });
      assert.equal(whoami.status, 200);
      assert.equal(((await whoami.json()) as { isAdmin: boolean }).isAdmin, true);
      assert.equal((await post(tokenOf(url))).status, 400);
    });

    await t.test("concurrent redemption grants exactly one session", async () => {
      const token = tokenOf(cli());
      const results = await Promise.all([post(token), post(token)]);
      assert.deepEqual(results.map((res) => res.status).sort(), [303, 400]);
    });

    await t.test(
      "bad signatures, stale tokens, other portals and non-admin identities cannot obtain a session",
      async () => {
        const original = JSON.parse(Buffer.from(tokenOf(cli()).split(".")[0]!, "base64url").toString()) as Record<
          string,
          unknown
        >;
        const key = deriveKey(secret, "portal.admin-login.v1");
        const invalid = [
          { aud: "https://other.example.com" },
          { iat: Number(original.iat) - 600, exp: Number(original.exp) - 600 },
          { k: "session" },
        ];
        for (const changes of invalid) {
          const res = await post(seal({ ...original, ...changes }, key));
          assert.equal(res.status, 400);
          assert.equal(res.headers.getSetCookie().length, 0);
        }
        assert.equal((await post(`${tokenOf(cli())}broken`)).status, 400);
        const unauthorized = new URL(
          adminLoginUrl({ publicUrl, secret, adminGrants: "not-an-admin@example.com:org_admin" }),
        );
        const denied = await post(tokenOf(unauthorized));
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.getSetCookie().length, 0);
      },
    );

    await t.test("cross-origin requests cannot redeem an otherwise valid link", async () => {
      const token = tokenOf(cli());
      assert.equal((await post(token, { origin: "https://attacker.example.com" })).status, 403);
      assert.equal((await post(token, { origin: "null" })).status, 403);
      assert.equal((await post(token, { "sec-fetch-site": "cross-site" })).status, 403);
      assert.equal((await post(token)).status, 303);
    });
  },
);
