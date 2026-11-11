import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BRAIN_ACTIONS, type BrainInput } from "../../memory/brain.ts";
import { text, type ToolKit } from "./kit.ts";

const BRAIN = Type.Optional(
  Type.String({ description: "Which brain to ask, from the list below; optional with one brain or a ref." }),
);

const GUIDANCE =
  "Look up people, companies, meetings and notes in the person's own knowledge brains, read as them. " +
  "When they mention someone or something you don't recognize, check here before saying you don't know it. " +
  "Before a meeting: whois the name or email, then brief and entity with the match's ref; a page or timeline is the evidence for a status or a date. " +
  "Pass a record's `ref` back to stay on exactly that record. " +
  "Each brain sees the words you send it, so look things up with a name or a few words of your own, never another brain's results. " +
  "Results are the person's private data: keep them in this conversation unless they ask you to share them, and say when a claim rests only on agent_written or external_untrusted rows.";

export function brainTool(kit: ToolKit) {
  const { ref, recordCall, recordExternalResult, recordCoreAuthoredResult, resourceTool } = kit;
  const brains = ref.current?.brain?.brains ?? [];
  if (!brains.length) return [];
  const lookup = async (callId: string, params: BrainInput, signal?: AbortSignal) => {
    const brain = ref.current?.brain;
    if (!brain) return text("[error] no active tool context");
    await recordCall(callId, { tool: "brain", ...params });
    const answer = await brain.ask(params, signal);
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
          execute: (callId, params, signal) => lookup(callId, params as BrainInput, signal),
        }),
      ]),
    ),
  );
  return [
    {
      ...tool,
      description: [
        GUIDANCE,
        tool.description,
        brains
          .map(
            (brain) =>
              `- ${brain.id} (${brain.label})${brain.actions.length < actions.length ? `: ${brain.actions.join(", ")}` : ""}`,
          )
          .join("\n"),
      ].join("\n\n"),
    },
  ];
}
