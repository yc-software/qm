import { WebClient } from "@slack/web-api";

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  files?: Array<{ id?: string; name?: string; title?: string }>;
  subtype?: string;
}

function apiUrlOf(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? `${trimmed}/` : `${trimmed}/api/`;
}

export class SlackClient {
  private readonly web: WebClient;

  constructor(token: string, apiUrl = process.env.SLACK_API_URL) {
    this.web = new WebClient(token, apiUrl ? { slackApiUrl: apiUrlOf(apiUrl) } : {});
  }

  async authTest(): Promise<{ userId: string; user: string; teamId: string; url: string }> {
    const r = await this.web.auth.test();
    return { userId: r.user_id as string, user: r.user as string, teamId: r.team_id as string, url: r.url as string };
  }

  async createChannel(name: string): Promise<string> {
    const r = await this.web.conversations.create({ name });
    return r.channel?.id as string;
  }

  async invite(channel: string, users: string): Promise<void> {
    await this.web.conversations.invite({ channel, users }).catch((err: Error) => {
      if (!err.message.includes("already_in_channel")) throw err;
    });
  }

  async archive(channel: string): Promise<void> {
    await this.web.conversations.archive({ channel }).catch(() => {});
  }

  async openDm(userId: string): Promise<string> {
    const r = await this.web.conversations.open({ users: userId });
    return r.channel?.id as string;
  }

  async post(channel: string, text: string, threadTs?: string): Promise<string> {
    const r = await this.web.chat.postMessage({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
    return r.ts as string;
  }

  async uploadFile(
    channel: string,
    file: { filename: string; bytes: Uint8Array; title?: string; initialComment?: string; threadTs?: string },
  ): Promise<string> {
    const base = {
      channel_id: channel,
      filename: file.filename,
      file: Buffer.from(file.bytes),
      ...(file.title ? { title: file.title } : {}),
      ...(file.initialComment ? { initial_comment: file.initialComment } : {}),
    };
    const uploaded = (await this.web.filesUploadV2(file.threadTs ? { ...base, thread_ts: file.threadTs } : base)) as {
      files?: Array<{ files?: Array<{ id?: string }> }>;
    };
    const fileId = uploaded.files?.[0]?.files?.[0]?.id;
    if (!fileId) throw new Error("filesUploadV2 returned no uploaded file id");
    for (let i = 0; i < 10; i++) {
      const msgs = file.threadTs ? await this.replies(channel, file.threadTs) : await this.history(channel);
      const shared = msgs.find((m) => (m.files ?? []).some((f) => f.id === fileId));
      if (shared) return shared.ts;
      await sleep(1500);
    }
    throw new Error(`uploaded file ${fileId} never appeared as a message in ${channel}`);
  }

  async getPermalink(channel: string, messageTs: string): Promise<string | undefined> {
    const r = await this.web.chat.getPermalink({ channel, message_ts: messageTs }).catch(() => null);
    return r?.permalink;
  }

  async replies(channel: string, ts: string): Promise<SlackMessage[]> {
    const r = await this.web.conversations.replies({ channel, ts, limit: 200 });
    return (r.messages ?? []) as unknown as SlackMessage[];
  }

  async history(channel: string, oldest?: string): Promise<SlackMessage[]> {
    const r = await this.web.conversations.history({ channel, limit: 200, ...(oldest ? { oldest } : {}) });
    return ((r.messages ?? []) as unknown as SlackMessage[]).reverse();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
