import assert from "node:assert/strict";
import test from "node:test";
import {
  deploymentAfterRestore,
  deploymentActionView,
  deploymentArchiveUndoAvailable,
  deploymentCanManage,
  deploymentContextScope,
  deploymentInScope,
  deploymentListAfterRestoreRefresh,
  deploymentListRefreshCanRedraw,
  deploymentLatestAt,
  deploymentSlug,
  deploymentTab,
  deploymentTabEmptyMessage,
  deploymentTitle,
  filterDeployments,
  friendlyPrincipal,
  type DeploymentView,
} from "../src/deploy-view.ts";

function deployment(patch: Partial<DeploymentView>): DeploymentView {
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

test("deployment labels prefer friendly metadata and retain durable fallbacks", () => {
  assert.equal(
    deploymentTitle(deployment({ displayName: "Launch dashboard", name: "launch", id: "id" })),
    "Launch dashboard",
  );
  assert.equal(deploymentTitle(deployment({ displayName: "", name: "launch", id: "id" })), "launch");
  assert.equal(deploymentSlug(deployment({ name: undefined, id: "stable-id" })), "stable-id");
  assert.equal(friendlyPrincipal("blair.reeves@example.com"), "Blair Reeves");
});

test("deployment context prefers its creation scope and filtering accepts either creation or ownership", () => {
  const fromChannel = deployment({ createdInScope: "channel:launch", ownerScopeId: "personal:blair@example.com" });
  assert.equal(deploymentContextScope(fromChannel), "channel:launch");
  assert.equal(deploymentInScope(fromChannel, "channel:launch"), true);
  assert.equal(deploymentInScope(fromChannel, "personal:blair@example.com"), true);
  assert.equal(deploymentInScope(fromChannel, "channel:other"), false);
  assert.equal(deploymentContextScope(deployment({ createdInScope: undefined, ownerScopeId: "org:acme" })), "org:acme");
});

test("archive Undo remains available when the post-mutation list refresh is stale or missing", () => {
  const archivedToast = deployment({ status: "archived" });
  assert.equal(deploymentArchiveUndoAvailable(archivedToast), true);
  assert.equal(deploymentArchiveUndoAvailable(deployment({ status: "running" })), false);
});

test("a restored notification cannot inherit Undo from a stale archived list row", () => {
  const staleArchivedRow = deployment({ status: "archived" });
  const restoredToast = deploymentAfterRestore(staleArchivedRow);
  assert.equal(deploymentArchiveUndoAvailable(restoredToast), false);
  assert.equal(restoredToast.status, "running");
  assert.equal(deploymentTab(restoredToast, "blair@example.com"), "yours");
});

test("restore ignores a stale archived row when refresh failed", () => {
  const requested = deployment({
    status: "archived",
    ownerScopeId: "personal:casey@example.com",
    createdBy: "casey@example.com",
  });
  const restored = deploymentAfterRestore(requested, undefined, undefined);
  assert.equal(restored.status, "running");
  assert.equal(deploymentTab(restored, "blair@example.com"), "shared");
});

test("a superseded restore refresh cannot overwrite a newer authoritative row", () => {
  const newer = deployment({ id: "deployment-id", status: "archived", displayName: "Newer metadata" });
  const staleRestore = deploymentAfterRestore(deployment({ id: "deployment-id", status: "archived" }));
  const list = deploymentListAfterRestoreRefresh([newer], staleRestore, "superseded");
  assert.deepEqual(list, [newer]);
  assert.equal(list[0]?.status, "archived");
  assert.equal(list[0]?.displayName, "Newer metadata");
});

test("an updated restore refresh trusts a newer authoritative archived row", () => {
  const requested = deployment({ id: "deployment-id", status: "archived", displayName: "Old metadata" });
  const authoritative = deployment({ id: "deployment-id", status: "archived", displayName: "Newer metadata" });
  const restored = deploymentAfterRestore(requested, deploymentAfterRestore(requested), authoritative);
  assert.equal(restored, authoritative);
  assert.equal(restored.status, "archived");
  assert.equal(restored.displayName, "Newer metadata");
});

test("an actual restore refresh failure inserts the optimistic running row", () => {
  const stale = deployment({ id: "deployment-id", status: "archived" });
  const restored = deploymentAfterRestore(stale);
  assert.deepEqual(deploymentListAfterRestoreRefresh([stale], restored, "failed"), [restored]);
});

test("tabs separate manageable, shared, and archived deployments", () => {
  assert.equal(deploymentTab(deployment({ permission: "write" }), "blair@example.com"), "yours");
  assert.equal(
    deploymentTab(
      deployment({ permission: "write", createdBy: "casey@example.com", ownerScopeId: "personal:casey@example.com" }),
      "blair@example.com",
    ),
    "shared",
  );
  assert.equal(
    deploymentTab(
      deployment({ permission: "write", createdBy: "blair@example.com", ownerScopeId: "personal:casey@example.com" }),
      "blair@example.com",
    ),
    "shared",
  );
  assert.equal(deploymentTab(deployment({ permission: "read", status: "archived" }), "blair@example.com"), "archived");
});

test("the empty Yours message stays tab-local when a manageable transfer is Shared", () => {
  const transferred = deployment({
    ownerScopeId: "personal:casey@example.com",
    createdBy: "blair@example.com",
    permission: "write",
  });
  assert.equal(deploymentTab(transferred, "blair@example.com"), "shared");
  assert.equal(deploymentTabEmptyMessage("yours"), "No apps of your own yet.");
});

test("management actions fail closed when permission is missing or unknown", () => {
  assert.equal(deploymentCanManage(deployment({ permission: "write" })), true);
  assert.equal(deploymentCanManage(deployment({ permission: "read" })), false);
  assert.equal(deploymentCanManage(deployment({ permission: undefined })), false);
  assert.equal(deploymentCanManage({ ...deployment({}), permission: "admin" as "write" }), false);
});

test("a restored deployment returns to its live ownership tab", () => {
  const restoredPersonal = deployment({ status: "running" });
  const restoredShared = deployment({
    status: "running",
    ownerScopeId: "personal:casey@example.com",
    createdBy: "casey@example.com",
    permission: "write",
  });
  assert.equal(deploymentTab(restoredPersonal, "blair@example.com"), "yours");
  assert.equal(deploymentTab(restoredShared, "blair@example.com"), "shared");
});

test("last deployed uses the applied version instead of a pending version", () => {
  const d = deployment({
    currentVersion: 3,
    appliedVersion: 2,
    versions: [
      { version: 1, createdAt: 100 },
      { version: 2, createdAt: 200 },
      { version: 3, createdAt: 300 },
    ],
  });
  assert.equal(deploymentLatestAt(d), 200);
});

test("list filtering composes tab, context, search, and newest-first sorting", () => {
  const deployments = [
    deployment({
      id: "old",
      displayName: "Alpha report",
      ownerScopeId: "channel:eng",
      versions: [{ version: 1, createdAt: 100 }],
    }),
    deployment({
      id: "new",
      displayName: "Beta report",
      ownerScopeId: "channel:eng",
      versions: [{ version: 1, createdAt: 300 }],
    }),
    deployment({
      id: "personal",
      displayName: "Personal report",
      ownerScopeId: "personal:blair@example.com",
      versions: [{ version: 1, createdAt: 400 }],
    }),
    deployment({
      id: "shared",
      displayName: "Beta shared",
      ownerScopeId: "channel:eng",
      createdBy: "casey@example.com",
      permission: "read",
      versions: [{ version: 1, createdAt: 500 }],
    }),
    deployment({
      id: "created-in-eng",
      displayName: "Gamma report",
      ownerScopeId: "personal:blair@example.com",
      createdInScope: "channel:eng",
      versions: [{ version: 1, createdAt: 200 }],
    }),
  ];

  assert.deepEqual(
    filterDeployments(deployments, {
      tab: "yours",
      scope: "channel:eng",
      query: "report",
      viewer: "blair@example.com",
    }).map((d) => d.id),
    ["new", "created-in-eng", "old"],
  );
  assert.deepEqual(
    filterDeployments(deployments, { tab: "shared", scope: null, query: "beta", viewer: "blair@example.com" }).map(
      (d) => d.id,
    ),
    ["shared"],
  );
});

test("sorting supports newest, name, and status without changing the filtered set", () => {
  const deployments = [
    deployment({ id: "z", displayName: "Zulu", status: "stopped", versions: [{ version: 1, createdAt: 300 }] }),
    deployment({ id: "a", displayName: "Alpha", status: "running", versions: [{ version: 1, createdAt: 200 }] }),
  ];
  const options = { tab: "yours" as const, scope: null, query: "", viewer: "blair@example.com" };
  assert.deepEqual(
    filterDeployments(deployments, { ...options, sort: "newest" }).map((d) => d.id),
    ["z", "a"],
  );
  assert.deepEqual(
    filterDeployments(deployments, { ...options, sort: "name" }).map((d) => d.id),
    ["a", "z"],
  );
  assert.deepEqual(
    filterDeployments(deployments, { ...options, sort: "status" }).map((d) => d.id),
    ["a", "z"],
  );
});

test("delayed deployment actions re-check the active detail on resolve and reject", async () => {
  for (const action of ["edit", "archive", "restore"]) {
    for (const outcome of ["resolve", "reject"] as const) {
      let activeId = "A";
      let finish!: () => void;
      const pending = new Promise<void>((resolve, reject) => {
        finish = outcome === "resolve" ? resolve : () => reject(new Error(`${action} failed`));
      });
      const settled = pending.then(
        () => deploymentActionView("A", "deploys", activeId),
        () => deploymentActionView("A", "deploys", activeId),
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
    if (deploymentListRefreshCanRedraw(state.activeId)) state.detailLoading = false;
  });
  state.activeId = "A";
  state.detailLoading = true;
  finish();
  await completion;
  assert.equal(state.detailLoading, true);
});
