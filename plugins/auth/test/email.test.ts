import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.ts";
import { renderMessage, renderSignInEmail, resendMailer } from "../src/email.ts";
import { testEnv } from "./helpers.ts";

const cfg = readConfig(testEnv());

function foldedSubject(raw: string): { value: string; words: string[]; lines: string[] } {
  const value = /\r\nSubject: ([^\r\n]+(?:\r\n [^\r\n]+)*)\r\nDate:/.exec(raw)?.[1];
  assert.ok(value);
  const words = value.split("\r\n ");
  return { value, words, lines: [`Subject: ${words[0]}`, ...words.slice(1).map((word) => ` ${word}`)] };
}

function decodeEncodedWords(words: string[]): string {
  return words
    .map((word) => {
      const encoded = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word)?.[1];
      assert.ok(encoded);
      return Buffer.from(encoded, "base64").toString("utf8");
    })
    .join("");
}

test("the sign-in email carries the link once in both alternatives and never a bare secret", () => {
  const message = renderSignInEmail({
    locale: "en",
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
    locale: "en",
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
  assert.match(raw, /\r\nSubject: Sign in to qm\r\n/);
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

test("the Japanese sign-in subject is RFC 2047 encoded", () => {
  const message = renderSignInEmail({
    locale: "ja",
    to: "a@b.test",
    brandName: "qm",
    link: "https://agent.example.test/idp/verify#token=abc",
    ttlMinutes: 15,
  });
  const raw = renderMessage(cfg, message);
  const encoded = /\r\nSubject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=\r\n/.exec(raw)?.[1];
  assert.ok(encoded);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "qmにサインイン");
});

test("a long Unicode sign-in subject is folded into decodable RFC 2047 encoded-words", () => {
  const brandName = "エージェント管理基盤🚀".repeat(12);
  const message = renderSignInEmail({
    locale: "ja",
    to: "a@b.test",
    brandName,
    link: "https://agent.example.test/idp/verify?locale=ja#token=abc",
    ttlMinutes: 15,
  });
  const raw = renderMessage(cfg, message);
  const { words, lines } = foldedSubject(raw);
  assert.ok(words.length > 1);
  assert.ok(words.every((word) => word.length <= 75));
  assert.ok(lines.every((line) => line.length <= 78));
  assert.equal(decodeEncodedWords(words), message.subject);
});

test("a long ASCII brand is folded without exceeding a Subject header line limit", () => {
  const message = renderSignInEmail({
    locale: "en",
    to: "a@b.test",
    brandName: "x".repeat(1000),
    link: "https://agent.example.test/idp/verify?locale=en#token=abc",
    ttlMinutes: 15,
  });
  const { words, lines } = foldedSubject(renderMessage(cfg, message));
  assert.ok(words.length > 1);
  assert.ok(words.every((word) => word.length <= 75));
  assert.ok(lines.every((line) => line.length <= 78));
  assert.ok(lines.every((line) => line.length <= 998));
  assert.equal(decodeEncodedWords(words), message.subject);
});

test("a folded mixed subject decodes to the CRLF-sanitized original", () => {
  const message = renderSignInEmail({
    locale: "en",
    to: "a@b.test",
    brandName: `${"agent".repeat(40)}日本語🚀\r\nBcc: attacker@evil.test${"z".repeat(80)}`,
    link: "https://agent.example.test/idp/verify?locale=en#token=abc",
    ttlMinutes: 15,
  });
  const { words, lines } = foldedSubject(renderMessage(cfg, message));
  assert.ok(words.every((word) => word.length <= 75));
  assert.ok(lines.every((line) => line.length <= 78));
  assert.equal(decodeEncodedWords(words), message.subject.replace(/[\r\n]+/g, " ").trim());
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
