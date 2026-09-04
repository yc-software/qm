import type { MemoryStrategy } from "../strategy.ts";

export const AGENT_ONLY_PROMPT_LINES = [
  "Nothing is saved to memory automatically — you are its sole curator, through the `memory` tool.",
  'If you don\'t save a fact (`memory` action "remember"), it is gone when this conversation ends.',
  'Update, don\'t duplicate: when a fact changes, curate with action "rewrite" to fix the existing bullet instead of appending a contradicting one.',
  'Delete memories you discover are wrong, stale, or no longer useful (action "rewrite").',
  "Don't re-record what's already remembered, and don't save things that only matter to the current conversation.",
];

export function createAgentOnlyStrategy(): MemoryStrategy {
  return {
    promptLines: () => AGENT_ONLY_PROMPT_LINES,
  };
}
