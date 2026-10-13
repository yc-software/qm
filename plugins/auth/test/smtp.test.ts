import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { readConfig } from "../src/config.ts";
import { mailerFor, type Mailer } from "../src/email.ts";
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

function smtpMailer(port: number, env: Record<string, string> = {}): Mailer {
  return mailerFor(
    readConfig(
      testEnv({
        AUTH_EMAIL_TRANSPORT: "smtp",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(port),
        SMTP_USERNAME: "apikey",
        SMTP_PASSWORD: "s3cret",
        SMTP_TLS: "none",
        ...env,
      }),
    ),
  )!;
}

const message = {
  to: "admin@example.com",
  subject: "Se connecter à qm",
  text: "plain\n.leading dot",
  html: "<p>rich</p>",
};

function decodedParts(raw: string): string[] {
  return [...raw.matchAll(/Content-Transfer-Encoding: (base64|quoted-printable|7bit)\n\n([\s\S]*?)\n(?:--|$)/g)].map(
    ([, encoding, body]) =>
      encoding === "base64"
        ? Buffer.from(body!.replace(/\n/g, ""), "base64").toString("utf8")
        : body!
            .replace(/=\n/g, "")
            .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
  );
}

test("a message is delivered over the full SMTP conversation as multipart/alternative", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  const receipt = await smtpMailer(server.port).send(message);
  assert.match(receipt, /queued as FAKE1/);
  assert.deepEqual(
    server.transcript.map((line) => line.split(" ")[0]).filter((verb) => verb !== "QUIT"),
    ["EHLO", "AUTH", "MAIL", "RCPT", "DATA"],
  );
  assert.equal(
    Buffer.from(server.transcript[1]!.slice("AUTH PLAIN ".length), "base64").toString("utf8"),
    "\0apikey\0s3cret",
  );
  const raw = server.messages[0]!;
  assert.match(raw, /^Content-Type: multipart\/alternative;/m);
  assert.match(raw, /^Auto-Submitted: auto-generated$/m);
  assert.match(raw, /^Subject: =\?UTF-8\?/m);
  assert.deepEqual(decodedParts(raw), ["plain\n.leading dot", "<p>rich</p>"]);
});

test("header injection through the subject or recipient is neutralised", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  await smtpMailer(server.port)
    .send({
      ...message,
      to: "admin@example.com\r\nBcc: attacker@evil.test",
      subject: "Sign in\r\nBcc: attacker@evil.test",
    })
    .catch(() => undefined);
  assert.ok(server.transcript.every((line) => !line.includes("attacker@evil.test") || !line.startsWith("RCPT")));
  assert.ok(server.messages.every((raw) => !/^Bcc:/im.test(raw)));
});

test("a rejected recipient and rejected credentials both surface as errors", async (t) => {
  const rejecting = await fakeSmtp({ rejectRecipient: true });
  t.after(() => rejecting.close());
  await assert.rejects(() => smtpMailer(rejecting.port).send(message), /550/);

  const unauthorized = await fakeSmtp({ rejectAuth: true });
  t.after(() => unauthorized.close());
  await assert.rejects(() => smtpMailer(unauthorized.port).verify(), /535/);
});

test("verification authenticates without sending a message", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  assert.match(await smtpMailer(server.port).verify(), /authenticated/);
  assert.deepEqual(
    server.transcript.map((line) => line.split(" ")[0]).filter((verb) => verb !== "QUIT"),
    ["EHLO", "AUTH"],
  );
  assert.equal(server.messages.length, 0);
});

test("STARTTLS mode refuses a server that does not advertise STARTTLS", async (t) => {
  const server = await fakeSmtp({ offerStartTls: false });
  t.after(() => server.close());
  await assert.rejects(() => smtpMailer(server.port, { SMTP_TLS: "starttls" }).verify());
  assert.ok(server.transcript.every((line) => !line.startsWith("AUTH")));
});

test("a connection refusal is reported rather than hanging", async () => {
  await assert.rejects(() => smtpMailer(1).verify());
});
