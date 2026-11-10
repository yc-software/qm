import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore, deployCurrentGitRef } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import type { DeployEndpoint, DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDeployBackings, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";

const PRODUCTION = "npm install && npm run build && npm start";
const DEV = "npm install --no-audit --no-fund && npm run dev";
const ENDPOINT: DeployEndpoint = { host: "body", port: 443, tls: true };
const OWNER = "U1";
const PACKAGE_WITH_DEV = JSON.stringify({ scripts: { dev: "vite --host --port $PORT", start: "node server.js" } });

interface Edit {
  entrypoint: string;
  files: string[];
  contents: string[];
  deletedPaths: string[];
  restart: boolean;
}

interface ProviderState {
  body: boolean;
  resolved: DeployEndpoint | null;
  failEntrypoint?: string;
  rotate?: boolean;
  reconciles: Array<{ commit: string | undefined; entrypoint: string }>;
  edits: Edit[];
}

function harness(opts: { liveEdits?: boolean } = {}) {
  const state: ProviderState = { body: true, resolved: ENDPOINT, reconciles: [], edits: [] };
  const provider: DeployProvider = {
    profile: { managedScaleToZero: true },
    apply: async () => {
      throw new Error("git-backed versions are reconciled");
    },
    reconcile: async (_d, version) => {
      if (version.entrypoint === state.failEntrypoint) throw new Error("build failed: cannot find module 'left-pad'");
      state.reconciles.push({ commit: version.commit, entrypoint: version.entrypoint });
      state.body = true;
      return ENDPOINT;
    },
    resolveEndpoint: async () => state.resolved,
    rotationDue: async () => state.rotate === true,
    destroy: async () => {},
    ...(opts.liveEdits === false
      ? {}
      : {
          liveEdit: async (_d, version, edit) => {
            if (!state.body) return false;
            state.edits.push({
              entrypoint: version.entrypoint,
              files: edit.files.map((f) => f.path),
              contents: edit.files.map((f) => Buffer.from(f.data).toString()),
              deletedPaths: edit.deletedPaths,
              restart: edit.restart,
            });
            return true;
          },
        }),
  };
  const audits: AuditEvent[] = [];
  const deployStore = createDeployStore(testDeployBackings());
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider,
    auditLog: { record: (_t, e: AuditEvent) => void audits.push(e), events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: mkdtempSync(join(tmpdir(), "live-edits-")),
  });
  const save = (name: string, files: Array<{ path: string; data: string }>, by = OWNER) =>
    deploy.deployOrUpdate({ ownerScopeId: scopeId("personal", by), createdBy: by, name, files });
  const dueNow = async (id: string) => {
    const draft = (await deployStore.draftOf(id))!;
    await deployStore.putDraft({ ...draft, publishAt: Date.now() - 1 });
  };
  return { deploy, deployStore, state, save, dueNow, audits };
}

async function publishApp(h: ReturnType<typeof harness>, name: string, withDev = true) {
  return h.deploy.deploy({
    ownerScopeId: scopeId("personal", OWNER),
    createdBy: OWNER,
    name,
    entrypoint: PRODUCTION,
    files: [
      ...(withDev ? [{ path: "package.json", data: PACKAGE_WITH_DEV }] : [{ path: "package.json", data: "{}" }]),
      { path: "src/App.jsx", data: "v1" },
      { path: "old.css", data: "body{}" },
    ],
  });
}

const tree = (withDev: boolean, app: string, extra: Array<{ path: string; data: string }> = []) => [
  ...(withDev ? [{ path: "package.json", data: PACKAGE_WITH_DEV }] : [{ path: "package.json", data: "{}" }]),
  { path: "src/App.jsx", data: app },
  ...extra,
];

