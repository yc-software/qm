import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../src/loops.ts", import.meta.url), "utf8");
const item = (id: string, priority = "normal") => ({
  id,
  sourceKey: id,
  status: "queued",
  triage: { priority },
});
const items = [item("first", "high"), item("second"), item("third", "low")];
const loop = { id: "loop-1", triage: { prioritize: { enabled: false, instructions: "original" } } };
const snapshot = (status: string, results: unknown[] = []) => ({
  id: "preview-1",
  status,
  items: results,
  total: 3,
  completed: results.length,
  startedAt: 1,
});

function harness(api: (path: string, init: RequestInit) => Promise<unknown>) {
  let poll: (() => Promise<void>) | undefined;
  let delay: number | undefined;
  const code = [
    source.slice(source.indexOf("interface LoopView"), source.indexOf("interface IngestionSource")),
    source.slice(source.indexOf("let triageDrafts"), source.indexOf("const expandedGroups")),
    source.slice(source.indexOf("function saveTriage"), source.indexOf("function triageTpl")),
    `({ runTriagePreview, resetTriagePreview, closeTriageEditor, editorRows, triageStatus,
        state: () => triagePreview, setDraft: (text) => triageDrafts.set("prioritize", text) })`,
  ].join("\n");
  const controls = runInNewContext(stripTypeScriptTypes(code), {
    api,
    AbortController,
    Date,
    activeDetail: { items },
    paint: () => {},
    errMessage: (error: Error) => error.message,
    html: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (out, part, i) => out + part + (Array.isArray(values[i]) ? values[i].join("") : (values[i] ?? "")),
        "",
      ),
    nothing: "",
    tip: () => "",
    setTimeout: (callback: () => Promise<void>, ms: number) => {
      poll = callback;
      delay = ms;
      return 1;
    },
    clearTimeout: () => {
      poll = undefined;
    },
  });
  return {
    ...controls,
    tick: async () => {
      const callback = poll;
      poll = undefined;
      await callback?.();
      await new Promise(setImmediate);
    },
    hasPoll: () => !!poll,
    delay: () => delay,
  };
}

function assertRows(html: string) {
  assert.ok(html.indexOf(">first</span>") < html.indexOf(">second</span>"));
  assert.ok(html.indexOf(">second</span>") < html.indexOf(">third</span>"));
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
}

test("preview polls and renders partial scores without removing or moving unscored rows", async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const responses = [
    snapshot("running"),
    snapshot("running", [{ id: "third", priority: "urgent" }]),
    snapshot("complete", [{ id: "third", priority: "urgent" }]),
  ];
  const ui = harness(async (path, init) => {
    requests.push({ path, init });
    return { preview: responses.shift() };
  });
  await ui.runTriagePreview(loop, "prioritize");
  assert.equal(ui.delay(), 1000);
  assert.equal(requests[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0]!.init.body as string), {
    triage: {
      prioritize: { enabled: true, instructions: "original" },
      consolidate: { enabled: false, instructions: "" },
    },
  });
  assertRows(ui.editorRows("prioritize", items));
  await ui.tick();
  assert.equal(requests[1]!.path, "/api/loops/loop-1/triage/preview/preview-1");
  assertRows(ui.editorRows("prioritize", []));
  assert.match(ui.editorRows("prioritize", items), /Urgent/);
  assert.match(ui.triageStatus("prioritize", items, ui.state()), /1 of 3/);
  await ui.tick();
  assert.equal(ui.hasPoll(), false);
  const final = ui.editorRows("prioritize", items);
  assert.ok(final.indexOf(">third</span>") < final.indexOf(">first</span>"));
  assert.equal((final.match(/<li>/g) ?? []).length, 3);
});

