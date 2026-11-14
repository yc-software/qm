import { randomUUID } from "node:crypto";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { extractReactions, withinReactionBudget } from "../reactions.ts";
import type { SurfaceTransport } from "../turn-driver.ts";
import { uploadGenericChatFiles, type GenericChatUploads } from "./files.ts";
import {
  deleteGenericChatMessage,
  editGenericChatMessage,
  postGenericChatMessage,
  setGenericChatTyping,
  type GenericChatMessages,
} from "./messages.ts";
import type { GenericChatRef } from "./protocol.ts";
import { setGenericChatReaction } from "./reactions.ts";

const TYPING_REPEAT_MS = 4_000;

export type GenericChatTransportDeps = GenericChatMessages & GenericChatUploads;

export function createGenericChatTransport(
  deps: GenericChatTransportDeps,
  at: { where: GenericChatRef; authorId: string; trigger: string },
): SurfaceTransport {
  const { where } = at;
  let typing: ReturnType<typeof setInterval> | undefined;
  const sendTyping = (on: boolean): Promise<void> =>
    setGenericChatTyping(deps.client, where, on).catch(swallowAs("generic-chat: typing", undefined));

  return {
    async post(text, opts = {}) {
      const body = (opts.note ? `${text}\n\n_${opts.note}_` : text).trim();
      if (!body && !opts.fileIds?.length) return undefined;
      return postGenericChatMessage(deps, where, {
        text: body,
        idempotencyKey: opts.idempotencyKey ?? `post:${randomUUID()}`,
        ...(opts.fileIds?.length ? { fileIds: opts.fileIds } : {}),
      });
    },
    async postPrivate(text, opts) {
      await postGenericChatMessage(deps, where, {
        text,
        idempotencyKey: `post:${randomUUID()}`,
        ...(where.kind === "dm" && !opts?.transient ? {} : { recipientUserId: at.authorId }),
      });
    },
    edit: (ref, text) => editGenericChatMessage(deps, where, ref, text),
    remove: (ref) => deleteGenericChatMessage(deps, where, ref),
    react: (ref, name, on) => setGenericChatReaction(deps.client, where, ref, name, on),
    async applyReactions(reactions) {
      for (const { names } of withinReactionBudget(reactions.filter((r) => !r.target && !r.targetId))) {
        for (const name of names) {
          await setGenericChatReaction(deps.client, where, at.trigger, name, true).catch((e: unknown) =>
            console.error(`[generic-chat] couldn't add reaction ${name} in chat ${where.chat}: ${errMessage(e)}`),
          );
        }
      }
    },
    async typing(on) {
      clearInterval(typing);
      typing = on ? setInterval(() => void sendTyping(true), TYPING_REPEAT_MS) : undefined;
      typing?.unref();
      await sendTyping(on);
    },
    upload: (attachments) => uploadGenericChatFiles(deps, where, attachments),
    readReply: extractReactions,
  };
}
