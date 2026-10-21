import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ConnectorTokenSource } from "./sources/adapter.ts";
import type { IngestEntryInput } from "./item-ledger.ts";
import { GmailApiError, gmailApi } from "../connectors/gmail-api.ts";

export interface GmailPushConfig {
  topic: string;
  audience: string;
  serviceAccount: string;
}

export interface GmailCursor {
  email: string;
  historyId: string;
  expiresAt: number;
}

const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function verifyGmailPush(authorization: string | undefined, config: GmailPushConfig): Promise<boolean> {
  if (!authorization?.startsWith("Bearer ")) return false;
  try {
    const { payload } = await jwtVerify(authorization.slice(7), keys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: config.audience,
      algorithms: ["RS256"],
    });
    return payload.email === config.serviceAccount && payload.email_verified === true;
  } catch {
    return false;
  }
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  snippet?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name: string; value: string }> };
}

export function createGmailPushClient(tokens: ConnectorTokenSource, config: GmailPushConfig, fetchImpl = fetch) {
  async function client(owner: string) {
    const token = await tokens.connectorAccessToken("gmail.googleapis.com", owner, "personal");
    if (!token) throw new Error("Connect a personal Gmail account before enabling Gmail Pub/Sub.");
    return gmailApi(token, fetchImpl);
  }

  return {
    async watch(owner: string): Promise<GmailCursor> {
      const request = await client(owner);
      const profile = await request<{ emailAddress: string }>("profile");
      const watch = await request<{ historyId: string; expiration: string }>("watch", {
        body: { topicName: config.topic, labelIds: ["INBOX"], labelFilterBehavior: "include" },
      });
      if (!profile.emailAddress || !/^\d+$/.test(watch.historyId) || !Number.isFinite(Number(watch.expiration)))
        throw new Error("Gmail returned an invalid watch response");
      return {
        email: profile.emailAddress.toLowerCase(),
        historyId: watch.historyId,
        expiresAt: Number(watch.expiration),
      };
    },
    async changes(
      owner: string,
      loopId: string,
      cursor: GmailCursor,
      ingest: (entries: IngestEntryInput[]) => Promise<unknown>,
    ): Promise<string> {
      const request = await client(owner);
      const profile = await request<{ emailAddress: string; historyId: string }>("profile");
      if (profile.emailAddress.toLowerCase() !== cursor.email)
        throw new Error("Connected Gmail account changed; reconnect this ingestion source.");
      const importMessages = async (ids: string[]) => {
        for (const id of new Set(ids)) {
          let message: GmailMessage;
          try {
            message = await request<GmailMessage>(`messages/${encodeURIComponent(id)}?format=metadata`);
          } catch (error) {
            if (error instanceof GmailApiError && error.status === 404) continue;
            throw error;
          }
          const at = Number(message.internalDate);
          if (!message.threadId || !Number.isFinite(at)) throw new Error("Gmail returned invalid message metadata");
          if (!message.labelIds?.includes("INBOX")) continue;
          const headers = message.payload?.headers ?? [];
          const header = (name: string) => headers.find((entry) => entry.name.toLowerCase() === name)?.value;
          await ingest([
            {
              loopId,
              source: "gmail",
              dedupeKey: message.threadId,
              summary: message.snippet ?? "New email",
              sourceAt: at,
              sourcePayload: {
                source: "gmail",
                title: header("subject") ?? "(No subject)",
                from: header("from") ?? cursor.email,
                snippet: message.snippet ?? "New email",
                receivedAt: at,
                externalUrl: `https://mail.google.com/mail/u/${encodeURIComponent(cursor.email)}/#inbox/${message.threadId}`,
                gmail: {
                  threadId: message.threadId,
                  messageId: message.id,
                  rfcMessageId: header("message-id"),
                  subject: header("subject"),
                  to: [header("reply-to") ?? header("from") ?? ""],
                  accountEmail: cursor.email,
                  accountType: "personal",
                },
              },
            },
          ]);
        }
      };
      let pageToken: string | undefined;
      let latest: string;
      try {
        do {
          const query = new URLSearchParams({ startHistoryId: cursor.historyId, maxResults: "100" });
          if (pageToken) query.set("pageToken", pageToken);
          const page = await request<{
            historyId: string;
            nextPageToken?: string;
            history?: Array<{
              messagesAdded?: Array<{ message: GmailMessage }>;
              labelsAdded?: Array<{ message: GmailMessage; labelIds: string[] }>;
            }>;
          }>(`history?${query}`);
          await importMessages(
            (page.history ?? []).flatMap((entry) => [
              ...(entry.messagesAdded ?? []).map((row) => row.message.id),
              ...(entry.labelsAdded ?? []).filter((row) => row.labelIds.includes("INBOX")).map((row) => row.message.id),
            ]),
          );
          pageToken = page.nextPageToken;
          latest = page.historyId;
        } while (pageToken);
      } catch (error) {
        if (!(error instanceof GmailApiError && error.status === 404)) throw error;
        pageToken = undefined;
        do {
          const query = new URLSearchParams({ labelIds: "INBOX", maxResults: "100" });
          if (pageToken) query.set("pageToken", pageToken);
          const page = await request<{ nextPageToken?: string; messages?: Array<{ id: string }> }>(`messages?${query}`);
          await importMessages((page.messages ?? []).map((message) => message.id));
          pageToken = page.nextPageToken;
        } while (pageToken);
        latest = profile.historyId;
      }
      if (!/^\d+$/.test(latest)) throw new Error("Gmail returned an invalid history cursor");
      return latest;
    },
  };
}
