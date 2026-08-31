import { spawn } from "node:child_process";

const CONSENT_TIMEOUT_MS = 30_000;

export type ConsentMode = "read-write" | "read-only" | "deny";

export type ConsentResult = { ok: true; mode: ConsentMode } | { ok: false; reason: string };

const VERB: Record<ConsentMode, string> = {
  "read-write": "enable",
  "read-only": "disable",
  deny: "forget",
};

export function parseConsentMode(value: unknown): ConsentMode | null {
  return value === "read-write" || value === "read-only" || value === "deny" ? value : null;
}

export function setConsent(
  bin: string,
  scopeId: string,
  mode: ConsentMode,
  opts?: { env: NodeJS.ProcessEnv; apiKey?: string },
): Promise<ConsentResult> {
  return new Promise((resolve) => {
    const [cmd = "memorable", ...preArgs] = bin.split(" ").filter(Boolean);
    const child = spawn(cmd, [...preArgs, VERB[mode], "--scope", scopeId], {
      stdio: ["ignore", "ignore", "ignore"],
      ...(opts ? { env: { ...opts.env, ...(opts.apiKey ? { MEMORABLE_API_KEY: opts.apiKey } : {}) } } : {}),
    });
    let settled = false;
    const finish = (result: ConsentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "timeout" });
    }, CONSENT_TIMEOUT_MS);
    timer.unref();
    child.on("error", (e) => finish({ ok: false, reason: e.message.slice(0, 200) }));
    child.on("exit", (code) => finish(code === 0 ? { ok: true, mode } : { ok: false, reason: `exit ${code}` }));
  });
}
