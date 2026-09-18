import { createHash, randomUUID } from "node:crypto";
import type { ConnectorTokenStore } from "../credentials/keychain.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { NeedsApproval } from "../tools/primitives.ts";

export const GOOGLE_WORKSPACE_HOSTS: readonly string[] = [
  "gmail.googleapis.com",
  "www.googleapis.com",
  "sheets.googleapis.com",
  "docs.googleapis.com",
  "slides.googleapis.com",
];

const ACCOUNT_SCHEMA = { type: "string", enum: ["default", "personal", "company"] };
export const googleWorkspaceToolDefs: McpToolDescriptor[] = [
  {
    name: "google_workspace_request",
    serverId: "google_workspace",
    remoteName: "request",
    description:
      "Read, create, or edit Google Drive files and Docs, Sheets, Slides using your connected account. Supply a service, HTTP method and API path without query parameters. No sharing, deletion, trash, arbitrary hosts, or headers. Drive metadata accepts name/description and, on creation, mimeType/parents. Upload at most 10 MiB using upload.dataBase64 and upload.mimeType. Native document batchUpdate edits document contents. accountType defaults to default; select personal or company explicitly when needed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["service", "method", "path"],
      properties: {
        service: { type: "string", enum: ["drive", "docs", "sheets", "slides"] },
        method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT"] },
        path: { type: "string" },
        query: { type: "object" },
        body: { type: "object" },
        upload: {
          type: "object",
          additionalProperties: false,
          required: ["dataBase64", "mimeType"],
          properties: { dataBase64: { type: "string" }, mimeType: { type: "string" } },
        },
        accountType: ACCOUNT_SCHEMA,
      },
    },
    readOnly: false,
  },
  {
    name: "google_workspace_trash",
    serverId: "google_workspace",
    remoteName: "trash",
    description:
      "Request one-time approval to move one Drive file or folder to recoverable trash. Previews authoritative metadata and every descendant (up to 100). Changes observed on retry require another approval. Folder contents can change concurrently until moved. Permanent deletion is unavailable. accountType defaults to default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["fileId"],
      properties: { fileId: { type: "string" }, accountType: ACCOUNT_SCHEMA },
    },
    readOnly: false,
  },
];

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DESCENDANTS = 100;
const FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const SNAPSHOT_FIELDS = "id,name,mimeType,modifiedTime,version,parents,trashed,capabilities(canTrash)";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unsupported Google request field");
}

function fileId(value: unknown): string {
  if (typeof value !== "string" || !FILE_ID.test(value)) throw new Error("Invalid Google file ID");
  return value;
}

function accountType(value: unknown): string {
  if (typeof value !== "string" || !["default", "personal", "company"].includes(value))
    throw new Error("Invalid Google account type");
  return value;
}

interface ValidatedRequest {
  url: URL;
  method: string;
  body?: string | Buffer;
  contentType?: string;
  ifMatch?: string;
}

