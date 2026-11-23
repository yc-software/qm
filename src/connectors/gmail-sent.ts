import { GmailApiError, gmailApi } from "./gmail-api.ts";

export interface SentEmail {
  id: string;
  threadId: string;
  to: string;
  subject: string;
  snippet: string;
  sentAt: number;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  headers?: { name: string; value: string }[];
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

export async function listSentEmails(
  token: string,
  pageToken?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ messages: SentEmail[]; nextPageToken?: string; accountEmail: string }> {
  const api = gmailApi(token, fetchImpl);
  const get = <T>(path: string): Promise<T> => api<T>(path, { timeoutMs: 15_000 });
  const params = new URLSearchParams({ labelIds: "SENT", maxResults: "25" });
  if (pageToken) params.set("pageToken", pageToken);
  const page = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(`messages?${params}`);
  const profile = await get<{ emailAddress: string }>("profile");
  const messages: SentEmail[] = [];
  const ids = page.messages ?? [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = await Promise.all(
      ids.slice(i, i + 5).map(async ({ id }) => {
        let message: GmailMessage;
        try {
          message = await get<GmailMessage>(
            `messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`,
          );
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 404) return null;
          throw error;
        }
        const header = (name: string): string =>
          message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
        return {
          id: message.id,
          threadId: message.threadId,
          to: header("to"),
          subject: header("subject"),
          snippet: message.snippet ?? "",
          sentAt: Number(message.internalDate) || 0,
        };
      }),
    );
    messages.push(...batch.filter((message): message is SentEmail => message !== null));
  }
  messages.sort((a, b) => b.sentAt - a.sentAt);
  return {
    messages,
    accountEmail: profile.emailAddress,
    ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
  };
}

export async function getSentEmail(
  token: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  SentEmail & { from: string; cc: string; body: string; rfcMessageId: string; html: boolean; attachments: string[] }
> {
  const path = `messages/${encodeURIComponent(id)}?format=full`;
  const message = await gmailApi(token, fetchImpl)<GmailMessage>(path, { timeoutMs: 15_000 });
  if (!message.labelIds?.includes("SENT")) throw new GmailApiError(path, 404, 0, "");
  const header = (name: string): string =>
    message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  const parts: GmailPart[] = [];
  const visit = (part: GmailPart): void => {
    parts.push(part);
    for (const child of part.parts ?? []) visit(child);
  };
  if (message.payload) visit(message.payload);
  const content =
    parts.find((part) => !part.filename && part.mimeType === "text/plain" && part.body?.data) ??
    parts.find((part) => !part.filename && part.mimeType === "text/html" && part.body?.data);
  return {
    id: message.id,
    threadId: message.threadId,
    to: header("to"),
    from: header("from"),
    cc: header("cc"),
    rfcMessageId: header("message-id"),
    subject: header("subject"),
    snippet: message.snippet ?? "",
    sentAt: Number(message.internalDate) || 0,
    body: content?.body?.data ? Buffer.from(content.body.data, "base64url").toString("utf8") : "",
    html: content?.mimeType === "text/html",
    attachments: parts.flatMap((part) => (part.filename ? [part.filename] : [])),
  };
}
