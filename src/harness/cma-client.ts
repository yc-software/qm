const CMA_DEFAULT_BASE_URL = "https://api.anthropic.com";
const CMA_API_VERSION = "2023-06-01";
const CMA_BETA = "managed-agents-2026-04-01";
const CMA_REQUEST_TIMEOUT_MS = 60_000;

export type CmaAuthHeaders = () => Promise<Record<string, string>> | Record<string, string>;

export interface CmaClientOptions {
  auth: CmaAuthHeaders;
  baseUrl?: string;
}

export interface CmaCustomTool {
  type: "custom";
  name: string;
  description: string;
  input_schema: unknown;
}

export type CmaUserContent =
  { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type CmaOutboundEvent =
  | { type: "user.message"; content: CmaUserContent[] }
  | { type: "user.custom_tool_result"; custom_tool_use_id: string; content: Array<{ type: "text"; text: string }> }
  | { type: "user.tool_result"; tool_use_id: string; content: Array<{ type: "text"; text: string }> }
  | { type: "user.interrupt" };

export interface CmaNativeToolset {
  type: "agent_toolset_20260401";
  default_config?: { permission_policy?: { type: string } };
  configs?: Array<{ name: string; enabled: boolean }>;
}

export type CmaSessionTool = CmaCustomTool | CmaNativeToolset;

interface CmaWorkItem {
  type: "work";
  id: string;
  data: { type: string; id: string };
}

interface CmaWorkHeartbeat {
  last_heartbeat?: string;
}

interface CmaStopReason {
  type: string;
  event_ids?: string[];
}

export interface CmaEvent {
  type: string;
  id?: string;
  processed_at?: string;
  content?: Array<{ type: string; text?: string }>;
  thinking?: string;
  name?: string;
  input?: unknown;
  stop_reason?: CmaStopReason;
  error?: { type?: string; message?: string };
  model_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export type CmaStreamFrame =
  | { kind: "start"; eventType: string; eventId: string }
  | { kind: "delta"; eventId: string; text: string }
  | { kind: "event"; event: CmaEvent };

interface CmaSession {
  id: string;
  status: string;
}

interface CmaSessionCreateBody {
  agent: {
    type: "agent_with_overrides";
    id: string;
    system?: string;
    model?: { id: string };
    tools?: CmaSessionTool[];
  };
  environment_id: string;
  metadata?: Record<string, string>;
}

interface CmaAgentModel {
  id: string;
  effort?: string;
}

interface CmaAgent {
  id: string;
}

interface CmaMessageResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export class CmaApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CmaApiError";
    this.status = status;
  }
}

