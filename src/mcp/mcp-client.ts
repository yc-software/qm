import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

const TOKEN_SKEW_MS = 60_000;
const MCP_ACCEPT = "application/json, text/event-stream";
const MAX_MCP_RESPONSE_CHARS = 1_000_000;
const MAX_TOKEN_RESPONSE_CHARS = 65_536;
const MCP_REQUEST_TIMEOUT_MS = 15_000;
const MAX_INPUT_SCHEMA_CHARS = 100_000;
const MAX_INPUT_SCHEMA_NODES = 5_000;

export function createPinnedMcpLookup(address: string): LookupFunction {
  const family = isIP(address);
  if (family === 0) throw new Error("MCP request requires a pinned public address");
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

interface McpHttpResponse {
  ok: boolean;
  status: number;
  redirected?: boolean;
  url?: string;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export type McpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    redirect: "manual";
    resolvedAddress?: string;
    resolvedAddresses?: readonly string[];
    maxResponseBytes: number;
    timeoutMs: number;
  },
) => Promise<McpHttpResponse>;

export type McpResolveHost = (hostname: string) => Promise<string[]>;

const realFetch: McpFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    if (
      !init.resolvedAddress ||
      !init.resolvedAddresses?.length ||
      !init.resolvedAddresses.includes(init.resolvedAddress) ||
      init.resolvedAddresses.some((address) => !isPublicMcpAddress(address))
    ) {
      return reject(new Error("MCP request requires an all-public DNS pin"));
    }
    let pinnedLookup: LookupFunction;
    try {
      pinnedLookup = createPinnedMcpLookup(init.resolvedAddress);
    } catch (error) {
      return reject(error);
    }
    const req = httpsRequest(
      target,
      {
        method: init.method,
        headers: init.headers,
        servername: target.hostname,
        family: isIP(init.resolvedAddress),
        lookup: pinnedLookup,
        agent: false,
      },
      (response) => {
        const remoteAddress = response.socket.remoteAddress;
        if (!remoteAddress || !mcpRemoteAddressMatchesPins(remoteAddress, init.resolvedAddresses!)) {
          clearTimeout(deadline);
          response.destroy();
          req.destroy();
          reject(new Error("MCP connection remote address did not match its DNS pin"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let exceeded = false;
        response.on("data", (chunk: Buffer | string) => {
          if (exceeded) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > init.maxResponseBytes) {
            exceeded = true;
            req.destroy(new Error("MCP response exceeded the size limit"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        response.on("end", () => {
          if (exceeded) return;
          clearTimeout(deadline);
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            status: response.statusCode ?? 0,
            url: target.toString(),
            text: async () => body,
            headers: {
              get(name) {
                const value = response.headers[name.toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : (value ?? null);
              },
            },
          });
        });
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("MCP request timed out")), init.timeoutMs);
    deadline.unref?.();
    req.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    req.end(init.body);
  });
const realResolveHost: McpResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function publicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  const c = parts[2]!;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function publicIpv6(address: string): boolean {
  const source = address.toLowerCase().split("%")[0] ?? "";
  const halves = source.split("::");
  if (halves.length > 2) return false;
  const parseHalf = (value: string) => (value ? value.split(":").map((part) => Number.parseInt(part, 16)) : []);
  const leading = parseHalf(halves[0] ?? "");
  const trailing = parseHalf(halves[1] ?? "");
  const omitted = 8 - leading.length - trailing.length;
  if (omitted < 0 || (halves.length === 1 && omitted !== 0)) return false;
  const words = [...leading, ...Array.from({ length: omitted }, () => 0), ...trailing];
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return false;
  const prefix = (expected: number[], bits: number) => {
    const whole = Math.floor(bits / 16);
    const remainder = bits % 16;
    for (let index = 0; index < whole; index += 1) if (words[index] !== expected[index]) return false;
    if (remainder === 0) return true;
    const mask = (0xffff << (16 - remainder)) & 0xffff;
    return ((words[whole] ?? 0) & mask) === ((expected[whole] ?? 0) & mask);
  };
  if (!prefix([0x2000], 3)) return false;
  if (prefix([0x2001, 0], 23)) return false;
  if (prefix([0x2001, 0x0db8], 32)) return false;
  if (prefix([0x2002], 16)) return false;
  if (prefix([0x2620, 0x004f, 0x8000], 48)) return false;
  if (prefix([0x3fff, 0], 20)) return false;
  return true;
}

export function isPublicMcpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

function comparableAddress(address: string): string {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return mapped[1];
  if (isIP(normalized) === 6) return new URL(`https://[${normalized}]/`).hostname.slice(1, -1);
  return normalized;
}

export function mcpRemoteAddressMatchesPins(remoteAddress: string, pins: readonly string[]): boolean {
  const remote = comparableAddress(remoteAddress);
  return isPublicMcpAddress(remote) && pins.some((pin) => comparableAddress(pin) === remote);
}

export function validateMcpHttpsUrl(value: string, field = "MCP URL"): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid HTTPS URL`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new Error(`${field} must use a public HTTPS origin without credentials, query, or fragment`);
  }
  return parsed;
}

function baseUrl(mcpUrl: string): string {
  return mcpUrl.replace(/\/+$/g, "").replace(/\/mcp$/g, "");
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function containsSensitiveString(value: unknown, secrets: string[]): boolean {
  if (typeof value === "string") return secrets.some((secret) => secret && value.includes(secret));
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveString(entry, secrets));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) => containsSensitiveString(key, secrets) || containsSensitiveString(entry, secrets),
  );
}

function validAuthText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

const SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const UNSAFE_SCHEMA_PROPERTY_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ROOT_SCHEMA_DIALECTS = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2020-12/schema",
]);

function safeSchemaLiteral(value: unknown): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= 2_048 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseMcpInputSchema(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = { ...(value as Record<string, unknown>) };
  if (Object.hasOwn(root, "$schema")) {
    if (typeof root.$schema !== "string" || !ROOT_SCHEMA_DIALECTS.has(root.$schema)) return null;
    delete root.$schema;
  }
  const seen = new Set<object>();
  let nodes = 0;
  const valid = (node: unknown, depth: number): boolean => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 20 || ++nodes > MAX_INPUT_SCHEMA_NODES) {
      return false;
    }
    if (seen.has(node)) return false;
    seen.add(node);
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const schema = node as Record<string, unknown>;
    if (Object.keys(schema).some((key) => !SCHEMA_KEYS.has(key))) return false;
    if (typeof schema.type !== "string" || !SCHEMA_TYPES.has(schema.type)) return false;
    if (
      (schema.description !== undefined &&
        (typeof schema.description !== "string" ||
          schema.description.length > 2_048 ||
          /[\u0000-\u001f\u007f]/.test(schema.description))) ||
      (schema.title !== undefined &&
        (typeof schema.title !== "string" || schema.title.length > 256 || /[\u0000-\u001f\u007f]/.test(schema.title)))
    ) {
      return false;
    }
    if (schema.properties !== undefined) {
      if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") return false;
      if (Array.isArray(schema.properties)) return false;
      const properties = schema.properties as Record<string, unknown>;
      if (Object.keys(properties).length > 256) return false;
      for (const [key, child] of Object.entries(properties)) {
        if (UNSAFE_SCHEMA_PROPERTY_KEYS.has(key) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key) || !valid(child, depth + 1)) {
          return false;
        }
      }
    }
    if (schema.required !== undefined) {
      if (
        schema.type !== "object" ||
        !Array.isArray(schema.required) ||
        schema.required.length > 256 ||
        schema.required.some((entry) => typeof entry !== "string" || !Object.hasOwn(schema.properties ?? {}, entry)) ||
        new Set(schema.required).size !== schema.required.length
      ) {
        return false;
      }
    }
    if (
      schema.additionalProperties !== undefined &&
      (schema.type !== "object" || typeof schema.additionalProperties !== "boolean")
    ) {
      return false;
    }
    if (schema.items !== undefined && (schema.type !== "array" || !valid(schema.items, depth + 1))) return false;
    if (
      schema.enum !== undefined &&
      (!Array.isArray(schema.enum) ||
        schema.enum.length < 1 ||
        schema.enum.length > 64 ||
        schema.enum.some((entry) => !safeSchemaLiteral(entry) || !literalMatches(schema.type as string, entry)))
    ) {
      return false;
    }
    if (
      schema.const !== undefined &&
      (!safeSchemaLiteral(schema.const) || !literalMatches(schema.type, schema.const))
    ) {
      return false;
    }
    if (
      schema.default !== undefined &&
      (!safeSchemaLiteral(schema.default) || !literalMatches(schema.type, schema.default))
    ) {
      return false;
    }
    for (const field of ["minimum", "maximum"] as const) {
      if (
        schema[field] !== undefined &&
        (!new Set(["number", "integer"]).has(schema.type) ||
          typeof schema[field] !== "number" ||
          !Number.isFinite(schema[field]))
      ) {
        return false;
      }
    }
    for (const field of ["minLength", "maxLength"] as const) {
      if (
        schema[field] !== undefined &&
        (schema.type !== "string" || !Number.isSafeInteger(schema[field]) || (schema[field] as number) < 0)
      ) {
        return false;
      }
    }
    for (const field of ["minItems", "maxItems"] as const) {
      if (
        schema[field] !== undefined &&
        (schema.type !== "array" || !Number.isSafeInteger(schema[field]) || (schema[field] as number) < 0)
      ) {
        return false;
      }
    }
    if (
      (typeof schema.minimum === "number" && typeof schema.maximum === "number" && schema.minimum > schema.maximum) ||
      (typeof schema.minLength === "number" &&
        typeof schema.maxLength === "number" &&
        schema.minLength > schema.maxLength) ||
      (typeof schema.minItems === "number" && typeof schema.maxItems === "number" && schema.minItems > schema.maxItems)
    ) {
      return false;
    }
    return true;
  };
  if (!valid(root, 0) || root.type !== "object") return null;
  const encoded = JSON.stringify(root);
  return encoded.length <= MAX_INPUT_SCHEMA_CHARS ? (JSON.parse(encoded) as Record<string, unknown>) : null;
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth > 20 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((entry) => jsonValue(entry, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(
    ([key, entry]) => !UNSAFE_SCHEMA_PROPERTY_KEYS.has(key) && jsonValue(entry, depth + 1),
  );
}

function literalMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return type === "object"
    ? !!value && typeof value === "object" && !Array.isArray(value)
    : type === "array" && Array.isArray(value);
}

function sameLiteral(left: unknown, right: unknown): boolean {
  return left === right;
}

export function validateMcpToolArguments(
  schema: Record<string, unknown>,
  value: unknown,
): value is Record<string, unknown> {
  const validate = (node: Record<string, unknown>, input: unknown, depth: number): boolean => {
    if (depth > 20 || typeof node.type !== "string" || !literalMatches(node.type, input)) return false;
    if (node.const !== undefined && !sameLiteral(input, node.const)) return false;
    if (Array.isArray(node.enum) && !node.enum.some((entry) => sameLiteral(input, entry))) return false;
    if (typeof input === "string") {
      const length = [...input].length;
      if (typeof node.minLength === "number" && length < node.minLength) return false;
      if (typeof node.maxLength === "number" && length > node.maxLength) return false;
    }
    if (typeof input === "number") {
      if (typeof node.minimum === "number" && input < node.minimum) return false;
      if (typeof node.maximum === "number" && input > node.maximum) return false;
    }
    if (Array.isArray(input)) {
      if (typeof node.minItems === "number" && input.length < node.minItems) return false;
      if (typeof node.maxItems === "number" && input.length > node.maxItems) return false;
      if (node.items && typeof node.items === "object" && !Array.isArray(node.items)) {
        if (!input.every((entry) => validate(node.items as Record<string, unknown>, entry, depth + 1))) return false;
      } else if (!input.every((entry) => jsonValue(entry, depth + 1))) return false;
    }
    if (input && typeof input === "object" && !Array.isArray(input)) {
      if (!jsonValue(input, depth)) return false;
      const properties =
        node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)
          ? (node.properties as Record<string, Record<string, unknown>>)
          : {};
      const required = Array.isArray(node.required) ? node.required : [];
      if (required.some((key) => typeof key !== "string" || !Object.hasOwn(input, key))) return false;
      for (const [key, entry] of Object.entries(input)) {
        const property = properties[key];
        if (property) {
          if (!validate(property, entry, depth + 1)) return false;
        } else if (node.additionalProperties === false) return false;
      }
    }
    return true;
  };
  return validate(schema, value, 0);
}

interface McpEnvelope {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function parseSseEnvelopes(body: string): unknown[] {
  const out: unknown[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    const parsed = safeJson(data);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function validMcpEnvelope(value: unknown, id: unknown): value is McpEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || record.id !== id) return false;
  const hasResult = Object.hasOwn(record, "result");
  const hasError = Object.hasOwn(record, "error");
  if (hasResult === hasError) return false;
  if (!hasError) return Object.keys(record).length === 3;
  const error = record.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const detail = error as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    Object.keys(detail).some((key) => !["code", "message", "data"].includes(key))
  ) {
    return false;
  }
  return (
    Number.isInteger(detail.code) &&
    typeof detail.message === "string" &&
    detail.message.length <= 8_192 &&
    (!Object.hasOwn(detail, "data") || jsonValue(detail.data))
  );
}

function parseMcpEnvelope(text: string, contentType: string | null | undefined, id: unknown): McpEnvelope | null {
  const isSse = !!contentType && contentType.toLowerCase().includes("text/event-stream");
  if (isSse) {
    const envelopes = parseSseEnvelopes(text);
    const matching = envelopes.filter(
      (entry) => !!entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { id?: unknown }).id === id,
    );
    return matching.length === 1 && validMcpEnvelope(matching[0], id) ? matching[0] : null;
  }
  const parsed = safeJson(text);
  return validMcpEnvelope(parsed, id) ? parsed : null;
}

type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name: string };

export interface McpToolResult {
  content: McpToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function validAnnotations(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const annotations = value as Record<string, unknown>;
  if (annotations.audience !== undefined) {
    if (
      !Array.isArray(annotations.audience) ||
      annotations.audience.some((entry) => entry !== "user" && entry !== "assistant")
    ) {
      return false;
    }
  }
  if (
    annotations.priority !== undefined &&
    (typeof annotations.priority !== "number" ||
      !Number.isFinite(annotations.priority) ||
      annotations.priority < 0 ||
      annotations.priority > 1)
  ) {
    return false;
  }
  if (
    annotations.lastModified !== undefined &&
    (typeof annotations.lastModified !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(annotations.lastModified) ||
      !Number.isFinite(Date.parse(annotations.lastModified)))
  ) {
    return false;
  }
  return jsonValue(annotations);
}

function validBase64(value: unknown): value is string {
  return (
    typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?|)$/.test(value)
  );
}

function validContentMeta(value: unknown): boolean {
  return value === undefined || (!!value && typeof value === "object" && !Array.isArray(value) && jsonValue(value));
}

function validMcpToolContent(value: unknown): value is McpToolContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const content = value as Record<string, unknown>;
  if (!validAnnotations(content.annotations) || !validContentMeta(content._meta)) return false;
  if (content.type === "text") return typeof content.text === "string";
  if (content.type === "image" || content.type === "audio") {
    return validBase64(content.data) && typeof content.mimeType === "string";
  }
  if (content.type === "resource") {
    if (!content.resource || typeof content.resource !== "object" || Array.isArray(content.resource)) return false;
    const resource = content.resource as Record<string, unknown>;
    const hasText = typeof resource.text === "string";
    const hasBlob = validBase64(resource.blob);
    return (
      typeof resource.uri === "string" &&
      hasText !== hasBlob &&
      (resource.mimeType === undefined || typeof resource.mimeType === "string") &&
      validContentMeta(resource._meta)
    );
  }
  if (content.type !== "resource_link" || typeof content.uri !== "string" || typeof content.name !== "string") {
    return false;
  }
  if (
    (content.title !== undefined && typeof content.title !== "string") ||
    (content.description !== undefined && typeof content.description !== "string") ||
    (content.mimeType !== undefined && typeof content.mimeType !== "string") ||
    (content.size !== undefined && (typeof content.size !== "number" || !Number.isFinite(content.size)))
  ) {
    return false;
  }
  if (content.icons !== undefined) {
    if (
      !Array.isArray(content.icons) ||
      content.icons.some(
        (icon) =>
          !icon ||
          typeof icon !== "object" ||
          Array.isArray(icon) ||
          typeof (icon as Record<string, unknown>).src !== "string" ||
          ((icon as Record<string, unknown>).mimeType !== undefined &&
            typeof (icon as Record<string, unknown>).mimeType !== "string") ||
          ((icon as Record<string, unknown>).sizes !== undefined &&
            (!Array.isArray((icon as Record<string, unknown>).sizes) ||
              ((icon as Record<string, unknown>).sizes as unknown[]).some((size) => typeof size !== "string"))) ||
          ((icon as Record<string, unknown>).theme !== undefined &&
            !["light", "dark"].includes((icon as Record<string, unknown>).theme as string)),
      )
    ) {
      return false;
    }
  }
  return true;
}

function decodeMcpToolResult(value: unknown): McpToolResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const content = result.content === undefined ? [] : result.content;
  if (!Array.isArray(content) || content.length > 1_024 || !content.every(validMcpToolContent)) return null;
  if (result.isError !== undefined && typeof result.isError !== "boolean") return null;
  if (
    result.structuredContent !== undefined &&
    (!result.structuredContent ||
      typeof result.structuredContent !== "object" ||
      Array.isArray(result.structuredContent) ||
      !jsonValue(result.structuredContent))
  ) {
    return null;
  }
  return {
    content,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent as Record<string, unknown> }),
  };
}

export function mcpResultText(result: McpToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c?.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("\n")
    .trim();
}

export interface McpRemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

export type McpAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | {
      mode: "client-credentials";
      clientId: string;
      clientSecret: string;
      tokenUrl: string;
      audience: string;
      tokenAuthMethod: "client_secret_basic" | "client_secret_post";
      tokenAudienceParameter: "audience" | "resource";
      scopes: string[];
    };

export interface McpClient {
  readonly base: string;
  readonly host: string;
  listTools(): Promise<McpRemoteTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    beforeDispatch?: () => Promise<string | undefined>,
  ): Promise<McpToolResult>;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export function createMcpClient(opts: {
  url: string;
  auth: McpAuth;
  fetchImpl?: McpFetch;
  resolveHost?: McpResolveHost;
  now?: () => number;
  requestTimeoutMs?: number;
}): McpClient {
  const fetchImpl = opts.fetchImpl ?? realFetch;
  const resolveHost = opts.resolveHost ?? (opts.fetchImpl ? undefined : realResolveHost);
  const now = opts.now ?? (() => Date.now());
  const requestTimeoutMs = opts.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MCP_REQUEST_TIMEOUT_MS) {
    throw new Error("MCP request timeout is invalid");
  }
  const base = baseUrl(opts.url);
  validateMcpHttpsUrl(`${base}/mcp`);
  if (opts.auth.mode === "bearer" && !validAuthText(opts.auth.token, 16_384)) {
    throw new Error("MCP bearer token is required and must be bounded text");
  }
  if (opts.auth.mode === "client-credentials") {
    validateMcpHttpsUrl(opts.auth.tokenUrl, "MCP token URL");
    if (!validAuthText(opts.auth.clientId, 512) || !validAuthText(opts.auth.clientSecret, 16_384)) {
      throw new Error("MCP client credentials are required and must be bounded text");
    }
    if (!opts.auth.audience || opts.auth.audience.length > 2_048 || /[\u0000-\u001f\u007f]/.test(opts.auth.audience)) {
      throw new Error("MCP OAuth audience is required and must be bounded text");
    }
    if (
      !["client_secret_basic", "client_secret_post"].includes(opts.auth.tokenAuthMethod) ||
      !["audience", "resource"].includes(opts.auth.tokenAudienceParameter)
    ) {
      throw new Error("MCP OAuth token auth method and audience parameter are required");
    }
    if (
      !Array.isArray(opts.auth.scopes) ||
      opts.auth.scopes.length > 64 ||
      new Set(opts.auth.scopes).size !== opts.auth.scopes.length ||
      opts.auth.scopes.some((scope) => !/^[A-Za-z0-9:._/-]{1,128}$/.test(scope))
    ) {
      throw new Error("MCP OAuth scopes are invalid");
    }
  }
  const host = hostOf(base);
  let cached: CachedToken | null = null;
  let minting: Promise<string> | null = null;
  let rpcId = 0;

  async function withinDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("MCP request timed out");
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("MCP request timed out")), remaining);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function request(
    url: string,
    init: Omit<
      Parameters<McpFetch>[1],
      "redirect" | "resolvedAddress" | "resolvedAddresses" | "maxResponseBytes" | "timeoutMs"
    >,
    maximumChars: number,
    beforeDispatch?: () => Promise<string | undefined>,
  ): Promise<McpHttpResponse> {
    const deadlineAt = Date.now() + requestTimeoutMs;
    const parsed = validateMcpHttpsUrl(url);
    const target = parsed.toString();
    let resolvedAddress: string | undefined;
    let resolvedAddresses: string[] | undefined;
    if (resolveHost) {
      const addresses = await withinDeadline(resolveHost(parsed.hostname), deadlineAt);
      if (!addresses.length || addresses.some((address) => !isPublicMcpAddress(address))) {
        throw new Error(`MCP endpoint ${parsed.hostname} did not resolve to public addresses`);
      }
      resolvedAddresses = [...new Set(addresses)];
      resolvedAddress = resolvedAddresses[0];
    }
    const authorityToken = beforeDispatch ? await withinDeadline(beforeDispatch(), deadlineAt) : undefined;
    if (
      authorityToken !== undefined &&
      (!/^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{80,128}$/.test(authorityToken) || authorityToken.length > 6_144)
    ) {
      throw new Error("MCP authority token is invalid");
    }
    const response = await withinDeadline(
      fetchImpl(target, {
        ...init,
        headers: {
          ...init.headers,
          ...(authorityToken ? { "x-risely-qm-authority": authorityToken } : {}),
        },
        redirect: "manual",
        maxResponseBytes: maximumChars * 4,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
        ...(resolvedAddress ? { resolvedAddress } : {}),
        ...(resolvedAddresses ? { resolvedAddresses } : {}),
      }),
      deadlineAt,
    );
    if (
      response.redirected === true ||
      (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== target)
    ) {
      throw new Error("MCP redirects are not allowed");
    }
    return {
      ok: response.ok,
      status: response.status,
      ...(response.redirected === undefined ? {} : { redirected: response.redirected }),
      ...(response.url === undefined ? {} : { url: response.url }),
      ...(response.headers === undefined ? {} : { headers: response.headers }),
      text: () => withinDeadline(response.text(), deadlineAt),
    };
  }

  async function boundedText(response: McpHttpResponse, maximum: number): Promise<string> {
    const text = await response.text();
    if (text.length > maximum) throw new Error("MCP response exceeded the size limit");
    return text;
  }

  async function mintToken(auth: Extract<McpAuth, { mode: "client-credentials" }>): Promise<string> {
    if (cached && now() < cached.expiresAt - TOKEN_SKEW_MS) return cached.accessToken;
    if (minting) return minting;
    minting = (async () => {
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        [auth.tokenAudienceParameter]: auth.audience,
        scope: auth.scopes.join(" "),
      });
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      };
      if (auth.tokenAuthMethod === "client_secret_basic") {
        headers.authorization = `Basic ${Buffer.from(
          `${formEncode(auth.clientId)}:${formEncode(auth.clientSecret)}`,
        ).toString("base64")}`;
      } else {
        form.set("client_id", auth.clientId);
        form.set("client_secret", auth.clientSecret);
      }
      const res = await request(
        auth.tokenUrl,
        { method: "POST", headers, body: form.toString() },
        MAX_TOKEN_RESPONSE_CHARS,
      );
      if (!res.ok) throw new Error(`mcp token mint failed (HTTP ${res.status})`);
      const responseText = await boundedText(res, MAX_TOKEN_RESPONSE_CHARS);
      if (responseText.includes(auth.clientSecret)) throw new Error("mcp token mint returned credential material");
      const parsedToken = safeJson(responseText);
      if (containsSensitiveString(parsedToken, [auth.clientSecret])) {
        throw new Error("mcp token mint returned credential material");
      }
      const body = (parsedToken ?? {}) as {
        access_token?: unknown;
        expires_in?: unknown;
        token_type?: unknown;
      };
      const accessToken = typeof body.access_token === "string" ? body.access_token : "";
      if (!validAuthText(accessToken, 16_384) || String(body.token_type).toLowerCase() !== "bearer") {
        throw new Error("mcp token mint returned no usable Bearer access_token");
      }
      const expiresIn =
        typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
          ? Math.min(body.expires_in, 7 * 24 * 60 * 60)
          : 0;
      cached = { accessToken, expiresAt: now() + expiresIn * 1000 };
      return accessToken;
    })();
    try {
      return await minting;
    } finally {
      minting = null;
    }
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const auth = opts.auth;
    if (auth.mode === "none") return {};
    if (auth.mode === "bearer") return { authorization: `Bearer ${auth.token}` };
    return { authorization: `Bearer ${await mintToken(auth)}` };
  }

  async function rpc(
    method: string,
    params: Record<string, unknown>,
    beforeDispatch?: () => Promise<string | undefined>,
  ): Promise<unknown> {
    const id = ++rpcId;
    const headers = await authHeaders();
    const res = await request(
      `${base}/mcp`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: MCP_ACCEPT,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      },
      MAX_MCP_RESPONSE_CHARS,
      beforeDispatch,
    );
    if (!res.ok) throw new Error(`mcp ${method} failed (HTTP ${res.status})`);
    const responseText = await boundedText(res, MAX_MCP_RESPONSE_CHARS);
    const bearer = headers.authorization?.replace(/^Bearer /, "");
    if (bearer && responseText.includes(bearer)) throw new Error(`mcp ${method} returned credential material`);
    const parsed = parseMcpEnvelope(responseText, res.headers?.get("content-type"), id);
    if (!parsed) throw new Error(`mcp ${method} returned an invalid response envelope`);
    if (bearer && containsSensitiveString(parsed, [bearer])) {
      throw new Error(`mcp ${method} returned credential material`);
    }
    if (parsed.error) throw new Error(`mcp ${method} error: ${parsed.error.message ?? "unknown"}`);
    return parsed.result;
  }

  return {
    base,
    host,
    async listTools() {
      const result = await rpc("tools/list", {});
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("mcp tools/list returned an invalid result");
      }
      const listing = result as { tools?: unknown; nextCursor?: unknown };
      if (!Array.isArray(listing.tools) || listing.nextCursor !== undefined) {
        throw new Error("mcp tools/list returned an invalid or incomplete result");
      }
      const out: McpRemoteTool[] = [];
      for (const raw of listing.tools) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error("mcp tools/list returned an invalid tool contract");
        }
        const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown };
        if (
          typeof t.name !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(t.name) ||
          (t.description !== undefined &&
            (typeof t.description !== "string" ||
              t.description.length > 8_192 ||
              /[\u0000-\u001f\u007f]/.test(t.description)))
        ) {
          throw new Error("mcp tools/list returned an invalid tool contract");
        }
        const inputSchema = parseMcpInputSchema(t.inputSchema);
        if (!inputSchema) throw new Error("mcp tools/list returned an unsafe input schema");
        const annotations =
          t.annotations && typeof t.annotations === "object" && !Array.isArray(t.annotations)
            ? (t.annotations as Record<string, unknown>)
            : {};
        out.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema,
          readOnlyHint: annotations.readOnlyHint === true,
          destructiveHint: annotations.destructiveHint !== false,
        });
      }
      return out;
    },
    async callTool(name, args, beforeDispatch) {
      const result = await rpc("tools/call", { name, arguments: args }, beforeDispatch);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error(`mcp tool ${name} returned an invalid result`);
      }
      const typed = decodeMcpToolResult(result);
      if (!typed) {
        throw new Error(`mcp tool ${name} returned an invalid result`);
      }
      if (typed.isError) throw new Error(`mcp tool ${name} error: ${mcpResultText(typed) || "(no detail)"}`);
      return typed;
    },
  };
}
