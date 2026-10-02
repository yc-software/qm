import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.ts";
import { mailerFor } from "../src/email.ts";
import { fakeSmtp, headerOf, mimePart } from "./fake-smtp.ts";
import { authorizeQuery, hiddenRequestToken, ISSUER, REDIRECT_URI, startHarness, testEnv } from "./helpers.ts";

test("a requested sign-in link is delivered over SMTP and the delivered link signs the user in", async (t) => {
  const smtp = await fakeSmtp();
  t.after(() => smtp.close());
  const env = {
    AUTH_EMAIL_TRANSPORT: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.port),
    SMTP_USERNAME: "apikey",
    SMTP_PASSWORD: "s3cret",
    SMTP_TLS: "none",
  };
  const h = await startHarness({ env, brandName: () => "Acme QM", mailer: mailerFor(readConfig(testEnv(env)))! });
  t.after(() => h.close());

  const query = authorizeQuery();
  const page = await fetch(`${h.base}/authorize?${query}`);
  const submitted = await fetch(`${h.base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      request: hiddenRequestToken(await page.text()),
      email: "Admin@Example.com",
    }).toString(),
  });
  assert.equal(submitted.status, 200);
  await h.settle();

  assert.equal(smtp.messages.length, 1);
  const mail = smtp.messages[0]!;
  assert.deepEqual(mail.to, ["admin@example.com"]);
  assert.equal(mail.from, "no-reply@example.com");
  assert.deepEqual(headerOf(mail.data, "Subject"), ["Sign in to Acme QM"]);
  const text = mimePart(mail.data, "text/plain");
  const link = /\S+\/verify#token=[A-Za-z0-9._~%-]+/.exec(text)?.[0] ?? "";
  assert.ok(link.startsWith(`${ISSUER}/verify#token=`), "the plain-text part carries the sign-in link");
  assert.ok(mimePart(mail.data, "text/html").includes(`href="${link}"`), "the HTML part links to the same address");

  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
  const redeemed = await fetch(`${h.base}/verify`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    redirect: "manual",
  });
  const location = new URL(redeemed.headers.get("location") ?? "", h.base);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), query.get("state"));
  assert.ok(location.searchParams.get("code"));
});

test("an address list is refused at /authorize and never reaches the SMTP relay", async (t) => {
  const smtp = await fakeSmtp();
  t.after(() => smtp.close());
  const env = {
    AUTH_EMAIL_TRANSPORT: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.port),
    SMTP_USERNAME: "apikey",
    SMTP_PASSWORD: "s3cret",
    SMTP_TLS: "none",
  };
  const h = await startHarness({
    env,
    emailAllowed: async () => true,
    mailer: mailerFor(readConfig(testEnv(env)))!,
  });
  t.after(() => h.close());
  for (const email of ["admin@example.com,attacker@evil.test", "admin@example.com, attacker@evil.test"]) {
    const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
    const submitted = await fetch(`${h.base}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: hiddenRequestToken(await page.text()), email }).toString(),
    });
    assert.equal(submitted.status, 400);
  }
  await h.settle();
  assert.deepEqual(smtp.transcript, []);
  assert.equal(smtp.messages.length, 0);
});
