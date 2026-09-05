import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.ts";
import { mailerFor, renderMessage, renderSignInEmail, resendMailer } from "../src/email.ts";
import { testEnv } from "./helpers.ts";

const cfg = readConfig(testEnv());

test("no mailer is created with missing or incomplete email configuration", () => {
  for (const transport of ["resend", "smtp"]) {
    assert.equal(
      mailerFor(
        readConfig(testEnv({ AUTH_EMAIL_TRANSPORT: transport, AUTH_EMAIL_FROM: undefined, RESEND_API_KEY: undefined })),
      ),
      null,
    );
    const complete = {
      AUTH_EMAIL_TRANSPORT: transport,
      SMTP_HOST: "smtp.example.com",
      SMTP_USERNAME: "u",
      SMTP_PASSWORD: "p",
    };
    const credentials = transport === "resend" ? ["RESEND_API_KEY"] : ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"];
    for (const name of ["AUTH_EMAIL_FROM", ...credentials]) {
      assert.equal(mailerFor(readConfig(testEnv({ ...complete, [name]: undefined }))), null, `${transport}: ${name}`);
    }
  }
});

test("the sign-in email carries the link once in both alternatives and never a bare secret", () => {
  const message = renderSignInEmail({
    to: "admin@example.com",
    brandName: "qm",
    link: "https://agent.example.test/idp/verify?token=abc.def.ghi",
    ttlMinutes: 15,
  });
  assert.equal(message.subject, "Sign in to qm");
  assert.match(message.text, /https:\/\/agent\.example\.test\/idp\/verify\?token=abc\.def\.ghi/);
  assert.match(message.html, /href="https:\/\/agent\.example\.test\/idp\/verify\?token=abc\.def\.ghi"/);
  assert.match(message.text, /works once and expires in 15 minutes/);
});

test("the link is HTML-escaped so a crafted token cannot break out of the anchor", () => {
  const message = renderSignInEmail({
    to: "admin@example.com",
    brandName: "<script>",
    link: 'https://x.test/verify?token=a"><script>alert(1)</script>',
    ttlMinutes: 5,
  });
  assert.ok(!message.html.includes("<script>alert(1)</script>"));
  assert.ok(!message.html.includes("<script> ·"));
  assert.match(message.html, /&lt;script&gt;/);
});

test("the MIME message is a well-formed multipart/alternative", () => {
  const raw = renderMessage(
    cfg,
    { to: "admin@example.com", subject: "Sign in to qm", text: "plain", html: "<p>rich</p>" },
    Date.UTC(2026, 0, 2, 3, 4, 5),
  );
  const boundary = /boundary="([^"]+)"/.exec(raw)![1]!;
  assert.match(raw, /^From: qm <no-reply@example\.com>\r\n/);
  assert.match(raw, /\r\nTo: admin@example\.com\r\n/);
  assert.match(raw, /\r\nDate: Fri, 02 Jan 2026 03:04:05 GMT\r\n/);
  assert.match(raw, /\r\nMessage-ID: <[0-9a-f]{32}@example\.com>\r\n/);
  assert.equal(raw.split(`--${boundary}`).length, 4);
  assert.equal(
    Buffer.from(
      /text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([^\r]+)/.exec(raw)![1]!,
      "base64",
    ).toString("utf8"),
    "plain",
  );
  assert.ok(raw.endsWith(`--${boundary}--\r\n`));
});

test("header injection through the subject or recipient is neutralised", () => {
  const raw = renderMessage(cfg, {
    to: "admin@example.com\r\nBcc: attacker@evil.test",
    subject: "Sign in\r\nBcc: attacker@evil.test",
    text: "plain",
    html: "<p>rich</p>",
  });
  const headers = raw.split("\r\n\r\n")[0]!.split("\r\n");
  assert.deepEqual(
    headers.map((line) => line.split(":")[0]),
    ["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Auto-Submitted", "Content-Type"],
    "a CRLF in a header value must not fold into a new header line",
  );
});

test("a non-ASCII subject is RFC 2047 encoded", () => {
  const raw = renderMessage(cfg, { to: "a@b.test", subject: "Se connecter à qm", text: "x", html: "<p>x</p>" });
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
});

test("the Resend transport reports the provider's message id and surfaces refusals", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const ok = resendMailer(cfg, (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "re_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch);
  assert.equal(await ok.send({ to: "admin@example.com", subject: "s", text: "t", html: "<p>h</p>" }), "re_123");
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer re_test_key");
  assert.deepEqual((JSON.parse(String(calls[0]!.init.body)) as { to: string[] }).to, ["admin@example.com"]);

  const refused = resendMailer(
    cfg,
    (async () =>
      new Response(JSON.stringify({ message: "domain not verified" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  );
  await assert.rejects(
    () => refused.send({ to: "a@b.test", subject: "s", text: "t", html: "h" }),
    /domain not verified/,
  );

  const badKey = resendMailer(cfg, (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch);
  await assert.rejects(() => badKey.verify(), /rejected RESEND_API_KEY/);
});
