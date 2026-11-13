import { randomUUID } from "node:crypto";
import type { SurfaceTransport } from "../turn-driver.ts";
import { postPartnerChatMessage, type PartnerChatPoster } from "./post.ts";
import type { PartnerChatRef } from "./protocol.ts";

const unimplemented = async (): Promise<undefined> => undefined;

export function createPartnerChatTransport(
  deps: PartnerChatPoster,
  at: { chat: Omit<PartnerChatRef, "thread">; thread?: string; authorId: string },
): SurfaceTransport {
  const send = (text: string, key: string | undefined, recipientUserId?: string): Promise<string | undefined> =>
    postPartnerChatMessage(deps, {
      chat: at.chat,
      ...(at.thread ? { thread: at.thread } : {}),
      body: text,
      key: key ?? `post:${randomUUID()}`,
      ...(recipientUserId ? { recipientUserId } : {}),
    });
  return {
    async post(text, opts = {}) {
      const body = opts.note ? `${text}\n\n_${opts.note}_` : text;
      return body.trim() ? send(body.trim(), opts.idempotencyKey) : undefined;
    },
    async postPrivate(text, opts) {
      await send(text, undefined, at.chat.kind === "dm" && !opts?.transient ? undefined : at.authorId);
    },
    edit: unimplemented,
    remove: unimplemented,
    react: unimplemented,
    applyReactions: unimplemented,
    typing: unimplemented,
    upload: unimplemented,
    render: (markdown) => markdown,
    escape: (text) => text,
    readReply: (reply) => ({ text: reply, reactions: [] }),
  };
}
