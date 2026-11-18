import { readFileSync } from "node:fs";

export type BabysitterTrigger = "step" | "text" | "final";

export interface BabysitterConfig {
  trigger: BabysitterTrigger;
  gate: boolean;
  gateModelId: string;
  modelId: string;
  rules: string;
  skipAttended: boolean;
  maxReminders: number;
  traceMessages: number;
}

const DEFAULT_RULES = `Wall of shame (from the QM spec), when the agent is writing or planning code:
- Overengineering: building more than the task needs; new subsystems, layers, retries, or config where reuse or deletion would do.
- Band-aid fixes: hiding a symptom instead of fixing its cause; special cases, string matching, yet another branch.
- Discarded error evidence: swallowing or replacing a failure so it cannot be seen.
- Declaring done without proof: claiming something works or shipped without having run it end to end.
General:
- Giving up or asking the user for something the agent could do itself.
- Drifting off the task it was given.`;

export const BABYSITTER_DEFAULTS: BabysitterConfig = {
  trigger: "text",
  gate: false,
  gateModelId: "claude-haiku-5-5",
  modelId: "claude-sonnet-5-5",
  rules: DEFAULT_RULES,
  skipAttended: true,
  maxReminders: 3,
  traceMessages: 40,
};

export function loadBabysitterConfig(path = process.env.BABYSITTER_CONFIG): BabysitterConfig {
  if (!path) return BABYSITTER_DEFAULTS;
  try {
    return { ...BABYSITTER_DEFAULTS, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<BabysitterConfig>) };
  } catch (error) {
    console.error(`[babysitter] config ${path} unreadable, using defaults: ${String(error)}`);
    return BABYSITTER_DEFAULTS;
  }
}

export const BABYSITTER_GATE_PROMPT = `You watch another AI agent's work in progress. Given a set of rules and the agent's recent trace, answer with exactly one word: YES if the agent is violating or clearly trending toward violating a rule, otherwise NO.`;

export const BABYSITTER_PROMPT = `You watch another AI agent's work in progress. You get a set of rules and the agent's recent trace (its messages, tool calls and tool results).

If the agent is violating or clearly trending toward violating a rule, write a reminder addressed to the agent: one or two plain sentences naming the rule and what in its current work to change. If nothing is wrong, reply with exactly NONE.

Most traces are fine. Speak up only for a concrete, current problem, never for a hypothetical one.`;

export function babysitterInput(rules: string, trace: string): string {
  return `<rules>\n${rules}\n</rules>\n\n<trace>\n${trace}\n</trace>`;
}

export const babysitterNote = (reminder: string): string => `[babysitter] ${reminder}`;
