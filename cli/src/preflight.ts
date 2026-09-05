import { existsSync, readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QmConfig } from "./config.ts";
import { CliError, errMessage, step, warn } from "./log.ts";
import { deploymentSecretValue } from "./util.ts";
import { emailSecretNames, serviceSecretValue } from "./secrets.ts";

const PROBE_TIMEOUT_MS = 10_000;

function versionParts(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

function enginesNodeSpec(packagePath: string): string | undefined {
  if (!existsSync(packagePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { engines?: { node?: string } };
    return parsed.engines?.node;
  } catch {
    return undefined;
  }
}

function cliPackagePath(): string {
  const direct = fileURLToPath(new URL("../package.json", import.meta.url));
  return existsSync(direct) ? direct : fileURLToPath(new URL("../../package.json", import.meta.url));
}

export function nodeEngineProblem(spec: string, source: string, nodeVersion = process.version): string | undefined {
  const minimums = [...spec.matchAll(/>=\s*v?(\d+(?:\.\d+){0,2})/g)].map((match) => match[1]!);
  for (const minimum of minimums) {
    if (!versionAtLeast(nodeVersion, minimum)) {
      return (
        `Node ${nodeVersion} does not satisfy "node": ${JSON.stringify(spec)} required by ${source} — ` +
        `install Node >=${minimum} (e.g. \`nvm install ${minimum.split(".")[0]}\`) and rerun`
      );
    }
  }
  return undefined;
}

export function assertNodeEngine(deploymentDir?: string): void {
  const sources = [
    { path: cliPackagePath(), source: "the qm CLI package" },
    ...(deploymentDir ? [{ path: join(deploymentDir, "package.json"), source: "this deployment directory" }] : []),
  ];
  for (const { path, source } of sources) {
    const spec = enginesNodeSpec(path);
    if (!spec) continue;
    const problem = nodeEngineProblem(spec, `${source} (${path})`);
    if (problem) throw new CliError(problem, { clause: "cli.node-engine" });
  }
}

export async function flySandboxTokenPreflight(
  config: QmConfig,
  secrets: ReadonlyMap<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const app = config.sandbox?.app?.trim();
  if (!app) return;
  const token = deploymentSecretValue("FLY_SANDBOX_API_TOKEN", secrets.get("FLY_SANDBOX_API_TOKEN"))?.trim();
  if (!token) return;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.machines.dev/v1/apps/${encodeURIComponent(app)}`, {
      headers: { authorization: token.startsWith("FlyV1") ? token : `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    warn(`could not verify FLY_SANDBOX_API_TOKEN against Fly app ${app}: ${errMessage(e)} — continuing`);
    return;
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new CliError(
      `FLY_SANDBOX_API_TOKEN cannot access the Fly app ${app} (HTTP ${response.status}) — the app may not exist ` +
        `or the token is scoped elsewhere. Create the app and mint an app-scoped deploy token:\n` +
        `  fly apps create ${app}${config.flyOrg ? ` --org ${config.flyOrg}` : ""}\n` +
        `  fly tokens create deploy -a ${app} -x 8760h`,
      { clause: "sandbox.fly-token" },
    );
  }
  if (!response.ok) {
    warn(`the Fly API returned HTTP ${response.status} while verifying FLY_SANDBOX_API_TOKEN — continuing`);
    return;
  }
  step(`Fly sandbox app ${app}: FLY_SANDBOX_API_TOKEN ok`);
}

type SmtpTlsMode = "starttls" | "implicit" | "none";

export interface SmtpVerifyOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: SmtpTlsMode;
  timeoutMs?: number;
}

export class SmtpRejectedError extends Error {}

function smtpTlsMode(declared: string | undefined, port: number): SmtpTlsMode {
  const mode = declared?.trim().toLowerCase();
  if (mode === "implicit" || mode === "none" || mode === "starttls") return mode;
  return port === 465 ? "implicit" : "starttls";
}

class SmtpProbe {
  private buffer = "";
  private waiter: { resolve: (reply: { code: number; text: string }) => void; reject: (e: Error) => void } | null =
    null;
  private failure: Error | null = null;

  private socket: Socket;

  constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    socket.setTimeout(timeoutMs, () => this.fail(new Error("SMTP timed out")));
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    socket.on("error", (e: Error) => this.fail(e));
    socket.on("close", () => this.fail(new Error("SMTP connection closed")));
  }

  private fail(e: Error): void {
    this.failure ??= e;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(e);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\r\n");
    let text = "";
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]!;
      if (!/^\d{3}[ -]/.test(line)) {
        this.fail(new Error(`SMTP sent an unparseable reply: ${line}`));
        return;
      }
      text += line.slice(4);
      if (line[3] === " ") {
        this.buffer = lines.slice(i + 1).join("\r\n");
        const waiter = this.waiter;
        this.waiter = null;
        waiter?.resolve({ code: Number(line.slice(0, 3)), text });
        return;
      }
      text += "\n";
    }
  }

  read(): Promise<{ code: number; text: string }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  command(line: string): Promise<{ code: number; text: string }> {
    this.socket.write(`${line}\r\n`);
    return this.read();
  }

  async upgrade(host: string): Promise<void> {
    const plain = this.socket;
    for (const event of ["data", "error", "close"]) plain.removeAllListeners(event);
    const secure = tlsConnect({ socket: plain, servername: host }) as unknown as Socket;
    secure.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", () => resolve());
      secure.once("error", reject);
    });
    secure.removeAllListeners("error");
    this.socket = secure;
    this.attach(secure);
  }

  close(): void {
    for (const event of ["data", "error", "close"]) this.socket.removeAllListeners(event);
    this.socket.on("error", () => undefined);
    this.socket.destroy();
  }
}

