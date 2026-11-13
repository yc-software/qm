import assert from "node:assert/strict";
import test from "node:test";
import {
  appAfterRestore,
  appActionView,
  appArchiveUndoAvailable,
  appCanManage,
  appContextScope,
  appInScope,
  appListAfterRestoreRefresh,
  appListRefreshCanRedraw,
  appLatestAt,
  appSlug,
  appTab,
  appTabEmptyMessage,
  appTitle,
  filterApps,
  friendlyPrincipal,
  type AppView,
} from "../src/deploy-view.ts";

function publishedApp(patch: Partial<AppView>): AppView {
  return {
    id: "deployment-id",
    status: "running",
    ownerScopeId: "personal:blair@example.com",
    createdBy: "blair@example.com",
    currentVersion: 1,
    permission: "write",
    versions: [{ version: 1, createdAt: 100 }],
    ...patch,
  };
}

test("app labels prefer friendly metadata and retain durable fallbacks", () => {
  assert.equal(
    appTitle(publishedApp({ displayName: "Launch dashboard", name: "launch", id: "id" })),
    "Launch dashboard",
  );
  assert.equal(appTitle(publishedApp({ displayName: "", name: "launch", id: "id" })), "launch");
  assert.equal(appSlug(publishedApp({ name: undefined, id: "stable-id" })), "stable-id");
  assert.equal(friendlyPrincipal("blair.reeves@example.com"), "Blair Reeves");
  assert.equal(friendlyPrincipal("oidc:5f2a:NzkzOTE"), "Unknown person");
});

test("app context prefers its creation scope and filtering accepts either creation or ownership", () => {
  const fromChannel = publishedApp({ createdInScope: "channel:launch", ownerScopeId: "personal:blair@example.com" });
  assert.equal(appContextScope(fromChannel), "channel:launch");
  assert.equal(appInScope(fromChannel, "channel:launch"), true);
  assert.equal(appInScope(fromChannel, "personal:blair@example.com"), true);
  assert.equal(appInScope(fromChannel, "channel:other"), false);
  assert.equal(appContextScope(publishedApp({ createdInScope: undefined, ownerScopeId: "org:acme" })), "org:acme");
});

test("archive Undo remains available when the post-mutation list refresh is stale or missing", () => {
  const archivedToast = publishedApp({ status: "archived" });
  assert.equal(appArchiveUndoAvailable(archivedToast), true);
  assert.equal(appArchiveUndoAvailable(publishedApp({ status: "running" })), false);
});

test("a restored notification cannot inherit Undo from a stale archived list row", () => {
  const staleArchivedRow = publishedApp({ status: "archived" });
  const restoredToast = appAfterRestore(staleArchivedRow);
  assert.equal(appArchiveUndoAvailable(restoredToast), false);
  assert.equal(restoredToast.status, "running");
  assert.equal(appTab(restoredToast, "blair@example.com"), "yours");
});

test("restore ignores a stale archived row when refresh failed", () => {
  const requested = publishedApp({
    status: "archived",
    ownerScopeId: "personal:casey@example.com",
    createdBy: "casey@example.com",
  });
  const restored = appAfterRestore(requested, undefined, undefined);
  assert.equal(restored.status, "running");
  assert.equal(appTab(restored, "blair@example.com"), "shared");
});

test("a superseded restore refresh cannot overwrite a newer authoritative row", () => {
  const newer = publishedApp({ id: "deployment-id", status: "archived", displayName: "Newer metadata" });
  const staleRestore = appAfterRestore(publishedApp({ id: "deployment-id", status: "archived" }));
  const list = appListAfterRestoreRefresh([newer], staleRestore, "superseded");
  assert.deepEqual(list, [newer]);
  assert.equal(list[0]?.status, "archived");
  assert.equal(list[0]?.displayName, "Newer metadata");
});

test("an updated restore refresh trusts a newer authoritative archived row", () => {
  const requested = publishedApp({ id: "deployment-id", status: "archived", displayName: "Old metadata" });
  const authoritative = publishedApp({ id: "deployment-id", status: "archived", displayName: "Newer metadata" });
  const restored = appAfterRestore(requested, appAfterRestore(requested), authoritative);
  assert.equal(restored, authoritative);
  assert.equal(restored.status, "archived");
  assert.equal(restored.displayName, "Newer metadata");
});

test("an actual restore refresh failure inserts the optimistic running row", () => {
  const stale = publishedApp({ id: "deployment-id", status: "archived" });
  const restored = appAfterRestore(stale);
  assert.deepEqual(appListAfterRestoreRefresh([stale], restored, "failed"), [restored]);
});

test("tabs separate manageable, shared, and archived apps", () => {
  assert.equal(appTab(publishedApp({ permission: "write" }), "blair@example.com"), "yours");
  assert.equal(
    appTab(
      publishedApp({ permission: "write", createdBy: "casey@example.com", ownerScopeId: "personal:casey@example.com" }),
      "blair@example.com",
    ),
    "shared",
  );
  assert.equal(
    appTab(
      publishedApp({ permission: "write", createdBy: "blair@example.com", ownerScopeId: "personal:casey@example.com" }),
      "blair@example.com",
    ),
    "shared",
  );
  assert.equal(appTab(publishedApp({ permission: "read", status: "archived" }), "blair@example.com"), "archived");
});

