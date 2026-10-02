import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.ts";
import { mailerFor, renderSignInEmail, resendMailer } from "../src/email.ts";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fakeSmtp, headerOf, mimePart } from "./fake-smtp.ts";
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

function smtpConfig(port: number, over: Record<string, string> = {}) {
  return readConfig(
    testEnv({
      AUTH_EMAIL_TRANSPORT: "smtp",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(port),
      SMTP_USERNAME: "apikey",
      SMTP_PASSWORD: "s3cret",
      SMTP_TLS: "none",
      ...over,
    }),
  );
}

test("SMTP delivery sends a multipart/alternative message with the envelope and headers it needs", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  const receipt = await mailerFor(smtpConfig(server.port))!.send({
    to: "admin@example.com",
    subject: "Se connecter à qm",
    text: "plain\n.leading dot survives",
    html: "<p>rich</p>",
  });
  assert.match(receipt, /queued as FAKE1/);
  assert.deepEqual(
    server.transcript.slice(0, 5).map((line) => line.split(" ")[0]),
    ["EHLO", "AUTH", "MAIL", "RCPT", "DATA"],
  );
  assert.equal(server.transcript[0], "EHLO 127.0.0.1");
  const mail = server.messages[0]!;
  assert.equal(mail.from, "no-reply@example.com");
  assert.deepEqual(mail.to, ["admin@example.com"]);
  assert.deepEqual(headerOf(mail.data, "From"), ["qm <no-reply@example.com>"]);
  assert.deepEqual(headerOf(mail.data, "To"), ["admin@example.com"]);
  assert.match(headerOf(mail.data, "Subject")[0]!, /^=\?UTF-8\?/);
  assert.match(headerOf(mail.data, "Message-ID")[0]!, /^<[^@\s]+@example\.com>$/);
  assert.equal(headerOf(mail.data, "Date").length, 1);
  assert.deepEqual(headerOf(mail.data, "Auto-Submitted"), ["auto-generated"]);
  assert.match(headerOf(mail.data, "Content-Type")[0]!, /^multipart\/alternative;/);
  assert.equal(mimePart(mail.data, "text/plain"), "plain\r\n.leading dot survives");
  assert.equal(mimePart(mail.data, "text/html"), "<p>rich</p>");
});

test("a display name with a comma stays one sender", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  await mailerFor(smtpConfig(server.port, { AUTH_EMAIL_FROM: "QM, Inc <no-reply@example.com>" }))!.send({
    to: "admin@example.com",
    subject: "s",
    text: "t",
    html: "<p>h</p>",
  });
  const mail = server.messages[0]!;
  assert.equal(mail.from, "no-reply@example.com");
  assert.deepEqual(headerOf(mail.data, "From"), ['"QM, Inc" <no-reply@example.com>']);
});

test("header injection through the subject is neutralised", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  await mailerFor(smtpConfig(server.port))!.send({
    to: "admin@example.com",
    subject: "Sign in\r\nBcc: attacker@evil.test",
    text: "plain",
    html: "<p>rich</p>",
  });
  const mail = server.messages[0]!;
  assert.deepEqual(mail.to, ["admin@example.com"]);
  assert.deepEqual(headerOf(mail.data, "Bcc"), []);
  assert.equal(headerOf(mail.data, "Subject").length, 1);
});

test("SMTP refusals surface as errors and verification authenticates without sending", async (t) => {
  const rejecting = await fakeSmtp({ rejectRecipient: true });
  t.after(() => rejecting.close());
  await assert.rejects(
    () => mailerFor(smtpConfig(rejecting.port))!.send({ to: "nobody@example.com", subject: "s", text: "t", html: "h" }),
    /550 5\.1\.1 no such user/,
  );

  const server = await fakeSmtp();
  t.after(() => server.close());
  assert.equal(await mailerFor(smtpConfig(server.port))!.verify(), `SMTP 127.0.0.1:${server.port} authenticated`);
  assert.deepEqual(
    server.transcript.slice(0, 2).map((line) => line.split(" ")[0]),
    ["EHLO", "AUTH"],
  );
  assert.ok(!server.transcript.some((line) => /^(MAIL|RCPT|DATA)\b/.test(line)));
  assert.equal(server.messages.length, 0);

  const unauthorized = await fakeSmtp({ password: "other" });
  t.after(() => unauthorized.close());
  await assert.rejects(() => mailerFor(smtpConfig(unauthorized.port))!.verify(), /535 5\.7\.8 bad credentials/);
});

