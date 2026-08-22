# Allow memory to be served by an external backend

Memory is one markdown notebook per scope (`memory/MEMORY.md`), recalled into the
prompt each turn and captured after it. The backend is fixed in `wiring.ts` —
Postgres when `DATABASE_URL` is set, a file workspace otherwise — and `chassis`
exposes no turn-lifecycle hooks, so a deployment that wants to reuse an existing
memory system (a layered/vector store with its own atom→scene→persona pyramid and
BM25+semantic recall) has no integration point short of forking core.

The built-in notebook should stay the zero-config default; it is small and
human-curatable. The gap is only the missing seam: nothing generic lets an external
memory service take over recall and capture without a core edit.

Two shapes, and we would like the project's view before building either:

- A pluggable `MemoryService` chosen by config (`MEMORY_BACKEND=http`,
  `MEMORY_URL=…`) — one more `MemoryService` that delegates `recall`/`capture`/
  `query` to an HTTP sidecar. Minimal, but `recall` returns a markdown body string,
  so a layered backend has to flatten its atoms and persona into one block to fit,
  losing the structure that made it worth plugging in.
- A turn-lifecycle hook on the plugin surface — a `memory` provider returning
  structured recall the orchestrator renders, plus `onTurnEnd` for capture, with the
  notebook as the built-in provider. More surface, but a layered backend keeps its
  tiers and the notebook stays the default.

Would qm take either — an HTTP memory backend, a structured recall hook, or both
behind one config? We have mapped the integration surface and can implement whichever
the project prefers.