test("the empty Yours message stays tab-local when a manageable transfer is Shared", () => {
  const transferred = publishedApp({
    ownerScopeId: "personal:casey@example.com",
    createdBy: "blair@example.com",
    permission: "write",
  });
  assert.equal(appTab(transferred, "blair@example.com"), "shared");
  assert.equal(appTabEmptyMessage("yours"), "No apps of your own yet.");
});

test("management actions fail closed when permission is missing or unknown", () => {
  assert.equal(appCanManage(publishedApp({ permission: "write" })), true);
  assert.equal(appCanManage(publishedApp({ permission: "read" })), false);
  assert.equal(appCanManage(publishedApp({ permission: undefined })), false);
  assert.equal(appCanManage({ ...publishedApp({}), permission: "admin" as "write" }), false);
});

test("a restored app returns to its live ownership tab", () => {
  const restoredPersonal = publishedApp({ status: "running" });
  const restoredShared = publishedApp({
    status: "running",
    ownerScopeId: "personal:casey@example.com",
    createdBy: "casey@example.com",
    permission: "write",
  });
  assert.equal(appTab(restoredPersonal, "blair@example.com"), "yours");
  assert.equal(appTab(restoredShared, "blair@example.com"), "shared");
});

test("last deployed uses the applied version instead of a pending version", () => {
  const d = publishedApp({
    currentVersion: 3,
    appliedVersion: 2,
    versions: [
      { version: 1, createdAt: 100 },
      { version: 2, createdAt: 200 },
      { version: 3, createdAt: 300 },
    ],
  });
  assert.equal(appLatestAt(d), 200);
});

test("list filtering composes tab, context, search, and newest-first sorting", () => {
  const publishedApps = [
    publishedApp({
      id: "old",
      displayName: "Alpha report",
      ownerScopeId: "channel:eng",
      versions: [{ version: 1, createdAt: 100 }],
    }),
    publishedApp({
      id: "new",
      displayName: "Beta report",
      ownerScopeId: "channel:eng",
      versions: [{ version: 1, createdAt: 300 }],
    }),
    publishedApp({
      id: "personal",
      displayName: "Personal report",
      ownerScopeId: "personal:blair@example.com",
      versions: [{ version: 1, createdAt: 400 }],
    }),
    publishedApp({
      id: "shared",
      displayName: "Beta shared",
      ownerScopeId: "channel:eng",
      createdBy: "casey@example.com",
      permission: "read",
      versions: [{ version: 1, createdAt: 500 }],
    }),
    publishedApp({
      id: "created-in-eng",
      displayName: "Gamma report",
      ownerScopeId: "personal:blair@example.com",
      createdInScope: "channel:eng",
      versions: [{ version: 1, createdAt: 200 }],
    }),
  ];

  assert.deepEqual(
    filterApps(publishedApps, {
      tab: "yours",
      scope: "channel:eng",
      query: "report",
      viewer: "blair@example.com",
    }).map((d) => d.id),
    ["new", "created-in-eng", "old"],
  );
  assert.deepEqual(
    filterApps(publishedApps, { tab: "shared", scope: null, query: "beta", viewer: "blair@example.com" }).map(
      (d) => d.id,
    ),
    ["shared"],
  );
});

test("sorting supports newest, name, and status without changing the filtered set", () => {
  const publishedApps = [
    publishedApp({ id: "z", displayName: "Zulu", status: "stopped", versions: [{ version: 1, createdAt: 300 }] }),
    publishedApp({ id: "a", displayName: "Alpha", status: "running", versions: [{ version: 1, createdAt: 200 }] }),
  ];
  const options = { tab: "yours" as const, scope: null, query: "", viewer: "blair@example.com" };
  assert.deepEqual(
    filterApps(publishedApps, { ...options, sort: "newest" }).map((d) => d.id),
    ["z", "a"],
  );
  assert.deepEqual(
    filterApps(publishedApps, { ...options, sort: "name" }).map((d) => d.id),
    ["a", "z"],
  );
  assert.deepEqual(
    filterApps(publishedApps, { ...options, sort: "status" }).map((d) => d.id),
    ["a", "z"],
  );
});

test("delayed app actions re-check the active detail on resolve and reject", async () => {
  for (const action of ["edit", "archive", "restore"]) {
    for (const outcome of ["resolve", "reject"] as const) {
      let activeId = "A";
      let finish!: () => void;
      const pending = new Promise<void>((resolve, reject) => {
        finish = outcome === "resolve" ? resolve : () => reject(new Error(`${action} failed`));
      });
      const settled = pending.then(
        () => appActionView("A", "deploys", activeId),
        () => appActionView("A", "deploys", activeId),
      );
      activeId = "B";
      finish();
      assert.equal(await settled, "other", `${action} ${outcome} must preserve detail B`);
    }
  }
});

test("list refresh completion leaves a pending detail's loading state untouched", async () => {
  const state: { activeId?: string; detailLoading: boolean } = { detailLoading: false };
  let finish!: () => void;
  const refresh = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const completion = refresh.then(() => {
    if (appListRefreshCanRedraw(state.activeId)) state.detailLoading = false;
  });
  state.activeId = "A";
  state.detailLoading = true;
  finish();
  await completion;
  assert.equal(state.detailLoading, true);
});
