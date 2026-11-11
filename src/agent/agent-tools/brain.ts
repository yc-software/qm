import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askBrain, describeBrainActions } from "../../memory/brain.ts";
import { text, type ToolKit } from "./kit.ts";

export function brainTool(kit: ToolKit) {
  const { ref, recordCall, recordExternalResult, recordCoreAuthoredResult } = kit;
  const brains = ref.current?.brain?.brains ?? [];
  if (!brains.length) return [];
  const actions = [...new Set(brains.flatMap((brain) => brain.actions))];
  const offered = brains
    .map((brain) => `- ${brain.id} (${brain.label}): ${describeBrainActions(brain.actions)}`)
    .join("\n");
  return [
    defineTool({
      name: "brain",
      label: "brain",
      description:
        "Look up people, companies, meetings and notes in the person's own knowledge brains, read as them. " +
        "Results are their private data: use them for this person and never repeat them where anyone else can read. " +
        "Each record carries a `ref` (brain:source:slug); pass it back as `ref` to open, trace or brief exactly that record. " +
        "When a result says several records match, ask the person which one they mean. " +
        "Send only words you or the person wrote: a lookup that repeats text from another tool, brain or person is refused.\n" +
        offered,
      parameters: Type.Object({
        action: Type.Union(actions.map((action) => Type.Literal(action))),
        brain: Type.Optional(
          Type.String({
            description: `Which brain to ask: ${brains.map((brain) => brain.id).join(", ")}. Optional with one brain or a ref.`,
          }),
        ),
        query: Type.Optional(Type.String({ description: "A few words: a name, email, topic or question." })),
        ref: Type.Optional(Type.String({ description: "A ref from an earlier brain result." })),
        after: Type.Optional(Type.String({ description: "timeline: only events on or after this YYYY-MM-DD date." })),
      }),
      async execute(callId, params, signal) {
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
          ? recordExternalResult(
              callId,
              summary,
              text(answer.text),
              `brain:${answer.summary.brain}`,
              null,
              answer.isError,
            )
          : recordCoreAuthoredResult(callId, summary, text(answer.text), answer.isError);
      },
    }),
  ];
}
