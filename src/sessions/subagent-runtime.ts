import type { RuntimeChoice } from "../agent/agent.ts";
import { swallowAs } from "../util/errors.ts";
import type { SessionOpenInput, SessionSyscallBinding } from "./session-syscalls.ts";

type OpenRuntime = Pick<SessionOpenInput, "model" | "thinkingLevel" | "fastMode">;

export function parentRuntime(request: SessionSyscallBinding["request"], switched?: RuntimeChoice): OpenRuntime {
  if (!switched) return request;
  return { model: switched.modelId, thinkingLevel: switched.effortLevel, fastMode: switched.fastMode };
}

export async function openRuntime(
  input: SessionOpenInput,
  parent: OpenRuntime,
  validate: (choice: OpenRuntime) => Promise<void>,
  defaultModel: () => Promise<string | undefined>,
): Promise<OpenRuntime> {
  if (
    !input.model &&
    parent.model &&
    parent.model !== (await defaultModel().catch(swallowAs("subagents: resolve default model", undefined)))
  ) {
    const inherited = {
      model: parent.model,
      thinkingLevel: input.thinkingLevel ?? parent.thinkingLevel,
      fastMode: input.fastMode ?? parent.fastMode,
    };
    const usable = await validate(inherited)
      .then(() => inherited)
      .catch(swallowAs("subagents: inherit parent runtime", null));
    if (usable) return usable;
  }
  await validate(input);
  return input;
}
