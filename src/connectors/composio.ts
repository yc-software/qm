import { createHash } from "node:crypto";
import { Composio, type Tool } from "@composio/core";

interface Actor {
  tenantId: string;
  principalId: string;
  scopeId: string;
}

interface Connection {
  tenantId: string;
  ownerId: string;
  accountId: string;
  toolkit: string;
}

interface Operation {
  action: "connect" | "complete" | "execute" | "status" | "disconnect";
  connection?: string;
  toolkit?: string;
  tool?: Tool;
  arguments?: Record<string, unknown>;
}

function userId(actor: Pick<Actor, "tenantId" | "principalId">): string {
  if (!actor.tenantId || !actor.principalId) throw new Error("Authenticated Composio identity required");
  return `qm_${createHash("sha256")
    .update(JSON.stringify([actor.tenantId, actor.principalId]))
    .digest("hex")}`;
}

export function createComposioAdapter(options: {
  apiKey: string;
  authorize: (actor: Actor, operation: Operation) => Promise<Connection | undefined>;
}) {
  if (!options.apiKey) throw new Error("Composio is not configured");
  const sdk = new Composio({
    apiKey: options.apiKey,
    baseURL: "https://backend.composio.dev",
    allowTracking: false,
    disableVersionCheck: true,
    dangerouslyAllowAutoUploadDownloadFiles: false,
  });
  const client = sdk.getClient();
  client.maxRetries = 0;
  client.timeout = 30_000;
  client.logLevel = "off";
  client.fetchOptions = { redirect: "error" };

  async function authorize(actor: Actor, operation: Operation) {
    userId(actor);
    if (!actor.scopeId) throw new Error("Authenticated scope required");
    const connection = await options.authorize(structuredClone(actor), structuredClone(operation));
    if (
      connection &&
      (connection.tenantId !== actor.tenantId || !connection.ownerId || !connection.accountId || !connection.toolkit)
    ) {
      throw new Error("Invalid authorized connection");
    }
    return connection;
  }

  async function account(actor: Actor, operation: Operation) {
    const connection = await authorize(actor, operation);
    if (!connection) throw new Error("Authorized connection required");
    const value = await sdk.connectedAccounts.get(connection.accountId);
    if (
      value.id !== connection.accountId ||
      value.toolkit.slug !== connection.toolkit ||
      value.experimental?.accountType !== "PRIVATE"
    ) {
      throw new Error("Connection binding mismatch");
    }
    return { connection, value };
  }

  return {
    catalog(cursor?: string) {
      return client.toolkits.list({ limit: 50, cursor });
    },
    discover(search: string, toolkit?: string) {
      return sdk.tools.getRawComposioTools(toolkit ? { search, toolkits: [toolkit], limit: 25 } : { search });
    },
    async connect(actor: Actor, toolkit: string) {
      await authorize(actor, { action: "connect", toolkit });
      const session = await sdk.sessions.create(userId(actor), {
        manageConnections: false,
        sandbox: { enable: false },
      });
      const link = await session.authorize(toolkit);
      return { accountId: link.id, connectUrl: link.redirectUrl };
    },
    async complete(actor: Actor, sessionUri: string) {
      await authorize(actor, { action: "complete" });
      const result = await client.post<{ connected_account_id: string; toolkit_slug: string }>(
        "/api/v3.1/connected_accounts/complete_auth",
        {
          body: { session_uri: sessionUri, user_id: userId(actor) },
        },
      );
      if (
        typeof result.connected_account_id !== "string" ||
        !result.connected_account_id ||
        typeof result.toolkit_slug !== "string" ||
        !result.toolkit_slug
      )
        throw new Error("Invalid Composio completion");
      const connected = await sdk.connectedAccounts.get(result.connected_account_id);
      if (
        connected.id !== result.connected_account_id ||
        connected.toolkit.slug !== result.toolkit_slug ||
        connected.status !== "ACTIVE" ||
        connected.isDisabled ||
        connected.authConfig.isDisabled ||
        connected.experimental?.accountType !== "PRIVATE"
      )
        throw new Error("Connection is not active and private");
      return { accountId: result.connected_account_id, toolkit: result.toolkit_slug };
    },
    async status(actor: Actor, connection: string) {
      const { value } = await account(actor, { action: "status", connection });
      return {
        status: value.status,
        needsReconnect: value.status !== "ACTIVE" || value.isDisabled || value.authConfig.isDisabled,
      };
    },
    async disconnect(actor: Actor, connection: string) {
      const binding = await authorize(actor, { action: "disconnect", connection });
      if (!binding) throw new Error("Authorized connection required");
      await sdk.connectedAccounts.delete(binding.accountId);
    },
    async execute(actor: Actor, slug: string, args: Record<string, unknown>, connection?: string) {
      if (!/^[A-Z][A-Z0-9_]+$/.test(slug) || /^(COMPOSIO|LOCAL|CUSTOM)_/.test(slug))
        throw new Error("Only native app tools are supported");
      const tool = await sdk.tools.getRawComposioToolBySlug(slug);
      if (
        tool.slug !== slug ||
        !tool.toolkit ||
        /^(composio$|local_|custom_)/i.test(tool.toolkit.slug) ||
        !tool.version ||
        tool.version === "latest"
      ) {
        throw new Error("A versioned native app tool is required");
      }
      return sdk.tools.execute(
        slug,
        { version: tool.version, arguments: structuredClone(args) },
        {
          beforeExecute: async ({ toolSlug, toolkitSlug, params }) => {
            if (toolSlug !== tool.slug || toolkitSlug !== tool.toolkit!.slug) throw new Error("Tool binding mismatch");
            const binding = await authorize(actor, {
              action: "execute",
              connection,
              tool,
              arguments: params.arguments ?? {},
            });
            if (!binding && tool.isNoAuth !== true) throw new Error("Authorized connection required");
            if (binding && binding.toolkit !== toolkitSlug) throw new Error("Tool and connection mismatch");
            return {
              version: tool.version,
              arguments: params.arguments,
              userId: binding ? userId({ tenantId: binding.tenantId, principalId: binding.ownerId }) : userId(actor),
              ...(binding ? { connectedAccountId: binding.accountId } : {}),
            };
          },
        },
      );
    },
  };
}