test("closing or editing invalidates pending starts and polls including late errors", async () => {
  for (const operation of ["closeTriageEditor", "resetTriagePreview"]) {
    for (const pendingPoll of [false, true]) {
      let finish!: (value: unknown) => void;
      let fail!: (error: Error) => void;
      let signal!: AbortSignal;
      let calls = 0;
      const ui = harness(async (_path, init) => {
        signal = init.signal!;
        if (pendingPoll && calls++ === 0) return { preview: snapshot("running") };
        return new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      });
      const start = ui.runTriagePreview(loop, "prioritize");
      const pending = pendingPoll ? (await start, ui.tick()) : start;
      ui[operation]();
      assert.equal(signal.aborted, true);
      if (pendingPoll) fail(new Error("late network error"));
      else finish({ preview: snapshot("running") });
      await pending;
      assert.equal(ui.state(), null);
      assert.equal(ui.hasPoll(), false);
    }
  }
});

test("a replacement preview ignores an older response and repeated clicks do not start another run", async () => {
  let finish!: (value: unknown) => void;
  let requests = 0;
  const ui = harness(async () => {
    if (++requests === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { preview: { ...snapshot("running"), id: "replacement" } };
  });
  const old = ui.runTriagePreview(loop, "prioritize");
  await ui.runTriagePreview(loop, "prioritize");
  assert.equal(requests, 1);
  ui.resetTriagePreview();
  await ui.runTriagePreview(loop, "prioritize");
  finish({ preview: snapshot("complete", [{ id: "first", priority: "urgent" }]) });
  await old;
  assert.equal(ui.state().id, "replacement");
  assert.equal(ui.state().status, "running");
  assert.equal(ui.hasPoll(), true);
  ui.resetTriagePreview();
});

test("failed runs and failed polling retain partial results and show the error", async () => {
  for (const networkError of [false, true]) {
    let calls = 0;
    const partial = [{ id: "second", priority: "urgent", groupId: "g1" }];
    const ui = harness(async () => {
      if (calls++ === 0) return { preview: snapshot("running", partial) };
      if (networkError) throw new Error("connection lost");
      return { preview: { ...snapshot("failed", partial), error: "model failed" } };
    });
    await ui.runTriagePreview(loop, "prioritize");
    await ui.tick();
    assertRows(ui.editorRows("prioritize", items));
    assert.match(ui.editorRows("prioritize", items), /Urgent/);
    assert.match(ui.triageStatus("prioritize", items, ui.state()), /Dry run failed · 1 of 3/);
    assert.match(ui.triageStatus("prioritize", items, ui.state()), networkError ? /connection lost/ : /model failed/);
    assert.equal(ui.hasPoll(), false);
  }
});

test("partial consolidation shows group labels in stable rows until completion", async () => {
  const ui = harness(async () => ({
    preview: snapshot("running", [
      { id: "third", groupId: "g" },
      { id: "first", groupId: "g" },
    ]),
  }));
  await ui.runTriagePreview(loop, "consolidate");
  const rendered = ui.editorRows("consolidate", items);
  assertRows(rendered);
  assert.equal((rendered.match(/Group 1/g) ?? []).length, 2);
  ui.resetTriagePreview();
  assert.equal(ui.hasPoll(), false);
});

test("instruction edits cancel previews and saves preserve the existing enabled setting", () => {
  assert.match(
    source,
    /triageDrafts\.set\(kind, \(e\.target as HTMLTextAreaElement\)\.value\);\s*resetTriagePreview\(\)/,
  );
  assert.match(source, /saveTriage\(loop, kind, loop\.triage\?\.\[kind\]\?\.enabled === true\)/);
  assert.match(source, /export function resetActiveLoop\(\)[\s\S]*?resetTriagePreview\(\)/);
});

test("disabled triage settings still expose instruction editing and dry runs", () => {
  const settings = source.slice(source.indexOf("function triageTpl"), source.indexOf("function ledgerRows"));
  assert.match(settings, /class="loop-triage-prompt"/);
  assert.doesNotMatch(settings, /enabled\s*\?\s*html`/);
});
