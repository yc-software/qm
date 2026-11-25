import { hashId } from "../util/crypto.ts";
import { NeedsApproval } from "./primitives.ts";

interface SignOffStep {
  summary: string;
  key: string;
}

export function inTurnSignOff(authorize: (command: string, approvalKey?: string, exact?: boolean) => boolean) {
  return async (step: SignOffStep | string): Promise<boolean> => {
    const { summary, key: plain } = typeof step === "string" ? { summary: step, key: step } : step;
    const key = `signoff:${hashId([plain], 64)}`;
    if (authorize(summary, key, true)) return true;
    throw new NeedsApproval(summary, "needs your sign-off", "approval", undefined, key, {
      session: false,
      always: false,
    });
  };
}

function brainForgetStep(ids: readonly string[]): SignOffStep | undefined {
  const refs = ids.filter((id) => id.includes(":")).toSorted();
  if (!refs.length) return undefined;
  return { summary: `Forget brain facts ${refs.join(" ")}`, key: `memory-forget:${refs.join(",")}` };
}

export async function signOffForget(ids: readonly string[], signOff: (step: SignOffStep) => Promise<boolean>) {
  const step = brainForgetStep(ids);
  return !step || signOff(step);
}
