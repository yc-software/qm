import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { errMessage } from "../util/errors.ts";

export class CodexRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRpcError";
  }
}

type JsonRpcId = number | string;
type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type JsonRpcResultValidator<T> = (value: unknown) => value is T;
const MAX_CANCELLED_REQUEST_IDS = 256;

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const hasId = "id" in message && message.id !== undefined;
  const hasMethod = "method" in message;
  const hasResult = "result" in message;
  const hasError = "error" in message;
  if (!hasId && !hasMethod) return false;
  if (hasId && !isJsonRpcId(message.id)) return false;
  if (hasMethod && typeof message.method !== "string") return false;
  if (hasMethod && (hasResult || hasError)) return false;
  if (!hasMethod && (!hasId || !(hasResult || hasError))) return false;
  if (hasResult && hasError) return false;
  if (hasError) {
    const error = message.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.code !== "number" || typeof errorRecord.message !== "string") return false;
  }
  return true;
}

const CODEX_DIAGNOSTIC_SENSITIVE_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "passphrase",
  "secret",
  "token",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
]);

function diagnosticKeyIsSensitive(key: string): boolean {
  return CODEX_DIAGNOSTIC_SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ""));
}

function redactStructuredDiagnosticsValue(value: unknown, sensitive = false): unknown {
  if (sensitive) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactStructuredDiagnosticsValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactStructuredDiagnosticsValue(item, diagnosticKeyIsSensitive(key)),
    ]),
  );
}

function redactStructuredDiagnostics(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return value;
    return JSON.stringify(redactStructuredDiagnosticsValue(parsed));
  } catch {
    return value;
  }
}