test("republishing a running app writes only the changed files into it and keeps them as saved edits", async () => {
  const h = harness();
  const d = await publishApp(h, "live-a");

  const first = await h.save("live-a", tree(true, "v2", [{ path: "old.css", data: "body{}" }]));
  assert.deepEqual(first.liveEdit, { changed: 1, hot: true, first: true, publishAt: first.liveEdit!.publishAt });
  assert.deepEqual(h.state.edits[0], {
    entrypoint: DEV,
    files: ["src/App.jsx"],
    contents: ["v2"],
    deletedPaths: [],
    restart: true,
  });
  const saved = (await h.deployStore.draftOf(d.id))!;
  assert.equal(saved.hot, true);
  assert.ok(Math.abs(saved.publishAt! - (Date.now() + 120_000)) < 5_000, "a version is due two minutes later");

  await h.save("live-a", tree(true, "v3"));
  assert.deepEqual(h.state.edits[1], {
    entrypoint: DEV,
    files: ["src/App.jsx"],
    contents: ["v3"],
    deletedPaths: ["old.css"],
    restart: false,
  });
  const after = (await h.deployStore.get(d.id))!;
  assert.equal(after.versions.length, 1, "saving edits publishes no version");
  assert.equal(h.state.reconciles.length, 1, "only the first publish placed the app");
  const draft = (await h.deployStore.draftOf(d.id))!;
  assert.equal(draft.reloads, 1, "a hot-reloaded edit asks open tabs for no reload");
  assert.deepEqual(
    (await h.deployStore.commitTreeOf(d.id, draft.commit)).map((f) => f.path),
    ["package.json", "src/App.jsx"],
  );
  assert.equal(
    await h.deployStore.refOf(d.id, deployCurrentGitRef),
    draft.commit,
    "a clone of the app starts from the saved edits",
  );
});

test("a git push to a running app is saved live like a republish", async () => {
  const h = harness();
  const d = await publishApp(h, "live-push");
  const work = mkdtempSync(join(tmpdir(), "live-push-"));
  execFileSync("git", ["clone", "--quiet", await h.deployStore.repoUrl(d.id), work]);
  writeFileSync(join(work, "src/App.jsx"), "pushed");
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-aqm", "edit"], { cwd: work });
  const pushed = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim();

  await h.deploy.pushGit(
    d.id,
    async () => {
      execFileSync("git", ["push", "--quiet", await h.deployStore.repoUrl(d.id), "HEAD:current"], { cwd: work });
      return { result: "pushed", ok: true };
    },
    OWNER,
  );
  assert.deepEqual(h.state.edits[0], {
    entrypoint: DEV,
    files: ["src/App.jsx"],
    contents: ["pushed"],
    deletedPaths: [],
    restart: true,
  });
  assert.equal((await h.deployStore.draftOf(d.id))!.commit, pushed);
  assert.equal((await h.deployStore.get(d.id))!.versions.length, 1, "the push publishes no version yet");

  await h.dueNow(d.id);
  assert.equal(await h.deploy.publishDueLiveEdits(), 1);
  assert.equal((await h.deployStore.get(d.id))!.versions.at(-1)!.commit, pushed);
});

test("a replaced microVM comes back running the saved edits, not the last published version", async () => {
  const h = harness();
  const d = await publishApp(h, "live-b");
  await h.save("live-b", tree(true, "v2"));
  const draft = (await h.deployStore.draftOf(d.id))!;

  h.state.body = false;
  h.state.resolved = null;
  const reach = await h.deploy.reachDeployment(d.id, OWNER);
  assert.equal(reach.status, "ok");
  assert.deepEqual(h.state.reconciles.at(-1), { commit: draft.commit, entrypoint: DEV });
  assert.equal(
    await h.deployStore.refOf(d.id, deployCurrentGitRef),
    draft.commit,
    "a clone after the microVM comes back starts from the saved edits",
  );

  h.state.body = false;
  await h.save("live-b", tree(true, "v3"));
  const next = (await h.deployStore.draftOf(d.id))!;
  assert.deepEqual(
    h.state.reconciles.at(-1),
    { commit: next.commit, entrypoint: DEV },
    "an edit with no running microVM places the saved edits",
  );

  h.state.rotate = true;
  const placed = h.state.reconciles.length;
  await h.deploy.maintainDeployments();
  assert.equal(h.state.reconciles.length, placed + 1);
  assert.deepEqual(
    h.state.reconciles.at(-1),
    { commit: next.commit, entrypoint: DEV },
    "a rotated microVM places the saved edits",
  );
});

