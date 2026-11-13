import { randomUUID } from "node:crypto";
import { errMessage, swallowAs } from "../../util/errors.ts";
import type { AddressFetch } from "../../util/network.ts";
import type { BlobSource } from "../attachments.ts";
import { MAX_REACTIONS_PER_TURN, extractReactions } from "../reactions.ts";
import type { SurfaceTransport } from "../turn-driver.ts";
import { UPLOAD_FAILED, uploadPartnerChatFiles } from "./files.ts";
import {
  deletePartnerChatMessage,
  editPartnerChatMessage,
  postPartnerChatMessage,
  setPartnerChatTyping,
  type PartnerChatMessages,
} from "./messages.ts";
import { partnerChatMessageId, type PartnerChatRef } from "./protocol.ts";
import { addPartnerChatReaction, removePartnerChatReaction } from "./reactions.ts";

const TYPING_REPEAT_MS = 4_000;

export type PartnerChatTransportDeps = PartnerChatMessages & { blobs: BlobSource; storageFetch?: AddressFetch };

export function createPartnerChatTransport(
  deps: PartnerChatTransportDeps,
  at: { where: PartnerChatRef; authorId: string; trigger: string },
): SurfaceTransport {
  const { where } = at;
  const message = (ref: string) => ({ account: where.account, chat: where.chat, messageId: partnerChatMessageId(ref) });
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
    react: (ref, name, on) =>
      (on ? addPartnerChatReaction : removePartnerChatReaction)(deps.client, message(ref), name),
    async applyReactions(reactions) {
      let budget = MAX_REACTIONS_PER_TURN;
      for (const names of reactions.filter((r) => !r.target && !r.targetId).map((r) => r.names)) {
        for (const name of names.slice(0, budget)) {
          budget -= 1;
          await addPartnerChatReaction(deps.client, message(at.trigger), name).catch((e: unknown) =>
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
    async upload(attachments) {
      try {
        return {
          fileIds: await uploadPartnerChatFiles(
            deps.client,
            where.account,
            where.chat,
            attachments,
            deps.blobs,
            deps.storageFetch,
          ),
        };
      } catch (e) {
        console.error(`[partner-chat] file upload failed in chat ${where.chat}: ${errMessage(e)}`);
        return { failureNote: UPLOAD_FAILED };
      }
    },
    render: (markdown) => markdown,
    escape: (text) => text,
    readReply: extractReactions,
  };
}
