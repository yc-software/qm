import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export type SmtpTlsMode = "starttls" | "implicit" | "none";

export interface SmtpOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: SmtpTlsMode;
  timeoutMs?: number;
}

interface SmtpReply {
  code: number;
  text: string;
}

export interface SmtpDelivery {
  from: string;
  to: string;
  data: string;
}

const CRLF = "\r\n";

export function takeReply(buffer: string): { code: number; text: string; rest: string } | null {
  const lines: string[] = [];
  let cursor = 0;
  for (;;) {
    const end = buffer.indexOf(CRLF, cursor);
    if (end === -1) return null;
    const line = buffer.slice(cursor, end);
    cursor = end + CRLF.length;
    if (!/^\d{3}[ -]/.test(line)) return null;
    lines.push(line.slice(4));
    if (line[3] === " ") return { code: Number(line.slice(0, 3)), text: lines.join("\n"), rest: buffer.slice(cursor) };
  }
}

export function dotStuff(data: string): string {
  return data.replace(/\r\n/g, "\n").replace(/\n/g, CRLF).replace(/^\./gm, "..");
}

class SmtpSession {
  private buffer = "";
  private waiter: { resolve: (reply: SmtpReply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private socket: Socket;
  private readonly timeoutMs: number;

  constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    socket.setTimeout(this.timeoutMs);
    socket.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    socket.on("error", (e: Error) => this.fail(e));
    socket.on("timeout", () => this.fail(new Error("SMTP timed out")));
    socket.on("close", () => this.fail(new Error("SMTP connection closed")));
  }

  private detach(socket: Socket): void {
    for (const event of ["data", "error", "timeout", "close"]) socket.removeAllListeners(event);
  }

  private fail(e: Error): void {
    this.failure ??= e;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(e);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const reply = takeReply(this.buffer);
    if (!reply) return;
    this.buffer = reply.rest;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve({ code: reply.code, text: reply.text });
  }

  private read(): Promise<SmtpReply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  async expect(expected: readonly number[], what: string): Promise<SmtpReply> {
    const reply = await this.read();
    if (!expected.includes(reply.code))
      throw new Error(`SMTP ${what} rejected: ${reply.code} ${reply.text.split("\n")[0] ?? ""}`);
    return reply;
  }

  async command(
    line: string,
    expected: readonly number[],
    label = line.split(" ")[0] ?? "command",
  ): Promise<SmtpReply> {
    this.socket.write(`${line}${CRLF}`);
    return this.expect(expected, label);
  }

  write(payload: string): void {
    this.socket.write(payload);
  }

  async upgrade(host: string): Promise<void> {
    if (this.buffer.length > 0)
      throw new Error("SMTP server sent data before the TLS handshake — refusing to continue");
    const plain = this.socket;
    this.detach(plain);
    const secure = tlsConnect({ socket: plain, servername: host }) as unknown as Socket;
    secure.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", () => resolve());
      secure.once("error", reject);
    });
    this.socket = secure;
    this.attach(secure);
  }

  close(): void {
    this.detach(this.socket);
    this.socket.on("error", () => undefined);
    this.socket.destroy();
  }
}

async function openSocket(options: SmtpOptions, timeoutMs: number): Promise<Socket> {
  const socket =
    options.tls === "implicit"
      ? (tlsConnect({ host: options.host, port: options.port, servername: options.host }) as unknown as Socket)
      : netConnect({ host: options.host, port: options.port });
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SMTP connect to ${options.host}:${options.port} timed out`)),
      timeoutMs,
    );
    socket.once(options.tls === "implicit" ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  socket.removeAllListeners("error");
  return socket;
}

function authSteps(mechanisms: string, username: string, password: string): string[] {
  if (/\bLOGIN\b/i.test(mechanisms))
    return [
      "AUTH LOGIN",
      Buffer.from(username, "utf8").toString("base64"),
      Buffer.from(password, "utf8").toString("base64"),
    ];
  return [`AUTH PLAIN ${Buffer.from(`\0${username}\0${password}`, "utf8").toString("base64")}`];
}

function clientName(host: string): string {
  return /^[A-Za-z0-9.-]+$/.test(host) ? host : "localhost";
}

export async function smtpDeliver(options: SmtpOptions, delivery: SmtpDelivery | null): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const session = new SmtpSession(await openSocket(options, timeoutMs), timeoutMs);
  try {
    await session.expect([220], "greeting");
    let ehlo = await session.command(`EHLO ${clientName(options.host)}`, [250]);
    if (options.tls === "starttls") {
      if (!/\bSTARTTLS\b/i.test(ehlo.text))
        throw new Error("SMTP server does not offer STARTTLS — refusing to send credentials in cleartext");
      await session.command("STARTTLS", [220]);
      await session.upgrade(options.host);
      ehlo = await session.command(`EHLO ${clientName(options.host)}`, [250]);
    }
    if (options.username || options.password) {
      const steps = authSteps(ehlo.text, options.username, options.password);
      for (const [index, step] of steps.entries()) {
        await session.command(step, index === steps.length - 1 ? [235] : [334], "AUTH");
      }
    }
    if (!delivery) {
      await session.command("QUIT", [221]).catch(() => undefined);
      return "authenticated";
    }
    await session.command(`MAIL FROM:<${delivery.from}>`, [250]);
    await session.command(`RCPT TO:<${delivery.to}>`, [250, 251]);
    await session.command("DATA", [354]);
    session.write(`${dotStuff(delivery.data)}${CRLF}.${CRLF}`);
    const accepted = await session.expect([250], "message");
    await session.command("QUIT", [221]).catch(() => undefined);
    return accepted.text.split("\n")[0] ?? "accepted";
  } finally {
    session.close();
  }
}
