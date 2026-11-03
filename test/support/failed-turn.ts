import assert from "node:assert/strict";
import type { BuiltApp } from "../../src/wiring.ts";
import type { TurnRequest } from "../../src/types.ts";

export async function failedTurnError(
  built: Pick<BuiltApp, "app" | "runs" | "errors">,
  request: TurnRequest,
): Promise<string> {
  const result = await built.app.turn(request);
  assert.equal(result.status, "failed", JSON.stringify(result));
  const threadRef = request.conversation.threadRef;
  const run = (await built.runs.list({ threadRef })).find((candidate) => candidate.sessionId === threadRef);
  const logged = (await built.errors.list()).filter(
    (e) =>
      e.category === "turn" &&
      ((result.sessionId !== undefined && e.sessionId === result.sessionId) ||
        (run !== undefined && e.message.startsWith(`run ${run.id}:`))),
  );
  return [result.reason ?? "", ...logged.map((e) => e.message)].join("\n");
}
