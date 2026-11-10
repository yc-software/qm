import { type OutboundFile } from "../../core/attachments.ts";
import type { RuntimeRequest } from "../runtime-types.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isObj } from "../../util/objects.ts";
import { goalIsOpen } from "../goal.ts";
import { outboundFilesSchema, outboundSandboxSchema, text, type ToolKit } from "./kit.ts";

export function turnTools(kit: ToolKit) {
  const { ref, opts, recordCall, recordResult, recordCoreAuthoredResult } = kit;
  const surfaceTools = !!opts?.surfaceTools;
  const attach = defineTool({
    name: "attach",
    label: "Attach",
    description: "Send files with this turn's reply; the result lists what will be delivered.",
    parameters: Type.Object({
      files: outboundFilesSchema,
      sandbox_id: outboundSandboxSchema,
    }),
    async execute(callId, params: { files?: OutboundFile[]; sandbox_id?: string }) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      const files = params.files ?? [];
      await recordCall(callId, { tool: "attach", files, sandbox_id: params.sandbox_id });
      const r = await tc.attach(files, params.sandbox_id);
      if (!r.ok) return recordResult(callId, { tool: "attach", ok: false }, text(`[not attached] ${r.message}`), true);
      const list = r.files.map((f) => `${f.name} (${f.sizeBytes} bytes, ${f.mimetype})`).join("; ");
      const total = r.staged > r.files.length ? ` ${r.staged} file(s) are now staged for this reply.` : "";
      return recordResult(
        callId,
        { tool: "attach", ok: true, files: r.files },
        text(`[attached] ${list} — delivered with your reply when this turn ends.${total}`),
      );
    },
  });

  const finishSilently = defineTool({
    name: "finish_silently",
    label: "finish_silently",
    description:
      "End this turn without replying (surface turns that deserve none; scheduled fires with nothing to report). Not needed after posting; does nothing on a turn without surface tools unless it is a cron, webhook, watch or subagent wake.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Short phrase for the audit log." })),
    }),
    async execute(callId, params) {
      if (!ref.replyOptional && !surfaceTools) {
        await recordCall(callId, { tool: "finish_silently", ...(params.reason ? { reason: params.reason } : {}) });
        return recordResult(
          callId,
          { tool: "finish_silently", noop: "reply_required" },
          text(
            "[no-op] finish_silently only applies to surface turns, scheduled background fires or subagent wakes; a person is waiting on this turn — just reply.",
          ),
          true,
        );
      }
      ref.silentRequested = true;
      try {
        await recordCall(callId, { tool: "finish_silently", ...(params.reason ? { reason: params.reason } : {}) });
        return await recordResult(
          callId,
          { tool: "finish_silently", silent: true },
          { ...text("Turn ended without a closing reply."), terminate: true },
        );
      } catch (e) {
        ref.silentRequested = false;
        throw e;
      }
    },
  });

  const context = defineTool({
    name: "context",
    label: "context",
    description:
      "Shrink model context to recent entries, the saved summary if it fits, and goal state (stored history is untouched). The unfinished request then resumes; do not repeat completed actions. Call it alone after other tools finish.",
    parameters: Type.Object({ action: Type.Literal("compact"), mode: Type.Literal("recent") }),
    async execute(callId, params) {
      await recordCall(callId, { tool: "context", ...params });
      const result = await recordCoreAuthoredResult(
        callId,
        { tool: "context", ...params, ok: true },
        {
          ...text("Recent-context recovery requested. Continue from recorded results after the context is reduced."),
          terminate: true,
        },
      );
      ref.runtimeHandoff = { context: "recent" };
      return result;
    },
  });

  const runtime = defineTool({
    name: "runtime",
    label: "runtime",
    description:
      "Inspect or change your model, effort and fast mode. get: active runtime and choices, with the account each model bills. set: change it (omitted settings kept). A change stops this runtime and resumes the task on the new one, so call it alone after other tools finish. lifetime task (default) covers this request or cron fire; scope also sets the scope default. Changes need a live user, except task changes in a cron fire, and are refused while a goal is open. Check here before claiming you cannot switch.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
      model: Type.Optional(Type.String({ description: "Model ID or exact display name from get." })),
      effort: Type.Optional(
        Type.String({
          description:
            "A level from get's modelCatalog[model].effortLevels. adaptive = native Auto; default = provider default; auto = legacy default.",
        }),
      ),
      fastMode: Type.Optional(Type.Boolean()),
      lifetime: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("scope")])),
    }),
    async execute(callId, params) {
      const request = params as RuntimeRequest;
      await recordCall(callId, { tool: "runtime", ...request });
      if (request.action !== "get" && goalIsOpen(ref.goal)) {
        return recordCoreAuthoredResult(
          callId,
          { tool: "runtime", error: "goal_in_progress" },
          text(
            "Runtime changes are unavailable while a goal or work floor is unfinished. Continue the goal on the current runtime.",
          ),
          true,
        );
      }
      const result =
        opts?.readOnly && request.action !== "get"
          ? { ok: false as const, error: "read_only" }
          : ((await ref.current?.runtime?.(request, ref.abortSignal)) ?? { ok: false, error: "runtime_unavailable" });
      const handoff = result.ok ? result.handoff : undefined;
      const ret = await recordCoreAuthoredResult(
        callId,
        {
          tool: "runtime",
          action: request.action,
          ok: result.ok,
          ...(handoff ? { runtimeHandoff: handoff, actorId: ref.runtimeActorId } : {}),
          ...(result.ok && request.action === "get" && isObj(result.active) ? { runtimeActive: result.active } : {}),
        },
        { ...text(JSON.stringify(result)), ...(handoff ? { terminate: true } : {}) },
        !result.ok,
      );
      if (handoff) ref.runtimeHandoff = handoff;
      return ret;
    },
  });

  const withdrawApproval = defineTool({
    name: "withdraw_approval",
    label: "withdraw_approval",
    description:
      "Withdraw a pending approval card you raised in this conversation so it can no longer be approved, e.g. when the person changes their mind before approving. Pass the card id from the blocked call's result.",
    parameters: Type.Object({
      card: Type.String({ description: "Card id shown in the blocked call's result." }),
    }),
    async execute(callId, params) {
      await recordCall(callId, { tool: "withdraw_approval", card: params.card });
      const withdraw = ref.current?.withdrawApproval;
      if (!withdraw)
        return recordResult(
          callId,
          { tool: "withdraw_approval", ok: false },
          text("[error] approval cards can't be withdrawn on this turn."),
          true,
        );
      const { withdrawn } = await withdraw(params.card);
      if (!withdrawn.length)
        return recordResult(
          callId,
          { tool: "withdraw_approval", ok: false },
          text(`[not found] no pending approval card ${params.card} in this conversation; it may already be resolved.`),
          true,
        );
      return recordResult(
        callId,
        { tool: "withdraw_approval", ok: true, withdrawn },
        text(`[withdrawn] ${withdrawn.join("; ")} — the card can no longer be approved.`),
      );
    },
  });

  return { attach, finishSilently, context, runtime, withdrawApproval };
}
