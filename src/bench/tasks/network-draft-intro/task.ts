import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type IntroKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<IntroKey>({
    id: "network-draft-intro",
    difficulty: "hard",
    family: "network",
    origin: "observed",
    evidence:
      "Proposed network workflow for qm: draft double opt-in introductions that follow the firm's intro policy. Not a workflow Garry listed.",
    sources: ["https://qm.ycombinator.com/", "https://github.com/yc-software/qm"],
    outputs: ["output/intros.json"],
    generate,
    prompt: () =>
      'inbox/request.md asks for opt-in emails to several people. Use profiles/ for context and follow policy/intro-policy.md exactly. Write output/intros.json as a JSON array with one entry per person in the request, in order: {"to", "subject", "body"} for an email, or {"to", "skipped": true, "reason"} when policy says not to write one.',
    verify,
  });
}

export function gold(f: Fixture<IntroKey>): Record<string, string> {
  const k = f.key;
  return {
    "output/intros.json": JSON.stringify(
      k.targets.map((t) =>
        t.blocked
          ? { to: t.name, skipped: true, reason: "on do-not-contact.csv" }
          : {
              to: t.name,
              subject: `Open to an intro to ${k.requester} (${k.requesterCompany})?`,
              body: `Hi ${t.name.split(" ")[0]},\n\nCongratulations on having ${t.milestone}. Would you be open to an intro to ${k.requester}? ${k.requester} runs ${k.requesterCompany} and is heading into ${k.topic}, which you went through at ${t.company}.\n\nIf yes, I will connect you both.\n\nThanks,\nThe Lumen team`,
            },
      ),
    ),
  };
}
