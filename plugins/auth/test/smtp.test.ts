import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { readConfig } from "../src/config.ts";
import { mailerFor, renderSignInEmail } from "../src/email.ts";
import { testEnv } from "./helpers.ts";

interface FakeSmtp {
  port: number;
  transcript: string[];
  messages: string[];
  close(): Promise<void>;
}

async function fakeSmtp(
  options: { offerStartTls?: boolean; rejectAuth?: boolean; rejectRecipient?: boolean } = {},
): Promise<FakeSmtp> {
  const transcript: string[] = [];
  const messages: string[] = [];
  const handle = (socket: Socket): void => {
    let buffer = "";
    let inData = false;
    let message = "";
    socket.setEncoding("utf8");
    socket.write("220 fake.smtp.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(message);
            message = "";
            socket.write("250 2.0.0 Ok: queued as FAKE1\r\n");
          } else message += `${line.startsWith(".") ? line.slice(1) : line}\n`;
          continue;
        }
        transcript.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO")
          socket.write(
            `250-fake.smtp.test\r\n${options.offerStartTls ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN LOGIN\r\n`,
          );
        else if (verb === "AUTH")
          socket.write(options.rejectAuth ? "535 5.7.8 bad credentials\r\n" : "235 2.7.0 Accepted\r\n");
        else if (verb === "MAIL") socket.write("250 2.1.0 Ok\r\n");
        else if (verb === "RCPT")
          socket.write(options.rejectRecipient ? "550 5.1.1 no such user\r\n" : "250 2.1.5 Ok\r\n");
        else if (verb === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else socket.write("502 5.5.2 not implemented\r\n");
      }
    });
    socket.on("error", () => undefined);
  };
  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    transcript,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function smtpMailer(port: number, overrides: Record<string, string> = {}) {
  const mailer = mailerFor(
    readConfig(
      testEnv({
        AUTH_EMAIL_TRANSPORT: "smtp",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(port),
        SMTP_TLS: "none",
        SMTP_USERNAME: "apikey",
        SMTP_PASSWORD: "s3cret",
        ...overrides,
      }),
    ),
  );
  assert.ok(mailer);
  return mailer;
}

function part(raw: string, type: string): string {
  const body = new RegExp(
    `Content-Type: ${type}; charset=utf-8\nContent-Transfer-Encoding: base64\n\n([A-Za-z0-9+/=\n]+)`,
  ).exec(raw);
  assert.ok(body, `no base64 ${type} part`);
  return Buffer.from(body[1]!.replaceAll("\n", ""), "base64").toString("utf8");
}

function headerNames(raw: string): string[] {
  return raw
    .split("\n\n")[0]!
    .split("\n")
    .filter((line) => !/^\s/.test(line))
    .map((line) => line.split(":")[0]!);
}

const signIn = renderSignInEmail({
  to: "admin@example.com",
  brandName: "qm",
  link: "https://agent.example.test/idp/verify#token=abc.def.ghi",
  ttlMinutes: 15,
});

test("the sign-in email is delivered as multipart/alternative over the full SMTP conversation", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  const receipt = await smtpMailer(server.port).send(signIn);
  assert.match(receipt, /queued as FAKE1/);
  assert.deepEqual(
    server.transcript.slice(0, 5).map((line) => line.split(" ")[0]),
    ["EHLO", "AUTH", "MAIL", "RCPT", "DATA"],
  );
  assert.equal(
    Buffer.from(server.transcript[1]!.slice("AUTH PLAIN ".length), "base64").toString("utf8"),
    "\0apikey\0s3cret",
  );
  assert.equal(server.transcript[2], "MAIL FROM:<no-reply@example.com>");
  assert.equal(server.transcript[3], "RCPT TO:<admin@example.com>");
  const raw = server.messages[0]!;
  assert.match(raw, /^From: qm <no-reply@example\.com>$/m);
  assert.match(raw, /^To: admin@example\.com$/m);
  assert.match(raw, /^Subject: Sign in to qm$/m);
  assert.match(raw, /^Auto-Submitted: auto-generated$/m);
  assert.match(raw, /^Message-ID: <[^>]+@example\.com>$/m);
  assert.match(raw, /^Content-Type: multipart\/alternative;/m);
  assert.equal(part(raw, "text/plain"), signIn.text);
  assert.equal(part(raw, "text/html"), signIn.html);
});

test("a CRLF in the subject cannot add a header and a non-ASCII subject is RFC 2047 encoded", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  const mailer = smtpMailer(server.port);
  await mailer.send({ ...signIn, subject: "Sign in\r\nBcc: attacker@evil.test" });
  await mailer.send({ ...signIn, subject: "Se connecter à qm" });
  assert.ok(!headerNames(server.messages[0]!).includes("Bcc"));
  assert.deepEqual(
    server.transcript.filter((line) => line.startsWith("RCPT")),
    ["RCPT TO:<admin@example.com>", "RCPT TO:<admin@example.com>"],
  );
  const subject = /^Subject: (.+)$/m.exec(server.messages[1]!)![1]!;
  assert.match(subject, /^=\?UTF-8\?[BQ]\?[\x21-\x7e]+\?=$/);
});

test("a rejected recipient and rejected credentials both surface as errors", async (t) => {
  const rejecting = await fakeSmtp({ rejectRecipient: true });
  t.after(() => rejecting.close());
  await assert.rejects(() => smtpMailer(rejecting.port).send(signIn), /550 5\.1\.1 no such user/);

  const unauthorized = await fakeSmtp({ rejectAuth: true });
  t.after(() => unauthorized.close());
  await assert.rejects(() => smtpMailer(unauthorized.port).send(signIn), /535 5\.7\.8 bad credentials/);
  assert.equal(unauthorized.messages.length, 0);
});

test("STARTTLS mode refuses a server that does not advertise STARTTLS before sending credentials", async (t) => {
  const server = await fakeSmtp({ offerStartTls: false });
  t.after(() => server.close());
  await assert.rejects(() => smtpMailer(server.port, { SMTP_TLS: "starttls" }).send(signIn), /STARTTLS/);
  assert.ok(!server.transcript.some((line) => line.startsWith("AUTH")));
});
