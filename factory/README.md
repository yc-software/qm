# factory

The software factory's instruction book, as Quartermaster's factory loop runs it inside a sandbox:

- `.claude/io-coding-agent-js.sh` — the coding-agent wrapper that drives one ticket end to end.
- `.claude/workflows/*.js` — the three Claude Code Workflow scripts (understand, build-and-ship, orchestrator).
- `.claude/workflows/prompts/`, `.claude/commands/`, `.claude/skills/` — the prompts and skill the wrapper hands the agent.
- `tools/factory/` — the shell tools the workflows call (verify, publish, source, proof, converge-vector, tools).

`IO_FACTORY_SOURCE_DIR` points at this directory; the wrapper snapshots every file it needs relative to it.
