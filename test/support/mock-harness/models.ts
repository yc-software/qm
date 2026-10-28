import type { Item } from "../../../src/sessions/items.ts";
import type { HarnessDetectInput, HarnessDetectResult, HarnessModelUtilities } from "../../../src/harness/harness.ts";
import { TitleRejected } from "../../../src/core/turn-error.ts";
import { compactionThroughSeq, compactTranscript } from "../../../src/harness/context-compaction.ts";
import { countTokens } from "../../../src/util/tokens.ts";
import { SECURITY_SCREEN_STEP, SECURITY_SCREEN_SYSTEM_PROMPT } from "../../../src/security/security-screen.ts";

export function createMockModels(flakyScreens: Set<string>): HarnessModelUtilities {
  return {
    shouldRespond(detect: HarnessDetectInput): Promise<HarnessDetectResult> {
      const msg = detect.message.trim();
      const first = msg.split("\n")[0]?.trim() ?? "";
      if (first.startsWith("!")) return Promise.resolve({ respond: true, reason: "command" });
      if (msg.endsWith("?")) return Promise.resolve({ respond: true, reason: "question" });
      if (/\b(agent|bot)\b/i.test(msg)) return Promise.resolve({ respond: true, reason: "addressed" });
      if (
        detect.reactionGuidance?.trim() &&
        /\b(thanks|thank you|thx|ty|nice|great|awesome|perfect|lgtm)\b/i.test(msg)
      ) {
        return Promise.resolve({ respond: false, reactions: ["pray"], reason: "acknowledgement" });
      }
      if (detect.threadOpener?.trim()) return Promise.resolve({ respond: true, reason: "own thread" });
      return Promise.resolve({ respond: false, reason: "not addressed" });
    },

    async compactHistory({ history }) {
      return deterministicCompactSummary(history);
    },

    oneShot(systemPrompt: string, prompt: string): Promise<string | undefined> {
      if (systemPrompt.startsWith("You extract durable facts worth remembering")) {
        const facts: string[] = [];
        for (const match of prompt.matchAll(/User said:\n([\s\S]*?)\n\nAssistant replied:/g)) {
          for (const raw of (match[1] ?? "").split(/[\n.!?]+/)) {
            const sentence = raw.trim();
            if (!sentence || sentence.startsWith("!")) continue;
            const remembered = /\bremember(?:\s+that)?\b[:,]?\s*(.+)/i.exec(sentence)?.[1];
            if (remembered) facts.push(remembered.trim());
            else if (/^(my|i'm|i am|i prefer|i work|i use|i like|call me)\b/i.test(sentence)) facts.push(sentence);
          }
        }
        return Promise.resolve(facts.length ? facts.map((fact) => `- ${fact}`).join("\n") : "NONE");
      }
      return Promise.resolve(`mock one-shot reply to: ${prompt.slice(0, 200)}`);
    },

    judge(_systemPrompt: string, prompt: string): Promise<string | undefined> {
      if (/!judge-down\b/i.test(prompt)) return Promise.reject(new Error("judge model unavailable"));
      const asked = /!engage-asked\b[:\s]*(.*)/i.exec(prompt);
      if (asked) {
        const id = /^\[([^\]]+)\]/m.exec(prompt)?.[1];
        return Promise.resolve(
          JSON.stringify({
            act: true,
            reason: (asked[1] ?? "").trim() || "someone asked",
            ...(id ? { asked_by: id } : {}),
          }),
        );
      }
      const m = /!engage\b(?!-asked)[:\s]*(.*)/i.exec(prompt);
      if (m)
        return Promise.resolve(JSON.stringify({ act: true, reason: (m[1] ?? "").trim() || "standing order matched" }));
      return Promise.resolve(JSON.stringify({ act: false }));
    },

    async screenSecurity({
      payload,
      modelId,
      systemPrompt = SECURITY_SCREEN_SYSTEM_PROMPT,
      signal,
      recordModelCall,
      recordLlmRequest,
    }) {
      const model = modelId ?? "mock-security";
      recordModelCall({
        model,
        inputTokens: countTokens(systemPrompt) + countTokens(payload),
        entryCount: 1,
      });
      await recordLlmRequest?.({
        turnSeq: null,
        step: SECURITY_SCREEN_STEP,
        model,
      });
      if (/!security-screen-hang/i.test(payload)) {
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
      }
      if (/!security-screen-unavailable/i.test(payload)) return Promise.resolve(undefined);
      if (/!security-screen-flaky-once/i.test(payload) && !flakyScreens.has(payload)) {
        flakyScreens.add(payload);
        return Promise.resolve(undefined);
      }
      const strict = /ignore (?:all|prior|previous) instructions|reveal (?:the )?secrets?|!security-risk/i.test(
        payload,
      );
      return Promise.resolve(
        strict ? { decision: "strict", reason: "instruction in untrusted data" } : { decision: "auto" },
      );
    },

    generateTitle(transcript: string): Promise<string | undefined> {
      if (transcript.includes("Simulate title provider exception"))
        return Promise.reject(new Error("title model overloaded"));
      if (transcript.includes("Simulate reply-shaped title"))
        return Promise.reject(new TitleRejected("reply_opener", "Sorry, I can't title this one"));
      if (transcript.includes("Simulate four-way title outage")) return Promise.resolve(undefined);
      const line = transcript
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !/^(user|assistant):$/i.test(l));
      if (!line) return Promise.resolve(undefined);
      const words = line.split(/\s+/).slice(0, 5).join(" ");
      return Promise.resolve(words ? `Chat: ${words}` : undefined);
    },

    summarizeApproval(command: string, reason: string): Promise<string | undefined> {
      if (command.includes("!summary-boom")) return Promise.reject(new Error("boom: simulated summary fault"));
      if (command.includes("!summary-hang")) return new Promise(() => {});
      if (command.includes("!summary-none")) return Promise.resolve(undefined);
      return Promise.resolve(`In plain English: ${command.split("\n")[0]!.slice(0, 80)} (${reason}).`);
    },
  };
}

export function deterministicCompactSummary(history: Item[]): string {
  const throughSeq = compactionThroughSeq(history);
  const header = `Compacted ${history.length} prior entr${history.length === 1 ? "y" : "ies"} through seq ${throughSeq}.`;
  return `${header}\n${compactTranscript(history)}`;
}
