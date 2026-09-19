import { DurableTaskDeferred } from "../durable/tasks.ts";
import { withAbort } from "../util/async.ts";
import { reportFailure } from "../util/errors.ts";
import type { MemoryCaptureContext } from "./memory-service.ts";

export async function memoryCaptureEffect<T>(
  context: MemoryCaptureContext | undefined,
  operation: string,
  idempotent: boolean,
  run: () => Promise<T>,
): Promise<T> {
  const execute = () => withAbort(run, context?.signal);
  if (!context?.checkpoint) return execute();
  return context.checkpoint(`${operation}:completed`, async () => {
    if (!idempotent) {
      let first = false;
      await context.checkpoint!(`${operation}:started`, async () => {
        first = true;
        return true;
      });
      if (!first) {
        const error = new Error(`Memory capture ${operation} has an unknown write outcome and requires reconciliation`);
        await context.checkpoint!(`${operation}:uncertain`, async () => {
          reportFailure("memory: capture outcome", error);
          return { state: "uncertain", message: error.message };
        });
        throw new DurableTaskDeferred(300);
      }
    }
    return execute();
  });
}
