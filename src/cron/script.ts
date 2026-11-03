import type { CronScript } from "../triggers/types.ts";
import type { ExecResult } from "../sandbox/sandbox.ts";
import { errMessage } from "../util/errors.ts";

const OUTPUT_MAX_CHARS = 4000;
const VERDICT_MAX_CHARS = 300;

type Execute = (
  command: string,
  opts: { credentials?: string[]; sandboxId?: string; signal?: AbortSignal },
) => Promise<ExecResult>;

export interface CronScriptRun {
  handled: boolean;
  verdict: string;
  escalation?: string;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function lastLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

export async function runCronScript(
  script: CronScript,
  execute: Execute,
  signal?: AbortSignal,
): Promise<CronScriptRun> {
  let result: ExecResult | undefined;
  let failure: string | undefined;
  try {
    result = await execute(script.command, {
      ...(script.credentials?.length ? { credentials: script.credentials } : {}),
      ...(script.sandboxId ? { sandboxId: script.sandboxId } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    failure = errMessage(e);
  }
  const handled = result !== undefined && result.code === 0 && !result.timedOut;
  let exit = `exit ${result?.code}`;
  if (failure !== undefined) exit = `could not run: ${failure}`;
  else if (result?.timedOut) exit = "timed out";
  const summary = result ? (lastLine(result.stdout) ?? lastLine(result.stderr)) : undefined;
  const reason = clip((handled ? summary : (summary ?? exit)) ?? "", VERDICT_MAX_CHARS);
  const live = script.mode === "live";
  const verdict = handled
    ? `${live ? "handled by script" : "shadow: script would have handled it"}${reason ? `: ${reason}` : ""}`
    : `${live ? "escalated" : "shadow: script would have escalated"}: ${reason}`;
  if (handled || !live) return { handled, verdict };
  const output = result
    ? [result.stdout, result.stderr]
        .filter((s) => s.trim())
        .join("\n")
        .trim()
    : "";
  return {
    handled,
    verdict,
    escalation: [
      "[Cron script]",
      `This cron's script ran first and handed this fire to you (${exit}). Script: ${script.command}`,
      output
        ? `Its output:\n${output.length > OUTPUT_MAX_CHARS ? `...${output.slice(-OUTPUT_MAX_CHARS)}` : output}`
        : "It printed nothing.",
      "[End cron script]",
    ].join("\n"),
  };
}
