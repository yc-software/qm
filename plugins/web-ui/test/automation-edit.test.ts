import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("crons and webhooks share task validation, pending state, retry, and cancel behavior", async () => {
  const h = await harness({ path: "/" });
  try {
    const { render } = await import("lit");
    const { automationEditDialog } = await import("../src/automation-edit.ts");
    for (const kind of ["cron", "webhook"]) {
      const host = document.createElement("div");
      document.body.append(host);
      let saves = 0;
      let closed = 0;
      let saved = 0;
      let submitted: unknown;
      let finish: (value?: unknown) => void = () => {};
      let reject: (error: Error) => void = () => {};
      render(
        automationEditDialog({
          heading: `Edit ${kind}`,
          ...(kind === "cron" ? { title: "Daily review" } : {}),
          task: "Original task",
          hint: "Trigger settings",
          onCancel: () => {
            closed++;
          },
          onSaved: () => {
            saved++;
          },
          onSave: async (values) => {
            saves++;
            submitted = values;
            await new Promise((resolve, fail) => {
              finish = resolve;
              reject = fail;
            });
          },
        }),
        host,
      );
      const form = host.querySelector("form")!;
      const task = host.querySelector<HTMLTextAreaElement>('textarea[name="task"]')!;
      const submit = () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      task.value = "  ";
      submit();
      assert.equal(saves, 0);
      assert.match(host.querySelector(".form-error")!.textContent!, /required/);
      task.value = "  Updated task  ";
      submit();
      submit();
      assert.equal(saves, 1);
      assert.equal(task.disabled, true);
      assert.deepEqual(submitted, { ...(kind === "cron" ? { title: "Daily review" } : {}), task: "Updated task" });
      host.querySelector(".project-dialog-backdrop")!.dispatchEvent(new Event("click", { bubbles: true }));
      assert.equal(closed, 0);
      reject(new Error("Temporary failure"));
      await settle();
      assert.equal(task.value, "  Updated task  ");
      assert.equal(task.disabled, false);
      assert.match(host.textContent!, /Temporary failure/);
      submit();
      finish();
      await settle();
      assert.equal(saved, 1);
      (host.querySelector('button[type="button"]') as HTMLButtonElement).click();
      assert.equal(closed, 1);
      host.remove();
    }
  } finally {
    await h.close();
  }
});

test("webhook summaries distinguish accepted events from recorded completions", async () => {
  const { webhookRunSummary } = await import("../src/webhook-format.ts");
  const now = Date.now();
  assert.equal(webhookRunSummary({}), "never fired");
  assert.match(webhookRunSummary({ lastReceivedAt: now }), /^received /);
  assert.match(
    webhookRunSummary({ lastReceivedAt: now, lastFiredAt: now - 1000, lastError: "old failure" }),
    /^received /,
  );
  assert.equal(webhookRunSummary({ lastReceivedAt: now - 1000, lastFiredAt: now, lastError: "failed" }), "error");
  assert.doesNotMatch(webhookRunSummary({ lastFiredAt: now }), /never|received/);
});
