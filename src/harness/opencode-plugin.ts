import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin";

type JsonSchema = {
  type?: string | string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  patternProperties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
};

type BridgeTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

type OpenCodeWithParts = {
  info: { role: string; sessionID?: string; [key: string]: unknown };
  parts: unknown[];
};

type SessionContext = {
  proxyHeaders?: Record<string, string>;
  systemPrompt?: string;
  history?: OpenCodeWithParts[];
  messages?: OpenCodeWithParts[];
};

type ToolResponse = {
  output: string;
  terminate?: boolean;
};

function requiredEnv(name: "OPENCODE_BRIDGE_URL" | "OPENCODE_BRIDGE_SECRET"): string {
  const value = globalThis.process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loopbackBridgeUrl(raw: string): URL {
  const url = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || (hostname !== "localhost" && hostname !== "[::1]" && !hostname.startsWith("127."))) {
    throw new Error("OPENCODE_BRIDGE_URL must be an HTTP loopback URL");
  }
  return url;
}

function schemaWithMetadata(schema: JsonSchema, value: any): any {
  let result = value;
  if (schema.description) result = result.describe(schema.description);
  if (schema.default !== undefined) result = result.default(schema.default);
  return result;
}

function union(z: any, members: any[]): any {
  if (members.length === 0) return z.never();
  if (members.length === 1) return members[0];
  return z.union(members);
}

function literal(z: any, value: unknown): any {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return z.literal(value);
  throw new Error(`Unsupported JSON Schema literal: ${JSON.stringify(value)}`);
}

function stringSchema(z: any, schema: JsonSchema): any {
  let value = z.string();
  if (schema.minLength !== undefined) value = value.min(schema.minLength);
  if (schema.maxLength !== undefined) value = value.max(schema.maxLength);
  if (schema.pattern !== undefined) value = value.regex(new RegExp(schema.pattern));
  return value;
}

function numberSchema(z: any, schema: JsonSchema, integer: boolean): any {
  let value = integer ? z.number().int() : z.number();
  if (schema.minimum !== undefined) value = value.min(schema.minimum);
  if (schema.maximum !== undefined) value = value.max(schema.maximum);
  return value;
}

function objectSchema(z: any, schema: JsonSchema): any {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape = Object.fromEntries(
    Object.entries(properties).map(([name, property]) => {
      const value = jsonSchemaToZod(z, property);
      return [name, required.has(name) ? value : value.optional()];
    }),
  );
  const patterns = Object.values(schema.patternProperties ?? {});
  if (Object.keys(properties).length === 0 && patterns.length === 1) {
    return z.record(z.string(), jsonSchemaToZod(z, patterns[0]!));
  }
  const value = z.object(shape);
  if (schema.additionalProperties === false) return value.strict();
  if (typeof schema.additionalProperties === "object")
    return value.catchall(jsonSchemaToZod(z, schema.additionalProperties));
  return value.passthrough();
}

function jsonSchemaToZod(z: any, schema: JsonSchema): any {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives)
    return schemaWithMetadata(
      schema,
      union(
        z,
        alternatives.map((member) => jsonSchemaToZod(z, member)),
      ),
    );
  if (schema.const !== undefined) return schemaWithMetadata(schema, literal(z, schema.const));
  if (schema.enum)
    return schemaWithMetadata(
      schema,
      union(
        z,
        schema.enum.map((member) => literal(z, member)),
      ),
    );
  if (Array.isArray(schema.type)) {
    return schemaWithMetadata(
      schema,
      union(
        z,
        schema.type.map((type) => jsonSchemaToZod(z, { ...schema, type, description: undefined, default: undefined })),
      ),
    );
  }

  let value: any;
  switch (schema.type) {
    case "object":
      value = objectSchema(z, schema);
      break;
    case "array": {
      value = z.array(jsonSchemaToZod(z, schema.items ?? {}));
      if (schema.minItems !== undefined) value = value.min(schema.minItems);
      if (schema.maxItems !== undefined) value = value.max(schema.maxItems);
      break;
    }
    case "string":
      value = stringSchema(z, schema);
      break;
    case "integer":
      value = numberSchema(z, schema, true);
      break;
    case "number":
      value = numberSchema(z, schema, false);
      break;
    case "boolean":
      value = z.boolean();
      break;
    case "null":
      value = z.null();
      break;
    case undefined:
      value = schema.properties || schema.patternProperties ? objectSchema(z, schema) : z.unknown();
      break;
    default:
      throw new Error(`Unsupported JSON Schema type: ${schema.type}`);
  }
  return schemaWithMetadata(schema, value);
}

