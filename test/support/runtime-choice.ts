import { parseRuntimeChoice } from "../../src/model/pi-models.ts";
import type { RuntimeChoice, RuntimeChoiceInput } from "../../src/harness/harness.ts";

export function runtimeChoice(input: RuntimeChoiceInput): RuntimeChoice {
  const parsed = parseRuntimeChoice(input);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.choice;
}
