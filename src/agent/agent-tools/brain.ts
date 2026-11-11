import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askBrain, BRAIN_ACTIONS } from "../../memory/brain.ts";
import { text, type ToolKit } from "./kit.ts";

const BRAIN = Type.Optional(
  Type.String({ description: "Which brain to ask, from the list below; optional with one brain or a ref." }),
);

export function brainTool(kit: ToolKit) {
  const { ref, recordCall, recordExternalResult, recordCoreAuthoredResult, resourceTool } = kit;
  const brains = ref.current?.brain?.brains ?? [];
  if (!brains.length) return [];
  const lookup = async (
    callId: string,
    params: { action: string; brain?: string; query?: string; ref?: string; after?: string },
    signal?: AbortSignal,
  ) => {
    const access = ref.current?.brain;
    if (!access) return text("[error] no active tool context");
    const input = {
      action: params.action,
      ...(params.brain !== undefined ? { brain: params.brain } : {}),
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(params.ref !== undefined ? { ref: params.ref } : {}),
      ...(params.after !== undefined ? { after: params.after } : {}),
    };
    await recordCall(callId, { tool: "brain", ...input });
    const answer = await askBrain(access, input, signal);
    const summary = { tool: "brain", action: params.action, ...answer.summary };
    return answer.fromBrain
      ? recordExternalResult(callId, summary, text(answer.text), `brain:${answer.summary.brain}`, null, answer.isError)
      : recordCoreAuthoredResult(callId, summary, text(answer.text), answer.isError);
  };
  const actions = [...new Set(brains.flatMap((brain) => brain.actions))];
  const tool = resourceTool(
    "brain",
    Object.fromEntries(
      actions.map((action) => [
        action,
        defineTool({
          name: "brain",
          label: "brain",
          description: BRAIN_ACTIONS[action].describe,
          parameters: Type.Object({ brain: BRAIN, ...BRAIN_ACTIONS[action].parameters }),
          execute: (callId, params, signal) => lookup(callId, params as Parameters<typeof lookup>[1], signal),
        }),
      ]),
    ),
  );
  return [
    {
      ...tool,
      description: [
        "Look up people, companies, meetings and notes in the person's own knowledge brains, read as them. " +
          "When they mention someone or something you don't recognize, check here before saying you don't know it. " +
          "Results are their private data: use them for this person and never repeat them where anyone else can read. " +
          "Each record carries a `ref` (brain:source:slug); pass it back as `ref` to open, trace or brief exactly that record.",
        tool.description,
        brains.map((brain) => `- ${brain.id} (${brain.label}): ${brain.actions.join(", ")}`).join("\n"),
      ].join("\n\n"),
    },
  ];
}