export function cmaBlockText(content: Array<{ type?: string; text?: string }> | undefined): string {
  return (content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function isTerminalCmaStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? "" : decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (done) {
        if (data.length) yield data.join("\n");
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function toStreamFrame(raw: unknown): CmaStreamFrame | null {
  const frame = raw as {
    type?: string;
    event?: { type?: string; id?: string };
    event_id?: string;
    delta?: { type?: string; content?: { type?: string; text?: string } };
  } | null;
  if (!frame || typeof frame.type !== "string") return null;
  if (frame.type === "event_start") {
    if (typeof frame.event?.type !== "string" || typeof frame.event.id !== "string") return null;
    return { kind: "start", eventType: frame.event.type, eventId: frame.event.id };
  }
  if (frame.type === "event_delta") {
    if (typeof frame.event_id !== "string" || typeof frame.delta?.content?.text !== "string") return null;
    return { kind: "delta", eventId: frame.event_id, text: frame.delta.content.text };
  }
  return { kind: "event", event: frame as CmaEvent };
}

export interface CmaClient {
  createAgent(name: string, model: CmaAgentModel): Promise<CmaAgent>;
  archiveAgent(agentId: string): Promise<void>;
  createMessage(
    body: { model: string; system?: string; prompt: string; maxTokens?: number },
    signal?: AbortSignal,
  ): Promise<CmaMessageResult>;
  createSession(body: CmaSessionCreateBody): Promise<CmaSession>;
  getSession(sessionId: string): Promise<CmaSession>;
  updateSessionTools(sessionId: string, tools: CmaSessionTool[]): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  sendEvents(sessionId: string, events: CmaOutboundEvent[]): Promise<void>;
  listEvents(
    sessionId: string,
    opts?: { limit?: number; page?: string },
  ): Promise<{ data: CmaEvent[]; nextPage: string | null }>;
  streamEvents(sessionId: string, opts: { signal: AbortSignal }): Promise<AsyncIterable<CmaStreamFrame>>;
  pollWork(environmentId: string, opts?: { blockMs?: number }): Promise<CmaWorkItem | null>;
  ackWork(environmentId: string, workId: string): Promise<void>;
  heartbeatWork(
    environmentId: string,
    workId: string,
    opts?: { expectedLastHeartbeat?: string },
  ): Promise<CmaWorkHeartbeat>;
  stopWork(environmentId: string, workId: string): Promise<void>;
}

async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<CmaStreamFrame> {
  for await (const data of sseData(body)) {
    const parsed = (() => {
      try {
        return JSON.parse(data) as unknown;
      } catch {
        return null;
      }
    })();
    const frame = toStreamFrame(parsed);
    if (frame) yield frame;
  }
}

export function createCmaClient(options: CmaClientOptions): CmaClient {
  const baseUrl = (options.baseUrl ?? CMA_DEFAULT_BASE_URL).replace(/\/$/, "");

  const headers = async (): Promise<Record<string, string>> => ({
    "anthropic-version": CMA_API_VERSION,
    "anthropic-beta": CMA_BETA,
    "content-type": "application/json",
    ...(await options.auth()),
  });

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    reqOpts?: { beta?: boolean; signal?: AbortSignal },
  ): Promise<unknown> => {
    const timeout = AbortSignal.timeout(CMA_REQUEST_TIMEOUT_MS);
    const sent = await headers();
    if (reqOpts?.beta === false) delete sent["anthropic-beta"];
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: sent,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: reqOpts?.signal ? AbortSignal.any([reqOpts.signal, timeout]) : timeout,
    });
    const text = await response.text();
    if (!response.ok) {
      const parsed = (() => {
        try {
          return JSON.parse(text) as { error?: { message?: string } };
        } catch {
          return null;
        }
      })();
      const message = parsed?.error?.message || text.slice(0, 500) || response.statusText;
      throw new CmaApiError(response.status, `CMA ${method} ${path} failed (${response.status}): ${message}`);
    }
    if (!text) return null;
    return JSON.parse(text);
  };

  return {
    async createAgent(name, model) {
      const body = model.effort ? { name, model } : { name, model: model.id };
      return (await request("POST", "/v1/agents", body)) as CmaAgent;
    },
    async archiveAgent(agentId) {
      await request("POST", `/v1/agents/${encodeURIComponent(agentId)}/archive`);
    },
    async createMessage(body, signal) {
      const parsed = (await request(
        "POST",
        "/v1/messages",
        {
          model: body.model,
          max_tokens: body.maxTokens ?? 8192,
          ...(body.system ? { system: body.system } : {}),
          messages: [{ role: "user", content: body.prompt }],
        },
        { beta: false, ...(signal ? { signal } : {}) },
      )) as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const reply = cmaBlockText(parsed.content);
      const usage =
        typeof parsed.usage?.input_tokens === "number"
          ? { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens ?? 0 }
          : null;
      return { text: reply, usage };
    },
    async createSession(body) {
      return (await request("POST", "/v1/sessions", body)) as CmaSession;
    },
    async getSession(sessionId) {
      return (await request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`)) as CmaSession;
    },
    async updateSessionTools(sessionId, tools) {
      await request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}`, { agent: { tools } });
    },
    async pollWork(environmentId, opts) {
      const query = new URLSearchParams();
      if (opts?.blockMs) query.set("block_ms", String(opts.blockMs));
      const suffix = query.size ? `?${query}` : "";
      const item = (await request(
        "GET",
        `/v1/environments/${encodeURIComponent(environmentId)}/work/poll${suffix}`,
      )) as CmaWorkItem | { type?: string } | null;
      return item?.type === "work" ? (item as CmaWorkItem) : null;
    },
    async ackWork(environmentId, workId) {
      await request(
        "POST",
        `/v1/environments/${encodeURIComponent(environmentId)}/work/${encodeURIComponent(workId)}/ack`,
      );
    },
    async heartbeatWork(environmentId, workId, opts) {
      const query = new URLSearchParams();
      if (opts?.expectedLastHeartbeat) query.set("expected_last_heartbeat", opts.expectedLastHeartbeat);
      const suffix = query.size ? `?${query}` : "";
      return (await request(
        "POST",
        `/v1/environments/${encodeURIComponent(environmentId)}/work/${encodeURIComponent(workId)}/heartbeat${suffix}`,
      )) as CmaWorkHeartbeat;
    },
    async stopWork(environmentId, workId) {
      await request(
        "POST",
        `/v1/environments/${encodeURIComponent(environmentId)}/work/${encodeURIComponent(workId)}/stop`,
        { force: false },
      );
    },
    async deleteSession(sessionId) {
      await request("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`);
    },
    async sendEvents(sessionId, events) {
      await request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/events`, { events });
    },
    async listEvents(sessionId, opts) {
      const query = new URLSearchParams();
      if (opts?.limit) query.set("limit", String(opts.limit));
      if (opts?.page) query.set("page", opts.page);
      const suffix = query.size ? `?${query}` : "";
      const listed = (await request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/events${suffix}`)) as {
        data?: CmaEvent[];
        next_page?: string | null;
      };
      return { data: listed.data ?? [], nextPage: listed.next_page ?? null };
    },
    async streamEvents(sessionId, opts) {
      const suffix = "?event_deltas[]=agent.message";
      const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events/stream${suffix}`, {
        method: "GET",
        headers: { ...(await headers()), accept: "text/event-stream" },
        signal: opts.signal,
      });
      if (!response.ok || !response.body) {
        const text = response.body ? await response.text() : "";
        throw new CmaApiError(
          response.status,
          `CMA event stream failed (${response.status}): ${text.slice(0, 500) || response.statusText}`,
        );
      }
      return frames(response.body);
    },
  };
}
