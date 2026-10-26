import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./fixture.ts";

test("cron fire rows surface the result digest", () => {
  const f = litFixture();
  f.ui.history.history(
    f.root,
    {
      sessions: [{ id: "fire1", category: "background", result: "Digest result", lastMessage: "Tool chatter" }],
    },
    {
      historyKind: "cron",
      cron: "job1",
      scope: "org:acme",
      orgScope: "org:acme",
      environments: [],
      historyKindMatches: () => true,
      historyModeLabel: () => "Crons",
      kindLabels: { conversation: "Conversations", cron: "Crons" },
      pageShell() {},
      cronName: () => "Job",
      scopeKind: () => "org",
      plural: String,
      stateToUrl: () => "/session/fire1",
      go() {},
      scopeRows: () => [],
      shortName: String,
    },
  );
  assert.equal(f.root.querySelector(".dense-name")!.textContent, "Digest result");
  assert.equal(f.root.querySelector(".dense-preview")!.textContent, "Tool chatter");
  f.dom.window.close();
});

test("the org-wide landing lists sessions with a scope tag, a scope filter, and only precomputed tab counts", () => {
  const f = litFixture();
  const went: Record<string, unknown>[] = [];
  let shell: any = null;
  const render = (d: Record<string, unknown>) => {
    f.root.textContent = "";
    f.ui.history.history(
      f.root,
      { sessions: [{ id: "s1", category: "conversation", scopeId: "channel:C1", firstMessage: "hello" }], ...d },
      {
        historyKind: "conversation",
        cron: null,
        cursor: null,
        scope: "org:acme",
        orgScope: "org:acme",
        title: "Sessions",
        environments: [],
        historyKindMatches: () => true,
        historyModeLabel: () => "Conversations",
        kindLabels: { conversation: "Conversations", cron: "Cron runs", background: "Background" },
        pageShell: (opts: any) => (shell = opts),
        cronName: () => "Job",
        scopeKind: (id: string) => id.split(":")[0],
        shortName: (id: string) => (id === "channel:C1" ? "#eng" : id),
        plural: (n: number, w: string) => `${n} ${w}s`,
        stateToUrl: () => "/x",
        relTime: () => "now",
        go: (st: Record<string, unknown>) => went.push(st),
        scopeRows: () => [{ scopeId: "channel:C1" }, { scopeId: "personal:U1" }],
      },
    );
  };
  render({});
  assert.equal(shell.title, "Sessions");
  assert.deepEqual(
    JSON.parse(JSON.stringify(shell.tabs.map((t: any) => [t.label, t.count ?? null]))),
    [
      ["Conversations", null],
      ["Cron runs", null],
      ["Background", null],
    ],
    "no counts until the background snapshot exists",
  );
  assert.equal(f.root.querySelector(".dense-tag")!.textContent, "#eng", "org-wide rows name their scope");
  assert.equal(f.root.querySelector(".pager"), null, "a single page shows no pager and no total");
  const select = shell.actions[0].querySelector("select") as HTMLSelectElement;
  assert.deepEqual(
    [...select.options].map((o) => [o.value, o.textContent!.trim()]),
    [
      ["org:acme", "All scopes"],
      ["channel:C1", "#eng"],
      ["personal:U1", "personal:U1"],
    ],
  );
  select.value = "channel:C1";
  select.dispatchEvent(new f.dom.window.Event("change"));
  assert.equal(went.at(-1)!.scope, "channel:C1", "choosing a scope narrows the same list");
  render({ counts: { conversation: 12, cron: 3400, background: 7 } });
  assert.deepEqual(JSON.parse(JSON.stringify(shell.tabs.map((t: any) => t.count))), [12, 3400, 7]);
  f.dom.window.close();
});

test("history pages older rows by keyset cursor, never by offset", () => {
  const f = litFixture();
  const went: Record<string, unknown>[] = [];
  const render = (cursor: string | null, nextCursor?: string) => {
    f.root.textContent = "";
    f.ui.history.history(
      f.root,
      {
        sessions: [{ id: "s1", category: "conversation", firstMessage: "hello" }],
        ...(nextCursor ? { nextCursor } : {}),
      },
      {
        historyKind: "conversation",
        cron: null,
        cursor,
        scope: "org:acme",
        orgScope: "org:acme",
        environments: [],
        historyKindMatches: () => true,
        historyModeLabel: () => "Conversations",
        kindLabels: { conversation: "Conversations", cron: "Crons" },
        pageShell() {},
        cronName: () => "Job",
        scopeKind: () => "org",
        plural: (n: number, w: string) => `${n} ${w}s`,
        stateToUrl: () => "/x",
        go: (st: Record<string, unknown>) => went.push(st),
        scopeRows: () => [],
        shortName: String,
      },
    );
    return [...f.root.querySelectorAll<HTMLButtonElement>(".pager .page")];
  };
  const [newest, older] = render(null, "50~s50");
  assert.equal(newest!.disabled, true, "the first page has nothing newer");
  older!.click();
  assert.equal(went.at(-1)!.cursor, "50~s50", "Older follows the server's nextCursor");
  const [newestLater, olderLast] = render("50~s50");
  assert.equal(olderLast!.disabled, true, "the last page has no nextCursor");
  newestLater!.click();
  assert.equal(went.at(-1)!.cursor, null, "Newest drops the cursor");
  assert.equal(render(null).length, 0, "a single page renders no pager");
  f.dom.window.close();
});
