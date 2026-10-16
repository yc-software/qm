import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("UI did not reach the expected state");
}

function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>(".main button")].find(
    (item) => item.textContent?.replace(/\s+/g, "").trim() === text.replace(/\s+/g, ""),
  );
  assert.ok(result, `Missing button ${text}`);
  return result;
}

test("both trigger types share editing, archive and restore while preserving worklogs and event inputs", async () => {
  const base = {
    id: "demo",
    owner: "tester",
    ownerScopeId: "personal:tester",
    enabled: true,
    archived: false,
    title: "Daily review",
    action: "Review events",
    createdAt: 1,
  };
  const records: Record<string, typeof base> = { crons: { ...base }, webhooks: { ...base } };
  const h = await harness({
    path: "/webhooks/demo",
    api(path, init) {
      const parts = path.split("/");
      const kind = parts[2]!;
      if (!(kind in records)) return;
      const item = records[kind]!;
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as { title?: string; task?: string; archived?: boolean };
        if (patch.title) item.title = patch.title;
        if (patch.task) item.action = patch.task;
        if (patch.archived !== undefined) {
          item.archived = patch.archived;
          if (patch.archived) item.enabled = false;
        }
        return Response.json({ [kind === "crons" ? "cron" : "webhook"]: item });
      }
      if (parts[4] === "enable") {
        item.enabled = true;
        item.archived = false;
        return Response.json({ ok: true });
      }
      if (parts[4] === "runs")
        return Response.json({
          runs: [
            {
              fireKey: "run-1",
              threadRef: "run-1",
              firedAt: 100,
              endedAt: 200,
              status: "ok",
              sessionId: "worklog",
              ...(kind === "webhooks" ? { payload: "<script>unsafe()</script>" } : {}),
            },
          ],
        });
      return Response.json({
        [kind]: [
          {
            ...item,
            ...(kind === "crons"
              ? { schedule: { everyMs: 60000 } }
              : { verification: { scheme: "github" }, url: "http://localhost/incoming/demo" }),
          },
        ],
        visible: [],
      });
    },
  });
  try {
    await h.boot();
    for (const kind of ["webhooks", "crons"] as const) {
      if (kind === "crons") {
        h.switchView(kind);
        await until(() => Boolean(document.querySelector('.main a[href="/crons/demo"]')));
        (document.querySelector('.main a[href="/crons/demo"]') as HTMLElement).click();
      }
      await until(() => Boolean(document.querySelector('.main a[href="/s/worklog"]')));
      if (kind === "webhooks") {
        assert.equal(document.querySelector(".automation-run-input pre")?.textContent, "<script>unsafe()</script>");
        assert.equal(document.querySelectorAll(".main script").length, 0);
      }
      button("Edit").click();
      document.querySelector<HTMLInputElement>('input[name="title"]')!.value = `Updated ${kind}`;
      document.querySelector<HTMLTextAreaElement>('textarea[name="task"]')!.value = "Updated task";
      document
        .querySelector("form.automation-edit-dialog")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await until(() => !document.querySelector("form.automation-edit-dialog"));
      assert.equal(records[kind]?.title, `Updated ${kind}`);
      assert.equal(records[kind]?.action, "Updated task");
      assert.match(h.mainText(), /Updated task/);
      button("Archive").click();
      await until(() => Boolean(document.querySelector('[role="tab"][aria-selected="false"]')));
      button("Archived1").click();
      await until(() => Boolean(document.querySelector(`.main a[href="/${kind}/demo"]`)));
      (document.querySelector(`.main a[href="/${kind}/demo"]`) as HTMLElement).click();
      button("Unarchive").click();
      await until(() => !records[kind]!.archived && h.mainText().includes("Disabled"));
      button("Enable").click();
      await until(() => records[kind]!.enabled && h.mainText().includes("Enabled"));
      assert.ok(document.querySelector('.main a[href="/s/worklog"]'));
    }
  } finally {
    await h.close();
  }
});