function validateRequest(args: Record<string, unknown>): ValidatedRequest {
  keys(args, ["service", "method", "path", "query", "body", "upload", "accountType"]);
  const { service, method, path } = args;
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    /[?#\\\s]/.test(path) ||
    path.includes("..") ||
    path.includes("//")
  )
    throw new Error("Invalid Google API path");
  if (typeof method !== "string" || !["GET", "POST", "PATCH", "PUT"].includes(method))
    throw new Error("Unsupported Google method");
  const query = args.query === undefined ? {} : object(args.query);
  const body = args.body === undefined ? undefined : object(args.body);
  if (method === "GET" && body !== undefined) throw new Error("Read requests cannot have a body");
  let host: string;
  let allowed = false;
  let queryKeys = ["fields"];
  const id = "[A-Za-z0-9_-]{1,256}";
  if (service === "drive") {
    host = "www.googleapis.com";
    const isFile = new RegExp(`^/drive/v3/files/${id}$`).test(path);
    const isCreate = method === "POST" && path === "/drive/v3/files";
    const isCopy = method === "POST" && new RegExp(`^/drive/v3/files/${id}/copy$`).test(path);
    const isUpdate = method === "PATCH" && isFile;
    if (method === "GET") {
      allowed =
        isFile ||
        path === "/drive/v3/files" ||
        path === "/drive/v3/about" ||
        new RegExp(`^/drive/v3/files/${id}/export$`).test(path);
      if (path === "/drive/v3/files")
        queryKeys = [
          "fields",
          "q",
          "pageSize",
          "pageToken",
          "orderBy",
          "spaces",
          "corpora",
          "driveId",
          "includeItemsFromAllDrives",
          "supportsAllDrives",
        ];
      else if (isFile) queryKeys = ["fields", "alt", "supportsAllDrives"];
      else if (path.endsWith("/export")) queryKeys = ["mimeType"];
      if (query.alt !== undefined && query.alt !== "media" && query.alt !== "json")
        throw new Error("Unsupported response format");
    } else if (isCreate || isCopy || isUpdate) {
      allowed = true;
      queryKeys = ["fields", "supportsAllDrives"];
      if (body) {
        keys(body, isUpdate ? ["name", "description"] : ["name", "description", "mimeType", "parents"]);
        for (const key of ["name", "description", "mimeType"])
          if (body[key] !== undefined && typeof body[key] !== "string") throw new Error("Invalid Drive metadata");
        if (body.parents !== undefined) {
          if (!Array.isArray(body.parents) || body.parents.length > 1) throw new Error("Invalid Drive parents");
          body.parents.forEach(fileId);
        }
      }
    }
    if (args.upload !== undefined && !(isCreate || isUpdate))
      throw new Error("Uploads require file creation or update");
  } else if (service === "docs" || service === "slides" || service === "sheets") {
    host = `${service}.googleapis.com`;
    const prefix = { docs: "/v1/documents", slides: "/v1/presentations", sheets: "/v4/spreadsheets" }[service];
    const isItem = new RegExp(`^${prefix}/${id}$`).test(path);
    const isBatch = new RegExp(`^${prefix}/${id}:batchUpdate$`).test(path);
    if (method === "GET" && isItem) {
      allowed = true;
      queryKeys = {
        docs: ["fields", "includeTabsContent", "suggestionsViewMode"],
        sheets: ["fields", "ranges", "includeGridData"],
        slides: ["fields"],
      }[service];
    } else if (method === "POST" && (path === prefix || isBatch)) {
      allowed = true;
      if (!body) throw new Error("Google write requires a body");
      const batchKeys =
        service === "sheets"
          ? ["requests", "includeSpreadsheetInResponse", "responseRanges", "responseIncludeGridData"]
          : ["requests", "writeControl"];
      const createKeys = service === "sheets" ? ["properties", "sheets", "namedRanges"] : ["title"];
      keys(body, isBatch ? batchKeys : createKeys);
      if (isBatch && !Array.isArray(body.requests)) throw new Error("Batch update requires requests");
    } else if (service === "sheets") {
      const valuePath = new RegExp(`^${prefix}/${id}/values/([^/]+)$`).exec(path);
      if (valuePath && !/%(?![0-9a-fA-F]{2})/.test(valuePath[1]!)) {
        const range = decodeURIComponent(valuePath[1]!);
        if (/[\x00-\x1f\\/?#]/.test(range)) throw new Error("Invalid spreadsheet range");
        allowed = method === "GET" || method === "PUT" || (method === "POST" && /:(append|clear)$/.test(range));
        queryKeys = [
          "fields",
          "valueInputOption",
          "valueRenderOption",
          "dateTimeRenderOption",
          "majorDimension",
          "insertDataOption",
          "includeValuesInResponse",
          "responseValueRenderOption",
          "responseDateTimeRenderOption",
        ];
        if (body) keys(body, ["range", "majorDimension", "values"]);
      }
    }
    if (args.upload !== undefined) throw new Error("Uploads are only supported for Drive files");
  } else throw new Error("Unsupported Google service");
  if (!allowed) throw new Error("Google endpoint is not allowed");
  keys(query, queryKeys);
  const url = new URL(`https://${host}${path}`);
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (
        !["string", "number", "boolean"].includes(typeof item) ||
        (typeof item === "number" && !Number.isFinite(item))
      )
        throw new Error("Invalid query value");
      url.searchParams.append(key, String(item));
    }
  }
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized && Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Google request body is too large");
  if (args.upload !== undefined) {
    const upload = object(args.upload);
    keys(upload, ["mimeType", "dataBase64"]);
    if (typeof upload.mimeType !== "string" || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(upload.mimeType))
      throw new Error("Invalid upload MIME type");
    if (
      typeof upload.dataBase64 !== "string" ||
      upload.dataBase64.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      upload.dataBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(upload.dataBase64)
    )
      throw new Error("Invalid or oversized base64 upload");
    const bytes = Buffer.from(upload.dataBase64, "base64");
    if (bytes.length > MAX_BYTES) throw new Error("Upload is too large");
    const boundary = `qm-${randomUUID()}`;
    url.pathname = `/upload${url.pathname}`;
    url.searchParams.set("uploadType", "multipart");
    return {
      url,
      method,
      contentType: `multipart/related; boundary=${boundary}`,
      body: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${serialized ?? "{}"}\r\n--${boundary}\r\nContent-Type: ${upload.mimeType}\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    };
  }
  return { url, method, ...(serialized !== undefined ? { body: serialized, contentType: "application/json" } : {}) };
}

