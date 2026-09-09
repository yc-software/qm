import { evaluateSuccess, type SuccessCheckResult, type SuccessVerdict } from "../success-evaluation.ts";
import { shq } from "../../util/shell.ts";

const FACTORY_CHECKS = ["exact_head", "ci_green_on_head", "ledger_clean", "mergeable"] as const;

const DEFAULT_SCRIPT_PATH = "tools/factory/converge-vector.sh";
const SHELL_SAFE = /^[A-Za-z0-9._/-]+$/;

export interface FactoryEvaluateInput {
  exec: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  attempt: number;
  mrNumber: number;
  branch: string;
  headSha?: string;
  scriptPath?: string;
}

export function parseVector(stdout: string): Map<string, string> {
  const vector = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    vector.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return vector;
}

const shellArg = (value: string): string => (SHELL_SAFE.test(value) ? value : shq(value));

export async function evaluateFactoryItem(input: FactoryEvaluateInput): Promise<SuccessVerdict> {
  const argv = [
    "bash",
    shellArg(input.scriptPath ?? DEFAULT_SCRIPT_PATH),
    shellArg(String(input.mrNumber)),
    shellArg(input.branch),
  ];
  if (input.headSha) argv.push(shellArg(input.headSha));

  const { code, stdout } = await input.exec(argv.join(" "));
  const vector = parseVector(stdout);
  const degraded = code !== 0 || vector.get("vector_readable") !== "true";

  const resultFor = (name: string): SuccessCheckResult => {
    if (degraded)
      return { command: name, passed: false, detail: `vector_error: ${vector.get("vector_error") ?? `exit ${code}`}` };
    const detail = vector.get(`${name}_detail`);
    return { command: name, passed: vector.get(name) === "true", ...(detail === undefined ? {} : { detail }) };
  };

  return evaluateSuccess({
    condition: "pull request converged",
    attempt: input.attempt,
    checks: [...FACTORY_CHECKS],
    runCheck: async (name) => resultFor(name),
    judge: async () => ({ met: true, reason: "all convergence checks passed" }),
  });
}
