export const CLIENT_TOOL_MAX_TIMEOUT_MS = 60_000;

export interface ClientToolResult {
  images?: Array<{ data: string; mimeType: "image/png" | "image/jpeg" }>;
  content: string;
  structured?: unknown;
  isError?: boolean;
}