test("STARTTLS mode never sends credentials before the TLS upgrade", async (t) => {
  const plain = await fakeSmtp({ offerStartTls: false });
  t.after(() => plain.close());
  await assert.rejects(() => mailerFor(smtpConfig(plain.port, { SMTP_TLS: "starttls" }))!.verify());
  assert.ok(!plain.transcript.some((line) => line.startsWith("AUTH")));

  const upgrading = await fakeSmtp({ offerStartTls: true });
  t.after(() => upgrading.close());
  await assert.rejects(() => mailerFor(smtpConfig(upgrading.port, { SMTP_TLS: "starttls" }))!.verify());
  assert.deepEqual(
    upgrading.transcript.map((line) => line.split(" ")[0]),
    ["EHLO", "STARTTLS"],
  );
  assert.ok(upgrading.tlsClientHello, "the client began a TLS handshake after STARTTLS");
});

test("implicit TLS opens with a TLS handshake and port 465 selects it by default", async (t) => {
  const server = await fakeSmtp({ implicitTls: true });
  t.after(() => server.close());
  await assert.rejects(() => mailerFor(smtpConfig(server.port, { SMTP_TLS: "implicit" }))!.verify());
  assert.ok(server.tlsClientHello);
  assert.deepEqual(server.transcript, []);
  assert.equal(smtpConfig(465, { SMTP_TLS: "" }).smtp.tls, "implicit");
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

const tlsDir = mkdtempSync(join(tmpdir(), "qm-smtp-tls-"));
const certPath = join(tlsDir, "cert.pem");
const keyPath = join(tlsDir, "key.pem");
const opensslMissing =
  spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-days",
    "1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]).status !== 0;
const certificate = opensslMissing
  ? { key: "", cert: "" }
  : { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
after(() => rmSync(tlsDir, { recursive: true, force: true }));

async function sendInChild(env: Record<string, string>, trustFixture: boolean): Promise<void> {
  const script = `
    const { readConfig } = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});
    const { mailerFor } = await import(${JSON.stringify(new URL("../src/email.ts", import.meta.url).href)});
    const { testEnv } = await import(${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)});
    const mailer = mailerFor(readConfig(testEnv(JSON.parse(process.env.SMTP_TEST_ENV))));
    await mailer.send({ to: "admin@example.com", subject: "s", text: "t", html: "<p>h</p>" });
  `;
  const { NODE_EXTRA_CA_CERTS: _inherited, ...base } = process.env;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...base,
      SMTP_TEST_ENV: JSON.stringify(env),
      ...(trustFixture ? { NODE_EXTRA_CA_CERTS: certPath } : {}),
    },
  });
}

for (const mode of ["starttls", "implicit"] as const) {
  test(
    `${mode} delivery refuses an untrusted certificate and delivers once the CA is trusted`,
    { skip: opensslMissing && "openssl is not on PATH" },
    async (t) => {
      const server = await fakeSmtp({
        certificate,
        offerStartTls: mode === "starttls",
        implicitTls: mode === "implicit",
      });
      t.after(() => server.close());
      const env = {
        AUTH_EMAIL_TRANSPORT: "smtp",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(server.port),
        SMTP_USERNAME: "apikey",
        SMTP_PASSWORD: "s3cret",
        SMTP_TLS: mode,
      };
      await assert.rejects(() => sendInChild(env, false), /certificate/);
      assert.ok(!server.transcript.some((line) => line.startsWith("AUTH")));
      assert.equal(server.messages.length, 0);
      await sendInChild(env, true);
      assert.equal(server.messages.length, 1);
      assert.deepEqual(server.messages[0]!.to, ["admin@example.com"]);
    },
  );
}