async function openSmtpSocket(options: SmtpVerifyOptions, timeoutMs: number): Promise<Socket> {
  const socket =
    options.tls === "implicit"
      ? (tlsConnect({ host: options.host, port: options.port, servername: options.host }) as unknown as Socket)
      : netConnect({ host: options.host, port: options.port });
  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SMTP connect to ${options.host}:${options.port} timed out`)),
      timeoutMs,
    );
    socket.once(options.tls === "implicit" ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (e: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    });
  });
}

export async function smtpVerify(options: SmtpVerifyOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const probe = new SmtpProbe(await openSmtpSocket(options, timeoutMs), timeoutMs);
  const expect = (reply: { code: number; text: string }, codes: readonly number[], what: string): void => {
    if (codes.includes(reply.code)) return;
    const detail = `${what}: ${reply.code} ${reply.text.split("\n")[0] ?? ""}`;
    if (reply.code >= 500) throw new SmtpRejectedError(`SMTP rejected ${detail}`);
    throw new Error(`SMTP did not accept ${detail}`);
  };
  try {
    expect(await probe.read(), [220], "greeting");
    let ehlo = await probe.command(`EHLO qm-check`);
    expect(ehlo, [250], "EHLO");
    if (options.tls === "starttls") {
      if (!/\bSTARTTLS\b/i.test(ehlo.text))
        throw new Error("SMTP server does not offer STARTTLS — refusing to send credentials in cleartext");
      expect(await probe.command("STARTTLS"), [220], "STARTTLS");
      await probe.upgrade(options.host);
      ehlo = await probe.command(`EHLO qm-check`);
      expect(ehlo, [250], "EHLO");
    }
    const steps = /\bPLAIN\b/.test(ehlo.text)
      ? [`AUTH PLAIN ${Buffer.from(`\0${options.username}\0${options.password}`, "utf8").toString("base64")}`]
      : [
          "AUTH LOGIN",
          Buffer.from(options.username, "utf8").toString("base64"),
          Buffer.from(options.password, "utf8").toString("base64"),
        ];
    for (const [index, line] of steps.entries()) {
      expect(await probe.command(line), index === steps.length - 1 ? [235] : [334], "AUTH");
    }
    await probe.command("QUIT").catch(() => undefined);
  } finally {
    probe.close();
  }
}

export function emailTransportConfigured(config: QmConfig, secrets: ReadonlyMap<string, string>): boolean {
  const names = emailSecretNames(config);
  return names.length > 0 && names.every((name) => Boolean(serviceSecretValue(config, "auth", name, secrets)?.trim()));
}

export async function emailTransportPreflight(config: QmConfig, secrets: ReadonlyMap<string, string>): Promise<void> {
  if (!config.services.includes("auth")) return;
  const configured = emailTransportConfigured(config, secrets);
  if (!configured) step("sign-in email: disabled; use qm admin-login for administrator access");
  const transport = config.env.auth?.AUTH_EMAIL_TRANSPORT?.trim() === "smtp" ? "smtp" : "resend";
  const value = (name: string): string | undefined =>
    (serviceSecretValue(config, "auth", name, secrets) ?? deploymentSecretValue(name, secrets.get(name)))?.trim();
  if (transport === "resend") {
    const stray = ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"].filter((name) => value(name));
    if (stray.length) {
      warn(
        `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} set but env.auth.AUTH_EMAIL_TRANSPORT is "resend" — ` +
          `the value${stray.length === 1 ? " is" : "s are"} unused; remove ${stray.length === 1 ? "it" : "them"} or set the transport to "smtp"`,
      );
    }
    return;
  }
  if (value("RESEND_API_KEY")) {
    step(
      'RESEND_API_KEY is set but env.auth.AUTH_EMAIL_TRANSPORT is "smtp" — the sign-in broker ignores it; ' +
        "core still uses it to email external-user invitations",
    );
  }
  if (!configured) return;
  const host = value("SMTP_HOST");
  const username = value("SMTP_USERNAME");
  const password = value("SMTP_PASSWORD");
  if (!host || !username || !password) return;
  const port = Number(config.env.auth?.SMTP_PORT ?? 587);
  const tls = smtpTlsMode(config.env.auth?.SMTP_TLS, port);
  try {
    await smtpVerify({ host, port, username, password, tls });
  } catch (e) {
    if (e instanceof SmtpRejectedError) {
      throw new CliError(
        `${errMessage(e)} — ${host}:${port} refused the SMTP_USERNAME/SMTP_PASSWORD credentials; ` +
          `sign-in links cannot be sent until they are fixed`,
        { clause: "auth.smtp-credentials" },
      );
    }
    warn(`could not verify the SMTP credentials against ${host}:${port}: ${errMessage(e)} — continuing`);
    return;
  }
  step(`SMTP relay ${host}:${port}: credentials accepted`);
}
