import assert from "node:assert/strict";
import test from "node:test";
import { withAppDetailNotice, withAppListNotice, type AppNotices } from "../src/app-notices.ts";

test("delayed list mutations cannot erase another app's detail error", async () => {
  for (const action of ["edit", "archive", "restore"]) {
    for (const outcome of ["resolve", "reject"] as const) {
      let notices: AppNotices = { list: `${action} A…`, detail: { id: "B", text: "Could not load B." } };
      let finish!: () => void;
      const pending = new Promise<void>((resolve, reject) => {
        finish = outcome === "resolve" ? resolve : () => reject(new Error(`${action} failed`));
      });
      const settled = pending.then(
        () => {
          notices = withAppListNotice(notices, "");
        },
        () => {
          notices = withAppListNotice(notices, `${action} A failed.`);
        },
      );
      finish();
      await settled;
      assert.deepEqual(notices.detail, { id: "B", text: "Could not load B." }, `${action} ${outcome} erased B's error`);
    }
  }
});

test("detail notice updates preserve list status", () => {
  const notices = withAppDetailNotice({ list: "Refreshing apps…", detail: null }, "B", "Could not load B.");
  assert.equal(notices.list, "Refreshing apps…");
});
