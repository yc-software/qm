import type { CandidateDestination, Destination } from "../types.ts";

export function sanitizeDestination(value: Destination): Destination {
  const source = value as Destination & Record<string, unknown>;
  return {
    type: source.type,
    target: source.target,
    ...(source.audienceScopeId !== undefined ? { audienceScopeId: source.audienceScopeId } : {}),
    ...(source.onBehalfOf !== undefined ? { onBehalfOf: source.onBehalfOf } : {}),
    ...(source.threadTs !== undefined ? { threadTs: source.threadTs } : {}),
    ...(source.editRef !== undefined ? { editRef: source.editRef } : {}),
    ...(source.taskList !== undefined
      ? {
          taskList: source.taskList.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
          })),
        }
      : {}),
    ...(source.unfurlLinks !== undefined ? { unfurlLinks: source.unfurlLinks } : {}),
    ...(source.react !== undefined ? { react: { messageTs: source.react.messageTs, emoji: source.react.emoji } } : {}),
    ...(source.delete !== undefined ? { delete: { messageTs: source.delete.messageTs } } : {}),
    ...(source.identity !== undefined ? { identity: source.identity } : {}),
    ...(source.debugFooter !== undefined ? { debugFooter: source.debugFooter } : {}),
  };
}

export function sanitizeCandidateDestination(value: CandidateDestination): CandidateDestination {
  return { ...sanitizeDestination(value), key: value.key, label: value.label };
}
