import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isObj } from "../../util/objects.ts";
import { goalIsOpen } from "../goal.ts";
import type { RuntimeRequest } from "../runtime-types.ts";
import { type ToolKit } from "./kit.ts";
import type { TurnGoal, TurnHalt } from "../turn-tool-state.ts";
import { optionalString, text } from "./shared.ts";

export function runtimeTools(kit: ToolKit, goal: Pick<TurnGoal, "current">, halt: Pick<TurnHalt, "handOff">) {
  const { ref, opts, recordCall, recordCoreAuthoredResult } = kit;
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
      halt.handOff({ context: "recent" });
      return result;
    },
  });

  const runtime = defineTool({
    name: "runtime",
    label: "runtime",
    description:
      "Inspect or change your model, effort and fast mode. get: active runtime and choices. set: change it (omitted settings kept). inherit: back to the scope default (with lifetime scope, clears the scope override). A change stops this runtime and resumes the task on the new one, so call it alone after other tools finish. lifetime task (default) covers this request or cron fire; scope also sets the scope default. Changes need a live user, except task changes in a cron fire, and are refused while a goal is open. Check here before claiming you cannot switch.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set"), Type.Literal("inherit")]),
      model: optionalString("Model ID or exact display name from get."),
      effort: optionalString(
        "A level from get's modelCatalog[model].effortLevels. adaptive = native Auto; default = provider default; auto = legacy default.",
      ),
      fastMode: Type.Optional(Type.Boolean()),
      lifetime: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("scope")])),
    }),
    async execute(callId, params) {
      const request = params as RuntimeRequest;
      await recordCall(callId, { tool: "runtime", ...request });
      if (request.action !== "get" && goalIsOpen(goal.current())) {
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
      if (handoff) halt.handOff(handoff);
      return ret;
    },
  });
  return { context, runtime };
}
