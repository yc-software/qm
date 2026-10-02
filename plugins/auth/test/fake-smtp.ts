import { createServer, type Socket } from "node:net";
import { createServer as createTlsServer, TLSSocket } from "node:tls";

export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
}

export interface FakeSmtp {
  port: number;
  transcript: string[];
  messages: ReceivedMail[];
  tlsClientHello: boolean;
  close(): Promise<void>;
}

export interface FakeSmtpOptions {
  implicitTls?: boolean;
  offerStartTls?: boolean;
  certificate?: { key: string; cert: string };
  password?: string;
  rejectRecipient?: boolean;
}

const TLS_HANDSHAKE_RECORD = 0x16;

export async function fakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const transcript: string[] = [];
  const messages: ReceivedMail[] = [];
  const state = { tlsClientHello: false };
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  };
  const awaitTls = (socket: Socket): void => {
    socket.removeAllListeners("data");
    socket.once("data", (chunk: Buffer) => {
      state.tlsClientHello = chunk[0] === TLS_HANDSHAKE_RECORD;
      socket.destroy();
    });
  };
  const converse = (socket: Socket, secure: boolean): void => {
    let buffer = "";
    let mail: ReceivedMail | null = null;
    let inData = false;
    const reply = (line: string): boolean => socket.write(`${line}\r\n`);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\r\n"); end !== -1; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData && mail) {
          if (line === ".") {
            inData = false;
            messages.push(mail);
            mail = null;
            reply("250 2.0.0 Ok: queued as FAKE1");
          } else mail.data += `${line.startsWith(".") ? line.slice(1) : line}\r\n`;
          continue;
        }
        transcript.push(line);
        const verb = (line.split(" ")[0] ?? "").toUpperCase();
        if (verb === "EHLO") {
          reply("250-fake.smtp.test");
          if (options.offerStartTls && !secure) reply("250-STARTTLS");
          reply("250 AUTH PLAIN LOGIN");
        } else if (verb === "STARTTLS" && options.offerStartTls && !secure) {
          reply("220 2.0.0 Ready to start TLS");
          if (!options.certificate) return awaitTls(socket);
          socket.removeAllListeners("data");
          const upgraded = new TLSSocket(socket, { isServer: true, ...options.certificate });
          track(upgraded);
          converse(upgraded, true);
          return;
        } else if (verb === "AUTH") {
          const decoded = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8");
          reply(
            decoded === `\0apikey\0${options.password ?? "s3cret"}`
              ? "235 2.7.0 Accepted"
              : "535 5.7.8 bad credentials",
          );
        } else if (verb === "MAIL") {
          mail = { from: /<([^>]*)>/.exec(line)?.[1] ?? "", to: [], data: "" };
          reply("250 2.1.0 Ok");
        } else if (verb === "RCPT") {
          if (options.rejectRecipient) reply("550 5.1.1 no such user");
          else {
            mail?.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
            reply("250 2.1.5 Ok");
          }
        } else if (verb === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (verb === "RSET" || verb === "NOOP") reply("250 2.0.0 Ok");
        else if (verb === "QUIT") {
          reply("221 2.0.0 Bye");
          socket.end();
        } else reply("502 5.5.2 not implemented");
      }
    });
  };
  const greet = (socket: Socket, secure: boolean): void => {
    track(socket);
    converse(socket, secure);
    socket.write("220 fake.smtp.test ESMTP\r\n");
  };
  const server =
    options.implicitTls && options.certificate
      ? createTlsServer(options.certificate, (socket) => greet(socket, true))
      : createServer((socket) => {
          if (!options.implicitTls) return greet(socket, false);
          track(socket);
          awaitTls(socket);
        });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    transcript,
    messages,
    get tlsClientHello() {
      return state.tlsClientHello;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export function mimePart(data: string, contentType: string): string {
  const boundary = /boundary="([^"]+)"/.exec(data)?.[1];
  for (const part of boundary ? data.split(`--${boundary}`) : []) {
    const [head = "", ...rest] = part.replace(/^\r\n/, "").split("\r\n\r\n");
    if (!head.toLowerCase().includes(`content-type: ${contentType}`)) continue;
    const body = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    if (/content-transfer-encoding: base64/i.test(head))
      return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
    if (/content-transfer-encoding: quoted-printable/i.test(head))
      return Buffer.from(
        body
          .replace(/=\r\n/g, "")
          .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
        "latin1",
      ).toString("utf8");
    return body;
  }
  throw new Error(`no ${contentType} part in the message`);
}

export function headerOf(data: string, name: string): string[] {
  const head = data.split("\r\n\r\n")[0] ?? "";
  return head
    .replace(/\r\n[ \t]+/g, " ")
    .split("\r\n")
    .filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    .map((line) => line.slice(name.length + 1).trim());
}
