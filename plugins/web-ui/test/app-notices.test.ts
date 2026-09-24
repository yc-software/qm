import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import type { AppNotice } from "../src/app-notices.ts";

const source = readFileSync(new URL("../src/app-notices.ts", import.meta.url), "utf8");
function harness() {
  const calls: Array<{ resolve: (value: { notices: AppNotice[] }) => void; reject: (error: Error) => void }> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const context = createContext({
    api(path: string) {
      assert.equal(path, "/api/deployment-notices");
      return new Promise((resolve, reject) => calls.push({ resolve, reject }));
    },
    errMessage: (error: Error) => error.message,
    setTimeout(callback: () => void, delay: number) {
      assert.equal(delay, 15_000);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  });
  runInContext(stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/\bexport /g, "")), context);
  return {
    calls,
    timers,
    state: runInContext("appNoticeState", context) as { notices: AppNotice[]; error: string; toast: AppNotice | null },
    refresh: runInContext("refreshAppNotices", context) as (fresh?: boolean) => Promise<void>,
    start: runInContext("startAppNotices", context) as (changed: () => void) => void,
    stop: runInContext("stopAppNotices", context) as () => void,
    hide: runInContext("hideAppNoticeToast", context) as () => void,
  };
}
const request: AppNotice = { id: "request", text: "Alice requested access", createdAt: 1, request: true };
const grant: AppNotice = {
  id: "grant",
  text: "Access granted",
  createdAt: 2,
  request: false,
  url: "/deployments/app/",
};
const declined: AppNotice = { id: "decline", text: "Access declined", createdAt: 3, request: false };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("request, grant and decline arrivals update the toast and outstanding count without repeated alerts", async () => {
  const h = harness();
  for (const notice of [request, grant, declined]) {
    const refresh = h.refresh();
    h.calls.at(-1)!.resolve({ notices: [...h.state.notices, notice] });
    await refresh;
    assert.equal(h.state.toast?.id, notice.id);
    assert.equal(h.state.notices.length, notice.createdAt);
    h.hide();
    assert.equal(h.state.toast, null);
    const repeated = h.refresh();
    h.calls.at(-1)!.resolve({ notices: [...h.state.notices] });
    await repeated;
    assert.equal(h.state.toast, null);
    assert.equal(h.state.notices.length, notice.createdAt);
  }
});

test("handling notices reconciles count and removes a resolved toast, while fetch failures preserve both", async () => {
  const h = harness();
  const initial = h.refresh();
  h.calls[0]!.resolve({ notices: [request, grant] });
  await initial;
  const failed = h.refresh();
  h.calls[1]!.reject(new Error("offline"));
  await failed;
  assert.equal(h.state.notices.length, 2);
  assert.equal(h.state.toast?.id, "grant");
  assert.equal(h.state.error, "offline");
  const handled = h.refresh();
  h.calls[2]!.resolve({ notices: [] });
  await handled;
  assert.equal(h.state.notices.length, 0);
  assert.equal(h.state.toast, null);
  assert.equal(h.state.error, "");
});

test("polling is shell-wide, single-flight and stopped/reset across authentication changes", async () => {
  const h = harness();
  let changes = 0;
  h.start(() => changes++);
  const pending = h.refresh();
  assert.equal(h.calls.length, 1);
  h.calls[0]!.resolve({ notices: [request] });
  await pending;
  await flush();
  assert.equal(h.timers.size, 1);
  assert.equal(changes, 1);
  const [id, poll] = [...h.timers][0]!;
  h.timers.delete(id);
  poll();
  h.start(() => changes++);
  h.calls[1]!.resolve({ notices: [grant] });
  await flush();
  assert.equal(h.state.notices.length, 0);
  h.calls[2]!.resolve({ notices: [declined] });
  await flush();
  assert.equal(h.state.toast?.id, "decline");
  assert.equal(h.timers.size, 1);
  h.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.state.notices.length, 0);
  assert.equal(h.state.toast, null);
});

test("an action requests a fresh snapshot after an already-running stale poll", async () => {
  const h = harness();
  const poll = h.refresh();
  const afterAction = h.refresh(true);
  h.calls[0]!.resolve({ notices: [request] });
  await poll;
  await flush();
  assert.equal(h.calls.length, 2);
  h.calls[1]!.resolve({ notices: [] });
  await afterAction;
  assert.equal(h.state.notices.length, 0);
  assert.equal(h.state.toast, null);
});

test("shell mounts accessible notification and Apps badge, while Apps actions share the same state", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const deploys = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(shell, /id="app-notification" aria-live="polite"/);
  assert.match(shell, /class="action-toast app-notification" role="status"/);
  assert.match(shell, /notice.request \? "Review" : "Open Apps"/);
  assert.match(shell, /href=\$\{deepLinkPath\(UI_BASE, "deploys", null\)\}/);
  assert.match(shell, /navRow\("deploys", ICON.deploys, "Apps", appNoticeState.notices.length\)/);
  assert.match(shell, /count > 0 \? html`<span class="nav-badge"/);
  assert.match(shell, /shellMounted = true;\s*if \(canView\("deploys"\)\)\s*startAppNotices/);
  assert.match(shell, /function renderAuthGate[^]*?stopAppNotices\(\)/);
  assert.match(shell, /function signOut\(\)[^]*?stopAppNotices\(\)/);
  assert.match(deploys, /appNoticeState.notices.map/);
  assert.match(deploys, /await refreshAppNotices\(true\)/);
  assert.doesNotMatch(deploys, /scheduleNoticeRefresh|noticeRefreshTimer/);
});