export function redactCodexDiagnostics(value: string): string {
  return redactStructuredDiagnostics(value)
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|credential|credentials|password|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)\[[\s\S]*?(?:\]|$)/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|credential|credentials|password|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)\{[\s\S]*$/gi,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|credential|credentials|password|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)(["'])(?:(?:\\[\s\S])|(?!\2)[\s\S])*(?:\2|$)/gi,
      "$1$2[redacted]$2",
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|credential|credentials|password|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?!(?:["']|\[))[^,\r\n}\]]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:Basic|Digest)\s+\S+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}

export interface CodexAppServerOptions {
  binaryPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onNotification(method: string, params: unknown): void | Promise<void>;
  onRequest(method: string, params: unknown): Promise<unknown>;
}

export class CodexAppServer {
  readonly process: ChildProcess;
  private readonly options: CodexAppServerOptions;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve(value: unknown): void; reject(error: Error): void; validate?: JsonRpcResultValidator<unknown> }
  >();
  private readonly cancelledRequestIds = new Set<JsonRpcId>();
  private writeTail = Promise.resolve();
  private eventTail = Promise.resolve();
  private stderr = "";
  private closed = false;
  private closeError: Error | null = null;
  private readonly processClosed: Promise<void>;

  constructor(options: CodexAppServerOptions) {
    this.options = options;
    this.process = spawn(options.binaryPath, ["app-server"], {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveProcessClosed!: () => void;
    this.processClosed = new Promise<void>((resolve) => {
      resolveProcessClosed = resolve;
    });
    const lines = createInterface({ input: this.process.stdout! });
    lines.on("line", (line) => {
      this.eventTail = this.eventTail
        .then(() => this.receive(line))
        .catch((error) => {
          this.failAll(error instanceof Error ? error : new Error(String(error)));
          this.process.kill("SIGTERM");
        });
    });
    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_384);
    });
    this.process.once("error", (error) => {
      this.closed = true;
      this.closeError = error;
      this.failAll(error);
      resolveProcessClosed();
    });
    this.process.once("close", (code, signal) => {
      this.closed = true;
      const stderr = redactCodexDiagnostics(this.stderr.trim());
      this.closeError = new Error(
        `Codex app-server exited (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr}` : ""}`,
      );
      this.failAll(this.closeError);
      resolveProcessClosed();
    });
  }

  error(): Error | null {
    return this.closeError;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "qm", title: "QM", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await this.notify("initialized");
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  request<T>(method: string, params: unknown, validate: JsonRpcResultValidator<T>, signal?: AbortSignal): Promise<T>;
  request<T>(
    method: string,
    params?: unknown,
    validateOrSignal?: JsonRpcResultValidator<T> | AbortSignal,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const validate = typeof validateOrSignal === "function" ? validateOrSignal : undefined;
    let requestSignal: AbortSignal | undefined;
    if (validate) requestSignal = signal;
    else if (typeof validateOrSignal !== "function") requestSignal = validateOrSignal;
    if (requestSignal?.aborted) return Promise.reject(new Error("Codex app-server request cancelled"));
    const id = this.nextId++;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => {
      rejectResult = reject;
      this.pending.set(id, {
        resolve,
        reject,
        ...(validate ? { validate: validate as JsonRpcResultValidator<unknown> } : {}),
      });
    });
    if (requestSignal) {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        if (this.cancelledRequestIds.size >= MAX_CANCELLED_REQUEST_IDS) {
          this.failAll(new CodexRpcError("Codex app-server exceeded its cancelled request limit"));
          this.process.kill("SIGTERM");
        } else {
          this.cancelledRequestIds.add(id);
        }
        rejectResult(new Error("Codex app-server request cancelled"));
      };
      requestSignal.addEventListener("abort", onAbort, { once: true });
      void result.then(
        () => requestSignal.removeEventListener("abort", onAbort),
        () => requestSignal.removeEventListener("abort", onAbort),
      );
    }
    void this.send({ id, method, ...(params === undefined ? {} : { params }) }).catch((error) => {
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      waiter?.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  async close(): Promise<void> {
    if (this.closed) return await this.processClosed;
    this.closed = true;
    this.process.kill("SIGTERM");
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 2_000);
    await this.processClosed;
    clearTimeout(timer);
  }

  private async receive(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isJsonRpcMessage(parsed)) throw new Error("Codex app-server emitted an invalid JSON-RPC message");
      message = parsed;
    } catch {
      throw new Error(redactCodexDiagnostics(`Codex app-server emitted invalid JSON: ${line.slice(0, 500)}`));
    }
    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) {
        if (this.cancelledRequestIds.delete(message.id)) return;
        throw new CodexRpcError(`Codex app-server sent an unknown response id ${String(message.id)}`);
      }
      this.pending.delete(message.id);
      if ("error" in message) {
        if (!message.error || typeof message.error !== "object") {
          waiter.reject(new CodexRpcError("Codex app-server response has an invalid error"));
          return;
        }
        waiter.reject(
          new CodexRpcError(
            redactCodexDiagnostics(
              `Codex ${message.error.code ?? "error"}: ${message.error.message ?? JSON.stringify(message.error.data)}`,
            ),
          ),
        );
      } else if ("result" in message) {
        if (waiter.validate && !waiter.validate(message.result)) {
          waiter.reject(new CodexRpcError("Codex app-server response has an invalid result"));
          return;
        }
        waiter.resolve(message.result);
      } else waiter.reject(new CodexRpcError("Codex app-server response is missing result or error"));
      return;
    }
    if (!message.method) return;
    if (message.id === undefined) {
      await this.options.onNotification(message.method, message.params);
      return;
    }
    try {
      const result = await this.options.onRequest(message.method, message.params);
      await this.send({ id: message.id, result });
    } catch (error) {
      await this.send({ id: message.id, error: { code: -32000, message: errMessage(error) } });
    }
  }

  private send(message: JsonRpcMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    const operation = this.writeTail.then(async () => {
      if (this.closed || !this.process.stdin?.writable) throw new Error("Codex app-server stdin is closed");
      await new Promise<void>((resolve, reject) => {
        this.process.stdin!.write(line, (error) => (error ? reject(error) : resolve()));
      });
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.cancelledRequestIds.clear();
  }
}