interface FileSnapshot {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  version: string;
  parents: string[];
  trashed: boolean;
  canTrash: boolean;
}

function snapshot(value: unknown): FileSnapshot {
  const data = object(value);
  const id = fileId(data.id);
  if (
    typeof data.name !== "string" ||
    typeof data.mimeType !== "string" ||
    typeof data.modifiedTime !== "string" ||
    typeof data.version !== "string" ||
    typeof data.trashed !== "boolean"
  )
    throw new Error("Incomplete Google file metadata");
  const parents = data.parents === undefined ? [] : data.parents;
  if (!Array.isArray(parents)) throw new Error("Incomplete Google parent metadata");
  const capabilities = object(data.capabilities);
  if (typeof capabilities.canTrash !== "boolean") throw new Error("Incomplete Google capabilities");
  return {
    id,
    name: data.name,
    mimeType: data.mimeType,
    modifiedTime: data.modifiedTime,
    version: data.version,
    parents: parents.map(fileId).sort(),
    trashed: data.trashed,
    canTrash: capabilities.canTrash,
  };
}

export function createGoogleWorkspaceService(opts: {
  principalId: string;
  accountType?: string;
  tokens: ConnectorTokenStore;
  fetchImpl?: typeof fetch;
  authorize: (command: string, key: string) => boolean;
  audit?: (event: { action: string; resource: string; status: string }) => void;
}): { call(name: string, args: Record<string, unknown>): Promise<string> } {
  const fetchImpl = opts.fetchImpl ?? fetch;
  async function send(token: string, request: ValidatedRequest): Promise<{ content: string; etag: string | null }> {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(request.ifMatch ? { "if-match": request.ifMatch } : {}),
          ...(request.contentType ? { "content-type": request.contentType } : {}),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Google request failed");
    }
    if (!response.ok || response.redirected) throw new Error(`Google request failed (HTTP ${response.status})`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error("Google response is too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
    }
    const bytes = Buffer.concat(chunks);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const result = /json|^text\//i.test(contentType)
      ? bytes.toString("utf8")
      : JSON.stringify({ mimeType: contentType, dataBase64: bytes.toString("base64") });
    return { content: result.replaceAll(token, "[redacted]"), etag: response.headers.get("etag") };
  }
  async function googleJson(
    token: string,
    path: string,
    query: Record<string, string>,
  ): Promise<{ data: Record<string, unknown>; etag: string | null }> {
    const response = await send(token, validateRequest({ service: "drive", method: "GET", path, query }));
    return { data: object(JSON.parse(response.content)), etag: response.etag };
  }
  async function trash(args: Record<string, unknown>, account: string): Promise<string> {
    keys(args, ["fileId", "accountType"]);
    const id = fileId(args.fileId);
    const token = await opts.tokens.connectorAccessToken("www.googleapis.com", opts.principalId, account);
    if (!token) throw new Error("Connect the selected Google account first");
    const about = await googleJson(token, "/drive/v3/about", { fields: "user(permissionId,emailAddress)" });
    const user = object(about.data.user);
    const identity = user.permissionId;
    const accountLabel = typeof user.emailAddress === "string" ? user.emailAddress : identity;
    if (typeof identity !== "string" || !identity) throw new Error("Google account identity unavailable");
    const metadata = await googleJson(token, `/drive/v3/files/${id}`, {
      fields: SNAPSHOT_FIELDS,
      supportsAllDrives: "true",
    });
    const target = snapshot(metadata.data);
    if (target.id !== id || target.trashed || !target.canTrash)
      throw new Error("Google target cannot be moved to trash");
    const descendants: FileSnapshot[] = [];
    const folders = target.mimeType === FOLDER_TYPE ? [id] : [];
    const visited = new Set([id]);
    for (let i = 0; i < folders.length; i++) {
      let pageToken: string | undefined;
      const pages = new Set<string>();
      do {
        const { data: page } = await googleJson(token, "/drive/v3/files", {
          q: `'${folders[i]}' in parents and trashed = false`,
          fields: `files(${SNAPSHOT_FIELDS}),nextPageToken,incompleteSearch`,
          pageSize: "100",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(pageToken ? { pageToken } : {}),
        });
        if (page.incompleteSearch !== false || !Array.isArray(page.files))
          throw new Error("Folder contents could not be completely enumerated");
        for (const raw of page.files) {
          const child = snapshot(raw);
          if (child.trashed || !child.parents.includes(folders[i]!) || visited.has(child.id))
            throw new Error("Folder contents changed during preview");
          visited.add(child.id);
          descendants.push(child);
          if (descendants.length > MAX_DESCENDANTS) throw new Error("Folder exceeds the 100 descendant approval limit");
          if (child.mimeType === FOLDER_TYPE) folders.push(child.id);
        }
        if (page.nextPageToken !== undefined && (typeof page.nextPageToken !== "string" || !page.nextPageToken))
          throw new Error("Invalid Google folder pagination");
        pageToken = page.nextPageToken as string | undefined;
        if (pageToken && (pages.has(pageToken) || pages.size >= 20))
          throw new Error("Folder pagination could not complete");
        if (pageToken) pages.add(pageToken);
      } while (pageToken);
    }
    descendants.sort((a, b) => a.id.localeCompare(b.id));
    const key = `google-trash:${createHash("sha256")
      .update(
        JSON.stringify({ principalId: opts.principalId, account, identity, target, etag: metadata.etag, descendants }),
      )
      .digest("hex")}`;
    const command = `Move to recoverable Google Drive trash: ${JSON.stringify(target.name)} (${id}); account ${account} (${JSON.stringify(accountLabel)}); ${descendants.length} descendants${descendants.length ? `: ${descendants.map((item) => `${JSON.stringify(item.name)} (${item.id})`).join(", ")}` : ""}`;
    if (command.length > 1800) throw new Error("Folder or file preview exceeds the approval display limit");
    if (!opts.authorize(command, key)) {
      const approval = new NeedsApproval(
        command,
        target.mimeType === FOLDER_TYPE
          ? "Approve this folder move once. Contents are rechecked on approval; concurrent changes before the move can also be affected."
          : "Moving this Google Drive file to trash requires your one-time approval.",
        "approval",
        undefined,
        key,
        { session: false, always: false },
      );
      approval.summary = command;
      throw approval;
    }
    return (
      await send(token, {
        url: new URL(`https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=id,name,trashed`),
        method: "PATCH",
        contentType: "application/json",
        body: JSON.stringify({ trashed: true }),
        ...(metadata.etag ? { ifMatch: metadata.etag } : {}),
      })
    ).content;
  }
  return {
    async call(name, args) {
      const resource = name === "google_workspace_trash" ? String(args.fileId ?? "") : String(args.path ?? "");
      const record = (status: string) => opts.audit?.({ action: name, resource, status });
      record("attempt");
      try {
        if (!opts.principalId) throw new Error("Google Workspace requires a requesting person");
        const account = accountType(args.accountType ?? opts.accountType ?? "default");
        let result: string;
        if (name === "google_workspace_trash") result = await trash(args, account);
        else if (name === "google_workspace_request") {
          const request = validateRequest(args);
          const token = await opts.tokens.connectorAccessToken("www.googleapis.com", opts.principalId, account);
          if (!token) throw new Error("Connect the selected Google account first");
          result = (await send(token, request)).content;
        } else throw new Error("Unknown Google Workspace tool");
        record("succeeded");
        return result;
      } catch (error) {
        record(error instanceof NeedsApproval ? "approval_required" : "failed");
        throw error;
      }
    },
  };
}