test("once edits stop, the saved edits publish as a new version on the production entrypoint", async () => {
  const h = harness();
  const d = await publishApp(h, "live-c");
  await h.save("live-c", tree(true, "v2"));
  assert.equal(await h.deploy.publishDueLiveEdits(), 0, "nothing publishes before the quiet period ends");

  const draft = (await h.deployStore.draftOf(d.id))!;
  await h.dueNow(d.id);
  assert.equal(await h.deploy.publishDueLiveEdits(), 1);
  assert.deepEqual(h.state.reconciles.at(-1), { commit: draft.commit, entrypoint: PRODUCTION });
  const after = (await h.deployStore.get(d.id))!;
  assert.equal(after.currentVersion, 2);
  assert.equal(after.appliedVersion, 2);
  assert.equal(after.versions[1]!.entrypoint, PRODUCTION);
  assert.equal(await h.deployStore.draftOf(d.id), null);
  const app = (await h.deployStore.filesOf(d.id, draft.commit)).find((f) => f.path === "src/App.jsx")!;
  assert.equal(Buffer.from(app.data).toString(), "v2");
});

test("a publish whose production build fails keeps the edits running and records why", async () => {
  const h = harness();
  const d = await publishApp(h, "live-d");
  await h.save("live-d", tree(true, "v2"));
  const draft = (await h.deployStore.draftOf(d.id))!;
  h.state.failEntrypoint = PRODUCTION;
  await h.dueNow(d.id);

  assert.equal(await h.deploy.publishDueLiveEdits(), 0);
  const failed = (await h.deployStore.draftOf(d.id))!;
  assert.match(failed.failure ?? "", /cannot find module 'left-pad'/);
  assert.equal(failed.publishAt, undefined, "a failed publish is not retried until the next edit");
  assert.match(h.audits.find((e) => e.status === "failed")?.detail ?? "", /cannot find module 'left-pad'/);
  assert.deepEqual(h.state.reconciles.at(-1), { commit: draft.commit, entrypoint: DEV });
  assert.equal((await h.deployStore.get(d.id))!.versions.length, 1);
  assert.equal(await h.deploy.publishDueLiveEdits(), 0);

  const next = await h.save("live-d", tree(true, "v3"));
  assert.match(next.liveEdit?.previousFailure ?? "", /left-pad/);
  assert.equal((await h.deployStore.draftOf(d.id))!.failure, undefined);
});

test("an app without a dev script restarts on each edit and publishes without another restart", async () => {
  const h = harness();
  const d = await publishApp(h, "live-e", false);
  await h.save("live-e", tree(false, "v2"));
  await h.save("live-e", tree(false, "v3"));
  assert.deepEqual(
    h.state.edits.map((e) => [e.entrypoint, e.restart]),
    [
      [PRODUCTION, true],
      [PRODUCTION, true],
    ],
  );
  assert.equal((await h.deployStore.draftOf(d.id))!.reloads, 2, "each restart asks open tabs to reload");

  await h.dueNow(d.id);
  assert.equal(await h.deploy.publishDueLiveEdits(), 1);
  assert.equal(h.state.reconciles.length, 1, "the restarted app already runs the production entrypoint");
  assert.equal((await h.deployStore.get(d.id))!.appliedVersion, 2);
});

test("a new entrypoint publishes a version at once and discards saved edits", async () => {
  const h = harness();
  const d = await publishApp(h, "live-f");
  await h.save("live-f", tree(true, "v2"));
  await h.deploy.deployOrUpdate({
    ownerScopeId: scopeId("personal", OWNER),
    createdBy: OWNER,
    name: "live-f",
    entrypoint: "node server.js",
    files: tree(true, "v3"),
  });
  assert.equal((await h.deployStore.get(d.id))!.versions.length, 2);
  assert.equal(await h.deployStore.draftOf(d.id), null);
});

test("a provider without live edits publishes a version for every change", async () => {
  const h = harness({ liveEdits: false });
  const d = await publishApp(h, "live-g");
  const r = await h.save("live-g", tree(true, "v2"));
  assert.equal(r.liveEdit, undefined);
  assert.equal((await h.deployStore.get(d.id))!.versions.length, 2);
  assert.equal(await h.deployStore.draftOf(d.id), null);
});

test("someone who cannot publish the app cannot save edits to it", async () => {
  const h = harness();
  const d = await publishApp(h, "live-h");
  await assert.rejects(() => h.save("live-h", tree(true, "pwned"), "U2"), /deployment name taken/);
  assert.equal(h.state.edits.length, 0);
  assert.equal(await h.deployStore.draftOf(d.id), null);
});
