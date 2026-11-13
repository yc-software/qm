import { randomUUID } from "node:crypto";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { extractReactions, withinReactionBudget } from "../reactions.ts";
import type { SurfaceTransport } from "../turn-driver.ts";
import { uploadPartnerChatFiles, type PartnerChatUploads } from "./files.ts";
import {
  deletePartnerChatMessage,
  editPartnerChatMessage,
  postPartnerChatMessage,
  setPartnerChatTyping,
  type PartnerChatMessages,
} from "./messages.ts";
import type { PartnerChatRef } from "./protocol.ts";
import { setPartnerChatReaction } from "./reactions.ts";

const TYPING_REPEAT_MS = 4_000;

export type PartnerChatTransportDeps = PartnerChatMessages & PartnerChatUploads;

export function createPartnerChatTransport(
  deps: PartnerChatTransportDeps,
  at: { where: PartnerChatRef; authorId: string; trigger: string },
): SurfaceTransport {
  const { where } = at;
  let typing: ReturnType<typeof setInterval> | undefined;
  const sendTyping = (on: boolean): Promise<void> =>
    setPartnerChatTyping(deps.client, where, on).catch(swallowAs("partner-chat: typing", undefined));

  return {
    async post(text, opts = {}) {
      const body = (opts.note ? `${text}\n\n_${opts.note}_` : text).trim();
      if (!body && !opts.fileIds?.length) return undefined;
      return postPartnerChatMessage(deps, where, {
        text: body,
        idempotencyKey: opts.idempotencyKey ?? `post:${randomUUID()}`,
        ...(opts.fileIds?.length ? { fileIds: opts.fileIds } : {}),
      });
    },
    async postPrivate(text, opts) {
      await postPartnerChatMessage(deps, where, {
        text,
        idempotencyKey: `post:${randomUUID()}`,
        ...(where.kind === "dm" && !opts?.transient ? {} : { recipientUserId: at.authorId }),
      });
    },
    edit: (ref, text) => editPartnerChatMessage(deps, where, ref, text),
    remove: (ref) => deletePartnerChatMessage(deps, where, ref),
    react: (ref, name, on) => setPartnerChatReaction(deps.client, where, ref, name, on),
    async applyReactions(reactions) {
      for (const { names } of withinReactionBudget(reactions.filter((r) => !r.target && !r.targetId))) {
        for (const name of names) {
          await setPartnerChatReaction(deps.client, where, at.trigger, name, true).catch((e: unknown) =>
            console.error(`[partner-chat] couldn't add reaction ${name} in chat ${where.chat}: ${errMessage(e)}`),
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
    upload: (attachments) => uploadPartnerChatFiles(deps, where, attachments),
    readReply: extractReactions,
  };
}
