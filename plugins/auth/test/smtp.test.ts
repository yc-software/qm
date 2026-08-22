import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { dotStuff, smtpDeliver, takeReply } from "../src/smtp.ts";

interface FakeSmtp {
  port: number;
  transcript: string[];
  messages: string[];
  close(): Promise<void>;
}

async function fakeSmtp(
  options: { offerStartTls?: boolean; rejectAuth?: boolean; rejectRecipient?: boolean; mechanisms?: string } = {},
): Promise<FakeSmtp> {
  const transcript: string[] = [];
  const messages: string[] = [];
  const handle = (socket: Socket): void => {
    let buffer = "";
    let inData = false;
    let message = "";
    let authStep: "idle" | "user" | "pass" = "idle";
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
        if (authStep === "user") {
          authStep = "pass";
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (authStep === "pass") {
          authStep = "idle";
          socket.write(options.rejectAuth ? "535 5.7.8 bad credentials\r\n" : "235 2.7.0 Accepted\r\n");
          continue;
        }
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO")
          socket.write(
            `250-fake.smtp.test\r\n${options.offerStartTls ? "250-STARTTLS\r\n" : ""}250 AUTH ${options.mechanisms ?? "PLAIN LOGIN"}\r\n`,
          );
        else if (verb === "AUTH") {
          if (/^AUTH LOGIN$/i.test(line)) {
            authStep = "user";
            socket.write("334 VXNlcm5hbWU6\r\n");
          } else socket.write(options.rejectAuth ? "535 5.7.8 bad credentials\r\n" : "235 2.7.0 Accepted\r\n");
        } else if (verb === "MAIL") socket.write("250 2.1.0 Ok\r\n");
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

const options = (port: number, over: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port,
  username: "apikey",
  password: "s3cret",
  tls: "none" as const,
  timeoutMs: 4000,
  ...over,
});

test("takeReply reassembles a multi-line reply and leaves the remainder", () => {
  const reply = takeReply("250-one\r\n250 two\r\n334 next\r\n");
  assert.deepEqual(reply, { code: 250, text: "one\ntwo", rest: "334 next\r\n" });
  assert.equal(takeReply("250-partial\r\n"), null);
  assert.equal(takeReply("garbage\r\n"), null);
});

test("dotStuff escapes a leading dot and normalises line endings", () => {
  assert.equal(dotStuff("a\n.b\nc"), "a\r\n..b\r\nc");
  assert.equal(dotStuff("a\r\n.\r\nb"), "a\r\n..\r\nb");
});

test("a message is delivered over the full SMTP conversation", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  const receipt = await smtpDeliver(options(server.port), {
    from: "no-reply@example.com",
    to: "admin@example.com",
    data: "Subject: hi\r\n\r\n.leading dot survives",
  });
  assert.match(receipt, /queued as FAKE1/);
  assert.deepEqual(
    server.transcript.map((line) => line.split(" ")[0]),
    ["EHLO", "AUTH", Buffer.from("apikey").toString("base64"), Buffer.from("s3cret").toString("base64"), "MAIL", "RCPT", "DATA", "QUIT"],
  );
  assert.equal(server.transcript[1]!, "AUTH LOGIN");
  assert.match(server.messages[0]!, /^\.leading dot survives$/m);
});

test("AUTH PLAIN is used when the server does not advertise LOGIN", async (t) => {
  const server = await fakeSmtp({ mechanisms: "PLAIN" });
  t.after(() => server.close());
  assert.equal(await smtpDeliver(options(server.port), null), "authenticated");
  assert.match(server.transcript[1]!, /^AUTH PLAIN /);
  assert.equal(
    Buffer.from(server.transcript[1]!.slice("AUTH PLAIN ".length), "base64").toString("utf8"),
    "\0apikey\0s3cret",
  );
});

test("a rejected recipient and rejected credentials both surface as errors", async (t) => {
  const rejecting = await fakeSmtp({ rejectRecipient: true });
  t.after(() => rejecting.close());
  await assert.rejects(
    () =>
      smtpDeliver(options(rejecting.port), {
        from: "no-reply@example.com",
        to: "nobody@example.com",
        data: "Subject: hi\r\n\r\nbody",
      }),
    /SMTP RCPT rejected: 550/,
  );

  const unauthorized = await fakeSmtp({ rejectAuth: true });
  t.after(() => unauthorized.close());
  await assert.rejects(() => smtpDeliver(options(unauthorized.port), null), /SMTP AUTH rejected: 535/);
});

test("verification authenticates without sending a message", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  assert.equal(await smtpDeliver(options(server.port), null), "authenticated");
  assert.deepEqual(
    server.transcript.map((line) => line.split(" ")[0]),
    ["EHLO", "AUTH", Buffer.from("apikey").toString("base64"), Buffer.from("s3cret").toString("base64"), "QUIT"],
  );
  assert.equal(server.messages.length, 0);
});

test("STARTTLS mode refuses a server that does not advertise STARTTLS", async (t) => {
  const server = await fakeSmtp({ offerStartTls: false });
  t.after(() => server.close());
  await assert.rejects(() => smtpDeliver(options(server.port, { tls: "starttls" }), null), /does not offer STARTTLS/);
});

test("a connection refusal is reported rather than hanging", async () => {
  await assert.rejects(() => smtpDeliver(options(1, { timeoutMs: 2000 }), null));
});
