import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const ATTACHMENTS_REMOVED_KIND = "attachments_removed";

export function imageCountSince(session: AgentSession, from: number): number {
  return session.agent.state.messages
    .slice(from)
    .flatMap((m) => ((m as { content?: unknown }).content as Array<{ type?: string }> | undefined) ?? [])
    .filter((block) => block?.type === "image").length;
}

export function replaceImagesSince(session: AgentSession, from: number): void {
  const state = session.agent.state;
  state.messages = state.messages.map((m, i) => {
    const content = (m as { content?: unknown }).content;
    if (i < from || !Array.isArray(content)) return m;
    return {
      ...m,
      content: content.map((block: { type?: string; mimeType?: string }) =>
        block?.type === "image"
          ? {
              type: "text",
              text: `[${block.mimeType ?? "image"} removed: the model provider rejected a request that carried it]`,
            }
          : block,
      ),
    } as typeof m;
  });
}