function argumentShape(z: any, schema: JsonSchema): Record<string, any> {
  if (schema.type !== "object" && !schema.properties) throw new Error("Tool parameters must be an object schema");
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, property]) => {
      const value = jsonSchemaToZod(z, property);
      return [name, required.has(name) ? value : value.optional()];
    }),
  );
}

function sessionIDFromMessages(messages: OpenCodeWithParts[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const sessionID = messages[index]?.info.sessionID;
    if (sessionID) return sessionID;
  }
  return undefined;
}

export function needsHistoryImport(messages: OpenCodeWithParts[], history: OpenCodeWithParts[] | undefined): boolean {
  return history !== undefined && messages.length === 1;
}

const OpenCodeBridgePlugin: Plugin = async ({ client }) => {
  const bridgeUrl = loopbackBridgeUrl(requiredEnv("OPENCODE_BRIDGE_URL"));
  const bridgeSecret = requiredEnv("OPENCODE_BRIDGE_SECRET");

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(new URL(path, bridgeUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${bridgeSecret}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenCode bridge ${path} failed: ${res.status} ${text}`);
    return JSON.parse(text) as T;
  };

  const discovered = await request<BridgeTool[] | { tools: BridgeTool[] }>("definitions");
  const bridgeTools = Array.isArray(discovered) ? discovered : discovered.tools;
  const tools = Object.fromEntries(
    bridgeTools.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        args: argumentShape(tool.schema, definition.parameters),
        async execute(args: Record<string, unknown>, context: ToolContext) {
          const callID = (context as ToolContext & { callID?: string }).callID;
          if (!callID) throw new Error("OpenCode omitted the bridged tool call ID");
          const result = await request<ToolResponse>(`session/${encodeURIComponent(context.sessionID)}/tool`, {
            method: "POST",
            body: JSON.stringify({ tool: definition.name, sessionID: context.sessionID, callID, args }),
          });
          if (result.terminate) {
            await client.session.abort({ path: { id: context.sessionID } }).catch(() => undefined);
          }
          return result.output;
        },
      }),
    ]),
  );

  const sessionContext = async (sessionID: string): Promise<SessionContext> => {
    let error: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await request(`session/${encodeURIComponent(sessionID)}/context`);
      } catch (next) {
        error = next;
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
      }
    }
    throw error;
  };

  return {
    tool: tools,
    "chat.headers": async (input: { sessionID: string }, output: { headers: Record<string, string> }) => {
      const context = await sessionContext(input.sessionID);
      Object.assign(output.headers, context.proxyHeaders ?? {});
    },
    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
      if (!input.sessionID) return;
      const context = await sessionContext(input.sessionID);
      if (context.systemPrompt !== undefined) output.system.splice(0, output.system.length, context.systemPrompt);
    },
    "experimental.chat.messages.transform": async (_input: object, output: { messages: OpenCodeWithParts[] }) => {
      const currentLastUser = output.messages.findLast((message) => message.info.role === "user");
      const sessionID = sessionIDFromMessages(output.messages);
      if (!sessionID || !currentLastUser) return;
      const context = await sessionContext(sessionID);
      const history = context.history ?? context.messages;
      if (needsHistoryImport(output.messages, history)) {
        output.messages.splice(0, output.messages.length, ...(history ?? []), currentLastUser);
      }
      await request(`session/${encodeURIComponent(sessionID)}/capture`, {
        method: "POST",
        body: JSON.stringify({ system: context.systemPrompt ?? "", messages: output.messages }),
      });
    },
  };
};

export default OpenCodeBridgePlugin;
