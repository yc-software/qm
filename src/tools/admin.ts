import { errMessage } from "../util/errors.ts";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";

const string = Type.String();
const optionalString = Type.Optional(string);
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }));
const scope = { scope: string };
const scopedId = { ...scope, id: string };
const object = Type.Record(Type.String(), Type.Unknown());

type Operation = {
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
};

function operation(
  description: string,
  method: Operation["method"],
  path: string,
  properties: Record<string, TSchema> = {},
): Operation {
  return { description, method, path, parameters: Type.Object(properties, { additionalProperties: false }) };
}

export const adminOperations = {
  whoami: operation("Check the requesting person's admin status.", "GET", "/whoami"),
  scopes: operation("Find scopes and their labels; do not guess scope IDs.", "GET", "/scopes"),
  resources: operation("Inspect the existing scope configuration resource manifest.", "GET", "/resources"),
  config: operation("Read a scope's configuration.", "GET", "/scopes/:scope", scope),
  configure: operation(
    "Update one nonsecret configuration resource. Connector and service-credential setters stay on the self-API. Confirm the exact change first. The existing resource validator owns the value shape; read the admin skill for its fields.",
    "PUT",
    "/scopes/:scope/:resource",
    {
      ...scope,
      resource: Type.String({
        description: "Existing resource ID from the resources action; validated by the configuration registry.",
      }),
      value: object,
    },
  ),
  credential_usage: operation(
    "Read a scope's credential usage summary.",
    "GET",
    "/scopes/:scope/credential-usage",
    scope,
  ),
  memory_scopes: operation("List notebook scopes and metadata.", "GET", "/memory/scopes"),
  memory: operation("Read a notebook.", "GET", "/memory", scope),
  add_memory: operation("Add notebook facts after confirming.", "POST", "/memory", {
    ...scope,
    value: Type.Object({ facts: Type.Array(string) }, { additionalProperties: false }),
  }),
  edit_memory: operation(
    "Edit notebook facts by id after reading them and confirming the change.",
    "PATCH",
    "/memory",
    {
      ...scope,
      value: Type.Object(
        { facts: Type.Array(Type.Object({ id: string, text: string }, { additionalProperties: false })) },
        { additionalProperties: false },
      ),
    },
  ),
  delete_memory: operation("Forget notebook facts by id after confirming.", "DELETE", "/memory", {
    ...scope,
    value: Type.Object({ ids: Type.Array(string) }, { additionalProperties: false }),
  }),
  sessions: operation("List conversations using the returned cursor for the next page.", "GET", "/sessions", {
    ...scope,
    category: Type.Optional(
      Type.Union([Type.Literal("conversation"), Type.Literal("background"), Type.Literal("all")]),
    ),
    origin: optionalString,
    cron: optionalString,
    cursor: optionalString,
    limit,
  }),
  session: operation("Read a bounded conversation transcript.", "GET", "/sessions/:id", { ...scopedId, limit }),
  session_llm: operation(
    "Read captured model call metadata. Full request content stays on the self-API for selective sandbox reading.",
    "GET",
    "/sessions/:id/llm",
    scopedId,
  ),
  runs: operation("Read run history.", "GET", "/runs", scope),
  files: operation("List stored files, optionally matching q.", "GET", "/files", { ...scope, q: optionalString }),
  file: operation("Read a stored text file.", "GET", "/files/read", scopedId),
  upload_file: operation("Register an already staged blob as a scope file. Confirm first.", "POST", "/files/upload", {
    ...scope,
    value: Type.Object({ blobId: string, name: string, mimetype: optionalString }, { additionalProperties: false }),
  }),
  crons: operation("List crons belonging to a scope.", "GET", "/crons", scope),
  deployments: operation("List apps belonging to a scope.", "GET", "/deployments", scope),
  skills: operation("List skills belonging to a scope.", "GET", "/skills", scope),
  skill: operation("Read one skill.", "GET", "/skills/:id", scopedId),
  archive_skill: operation("Archive a skill. Confirm first.", "DELETE", "/skills/:id", scopedId),
  cron_runtime: operation("Set a cron runtime, or null to inherit. Confirm first.", "PUT", "/crons/:id/runtime", {
    ...scopedId,
    value: object,
  }),
  cron_destination: operation("Set or clear a cron destination. Confirm first.", "PUT", "/crons/:id/destination", {
    ...scopedId,
    value: object,
  }),
  audit: operation("Read audit events, optionally filtered by auditAction and resource.", "GET", "/audit", {
    ...scope,
    auditAction: optionalString,
    resource: optionalString,
    limit,
  }),
  errors: operation("Read errors with pagination.", "GET", "/errors", {
    ...scope,
    sessionId: optionalString,
    limit,
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  metrics: operation("Read turn metrics.", "GET", "/metrics", scope),
  egress: operation("Read outbound-destination audit.", "GET", "/egress", scope),
  retention: operation("Read usage and retention.", "GET", "/retention"),
  spend: operation("Read spend for a date range.", "GET", "/spend", {
    from: optionalString,
    to: optionalString,
    bucket: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week")])),
    breakdown: optionalString,
  }),
  users: operation("List the organization roster and invited external users.", "GET", "/users"),
  user: operation("Read one person's configuration and status.", "GET", "/users/:id", { id: string }),
  directory: operation("Resolve a person in the directory.", "GET", "/directory", { q: string }),
  keychain: operation("Read keychain metadata, never credential secrets.", "GET", "/keychain", {
    principal: optionalString,
  }),
  invite_external: operation(
    "Invite an external member after confirming recipient and expiry; admin-role invitations remain portal-only.",
    "POST",
    "/external-users",
    {
      value: Type.Object(
        { email: string, expiresAt: Type.Union([string, Type.Number()]) },
        { additionalProperties: false },
      ),
    },
  ),
  revoke_external: operation(
    "Revoke an external member's access. Confirm first; admin-role changes remain portal-only.",
    "DELETE",
    "/external-users/:id",
    { id: string },
  ),
  onboarding: operation("Set a user's onboarding state. Confirm first.", "PUT", "/users/:id/onboarding", {
    id: string,
    value: object,
  }),
  reset_user: operation(
    "Reset a user's onboarding data. Confirm the destructive reset first.",
    "POST",
    "/users/:id/reset",
    { id: string },
  ),
  sandboxes: operation("List a scope's sandboxes.", "GET", "/sandboxes/:scope", scope),
  create_sandbox: operation("Create a sandbox in a scope. Confirm first.", "POST", "/sandboxes/:scope", {
    ...scope,
    value: Type.Object(
      { action: Type.Literal("create"), backend: string, name: optionalString },
      { additionalProperties: false },
    ),
  }),
  sandbox_default: operation(
    "Set a scope's default sandbox, or null to clear. Confirm first.",
    "POST",
    "/sandboxes/:scope",
    {
      ...scope,
      value: Type.Object(
        { action: Type.Literal("default"), sandboxId: Type.Union([string, Type.Null()]) },
        { additionalProperties: false },
      ),
    },
  ),
  retire_sandbox: operation("Retire a scope's sandbox. Confirm first.", "POST", "/sandboxes/:scope", {
    ...scope,
    value: Type.Object({ action: Type.Literal("retire"), sandboxId: string }, { additionalProperties: false }),
  }),
  security_flags: operation("Read security screening flags.", "GET", "/security/flags", { limit }),
  release_security: operation("Release a conversation's security taint. Confirm first.", "POST", "/security/release", {
    value: Type.Object({ sessionId: string }, { additionalProperties: false }),
  }),
  slack_installation: operation("Read Slack installation metadata, never tokens.", "GET", "/slack-installation"),
  slack_start: operation("Start Slack setup or installation. Confirm first.", "POST", "/slack-installation/start", {
    value: Type.Object(
      { step: Type.Union([Type.Literal("setup"), Type.Literal("install")]) },
      { additionalProperties: false },
    ),
  }),
  slack_emoji: operation("List Slack emoji.", "GET", "/slack-emoji"),
  model_providers: operation("Read model-provider metadata.", "GET", "/model-providers"),
  custom_providers: operation("Read custom model-provider metadata.", "GET", "/custom-providers"),
  mcp_servers: operation("Read MCP-server metadata.", "GET", "/mcp-servers"),
  model_registry: operation("Read model definitions.", "GET", "/model-registry"),
  model_lookup: operation("Look up a provider's model definition.", "POST", "/model-registry/lookup", {
    value: Type.Object(
      { provider: Type.Union([Type.Literal("openai"), Type.Literal("anthropic")]), id: string },
      { additionalProperties: false },
    ),
  }),
  model_enable: operation(
    "Verify and enable a model, including a small billable request. Confirm first.",
    "POST",
    "/model-registry/:id/enable",
    {
      id: string,
      value: Type.Object(
        { provider: Type.Union([Type.Literal("openai"), Type.Literal("anthropic")]), verify: Type.Literal(true) },
        { additionalProperties: false },
      ),
    },
  ),
  model_delete: operation("Remove an administrator model definition. Confirm first.", "DELETE", "/model-registry/:id", {
    id: string,
  }),

  slack_delete: operation("Remove Slack installation. Confirm first.", "DELETE", "/slack-installation"),

  model_provider_delete: operation("Remove a provider API key. Confirm first.", "DELETE", "/model-providers/:id", {
    id: string,
  }),

  custom_provider_delete: operation("Remove a custom provider. Confirm first.", "DELETE", "/custom-providers/:id", {
    id: string,
  }),

  mcp_delete: operation("Remove an MCP server. Confirm first.", "DELETE", "/mcp-servers/:id", { id: string }),
  model_save: operation(
    "Save a model definition using the existing model spec validator. Requires verify:true and confirmation for the billable verification request.",
    "PUT",
    "/model-registry/:id",
    { id: string, value: object },
  ),
  auto_flagger_test: operation(
    "Test a candidate security screener on recent samples using the existing draft validator. Confirm the billable test first.",
    "POST",
    "/scopes/:scope/auto-flagger/test",
    { ...scope, value: object },
  ),
  shadow_deliveries: operation("Read shadow-delivery diagnostics.", "GET", "/deliveries/shadow", scope),
  slack_mirror: operation("List mirrored Slack containers.", "GET", "/slack-mirror", scope),
  slack_messages: operation("Read a page of mirrored Slack messages.", "GET", "/slack-mirror/messages", {
    ...scope,
    container: string,
    q: optionalString,
    before: optionalString,
    limit,
  }),
  ambient_judgments: operation("Read ambient message judgments.", "GET", "/ambient-judgments", {
    ...scope,
    container: optionalString,
    decision: optionalString,
    before: Type.Optional(Type.Integer()),
    beforeId: Type.Optional(Type.Integer()),
    limit,
  }),
  ack_emoji_picks: operation("Read acknowledgment emoji decisions.", "GET", "/ack-emoji-picks", {
    ...scope,
    container: optionalString,
    outcome: optionalString,
    before: Type.Optional(Type.Integer()),
    beforeId: Type.Optional(Type.Integer()),
    limit,
  }),
} satisfies Record<string, Operation>;

export interface AdminToolAccess {
  call: AdminCall;
  operationsAvailable: boolean;
}

type AdminCall = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ status: number; body: unknown; requestId?: string }>;

export function createAdminCall(baseUrl: string, capability: string): AdminCall {
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  return async (input, signal) => {
    const { action, retrySafe: _retrySafe, ...params } = input;
    const op = Object.hasOwn(adminOperations, String(action))
      ? adminOperations[action as keyof typeof adminOperations]
      : undefined;
    if (!op || !Check(op.parameters, params)) throw new Error("Invalid admin action or arguments");
    if (action === "configure" && (params.resource === "service-credentials" || params.resource === "connectors"))
      throw new Error("Secret-bearing configuration uses the existing admin self-API, not native tool arguments");
    if (action === "session" && params.limit === undefined) params.limit = 50;
    signal?.throwIfAborted();
    let path = op.path;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === "value") continue;
      if (path.includes(`:${key}`)) {
        const segment = String(value);
        if (!segment || segment === "." || segment === "..") throw new Error("Invalid admin resource identifier");
        path = path.replace(`:${key}`, encodeURIComponent(segment));
      } else query.set(key === "auditAction" ? "action" : key, String(value));
    }
    const response = await fetch(`${baseUrl}/v1/admin${path}?${query}`, {
      method: op.method,
      headers: { "x-agent-capability": capability, "content-type": "application/json" },
      ...(params.value !== undefined ? { body: JSON.stringify(params.value) } : {}),
      redirect: "error",
      signal,
    });
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
    const result = { status: response.status, ...(requestId ? { requestId } : {}) };
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw new Error(
        `Admin HTTP ${response.status}${requestId ? ` request ${requestId}` : ""}: ${errMessage(error)}`,
        { cause: error },
      );
    }
    try {
      return { ...result, body: JSON.parse(raw) as unknown };
    } catch {
      return { ...result, body: raw };
    }
  };
}
