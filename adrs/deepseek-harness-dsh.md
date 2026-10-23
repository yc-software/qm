# Support DeepSeek Harness (dsh)

QM already has first-class harnesses for Claude Code, Codex, Pi, and OpenCode. DeepSeek now ships its own open-source agent harness: DeepSeek Harness (`dsh`, npm `@deepseek-ai/dsh`, github.com/deepseek-ai/deepseek-harness). Same category as Claude Code and Codex: repo tools, shell, plans, subagents, sessions.

We can already call DeepSeek models over the API through Pi or OpenCode (and OpenRouter). What we cannot do is pick DeepSeek Harness as the session harness the way we pick Claude Code or Codex.

I'd like QM to support DeepSeek Harness as a first-class harness option, wired like the existing ones, so a session can run on `dsh` when that runtime is the right fit (especially with DeepSeek models). Not asking to change the model catalog, just to add the harness.
