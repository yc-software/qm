import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountAdmin } from "../support/admin-fixture.ts";
import { adminBundle } from "../support/admin-bundle.ts";
const bundle = adminBundle("transcript.ts", "transcriptUI");
function setup() {
  const dom = new JSDOM('<div id="header-controls"></div><div id="view-data"></div>', { runScripts: "outside-only" });
  dom.window.requestAnimationFrame = () => 0;
  dom.window.scrollTo = () => {};
  dom.window.eval(
    bundle +
      `;window.ui=transcriptUI;window.data={items:[]};window.visible={thinking:true,toolResults:true};window.services={api:async(method,path)=>({ok:true,data:path.includes('/llm?')?{requests:[]}:data}),scope:'org:test',pageSize:60,visibility:visible,current:()=>true,pageShell:()=>{},shortName:x=>x,adminErrors:async()=>[],setObserver:()=>{},entryHidden:kinds=>!visible.thinking&&kinds.includes('Reasoning'),brandSelfLabel:()=>"QM",deliveryFileBadges:()=>null};window.item=(seq,kind,extra={})=>({sessionId:'s',seq,kind,createdAt:seq,turnId:null,author:null,callId:null,text:null,tool:null,variant:null,body:{},...extra});`,
  );
  return dom;
}
const item = (seq: number, kind: string, extra: Record<string, unknown> = {}) => ({
  sessionId: "s",
  seq,
  kind,
  createdAt: seq,
  turnId: null,
  author: null,
  callId: null,
  text: null,
  tool: null,
  variant: null,
  body: {},
  ...extra,
});
test("transcript grouping pairs tool items by callId and anchors model requests on the final agent message", () => {
  const data = {
    items: [
      item(1, "UserMessage", { text: "hi" }),
      item(2, "ToolCall", { callId: "a", tool: "execute" }),
      item(3, "ToolCall", { callId: "b", tool: "read" }),
      item(4, "ToolResult", { callId: "b" }),
      item(5, "ToolResult", { callId: "a" }),
      item(6, "AgentMessage", { text: "done" }),
    ],
  };
  const dom = setup();
  const result = (dom.window as any).ui.prepare(data, [
    { turnSeq: 1, step: 2 },
    { turnSeq: 1, step: 1 },
  ]);
  assert.deepEqual(
    [...result.units].map((u: any) => u.kind),
    ["item", "tool", "tool", "item"],
  );
  assert.equal(result.units[1].result.seq, 5);
  assert.equal(result.units[2].result.seq, 4);
  assert.deepEqual(
    [...result.units[3].llmReqs].map((r: any) => r.step),
    [1, 2],
  );
});
test("items-shaped transcript renders a row per message with its text", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      `data={session:{scopeId:'org:test'},items:[item(1,'UserMessage',{text:'hello there',body:{name:'Ada'}}),item(2,'ToolCall',{callId:'c',tool:'execute',body:{command:'ls'}}),item(3,'ToolResult',{callId:'c',tool:'execute',text:'ok'}),item(4,'AgentMessage',{text:'all done'})]}`,
    );
    await dom.window.eval('ui.show("session",60,false,services)');
    const doc = dom.window.document;
    assert.equal(doc.querySelector(".empty"), null);
    assert.equal(doc.querySelector(".user-entry .entry-label")!.textContent, "Ada");
    assert.equal(doc.querySelector(".user-entry .message-body")!.textContent!.trim(), "hello there");
    assert.equal(doc.querySelector(".assistant-entry .entry-label")!.textContent, "QM");
    assert.equal(doc.querySelector(".assistant-entry .message-body")!.textContent!.trim(), "all done");
    assert.equal(doc.querySelectorAll(".tool-line-entry").length, 1);
    assert.match(doc.querySelector(".tool-line-entry .when")!.textContent!, /#2→#3/);
  } finally {
    dom.window.close();
  }
});
test("transcript controls filter state and preserve disclosure state without rebuilding message nodes", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      `data={items:[item(1,'UserMessage',{text:'hello'}),item(2,'Reasoning',{text:'private thought'}),item(3,'AgentMessage',{text:'reply'}),item(4,'ContextCompaction',{body:{summary:'s'}})]}`,
    );
    await dom.window.eval('ui.show("session",60,false,services)');
    const doc = dom.window.document,
      thinking = doc.querySelector(".thinking-entry")!;
    assert.equal(thinking.querySelector("pre")!.textContent, "private thought");
    const compaction = doc.querySelector(".entry.noise")!;
    assert.equal(compaction.querySelector(".entry-label")!.textContent, "Context compaction");
    compaction.querySelector<HTMLButtonElement>(".disclosure")!.click();
    assert.equal(compaction.classList.contains("collapsed"), false);
    doc.querySelector<HTMLInputElement>('[aria-label="Show thinking"]')!.click();
    assert.equal(thinking.classList.contains("filtered"), true);
    assert.equal(compaction.classList.contains("collapsed"), false);
    assert.equal(doc.querySelector(".thinking-entry"), thinking);
  } finally {
    dom.window.close();
  }
});
test("header controls appear while transcript requests are pending and stale replies are ignored", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      'window.resolve=null;services.api=async()=>new Promise(r=>resolve=r);window.pending=ui.show("session",60,false,services)',
    );
    assert.equal(dom.window.document.querySelectorAll(".header-check").length, 2);
    dom.window.eval("ui.cancel();resolve({ok:true,data:{items:[]}})");
    await dom.window.eval("pending");
    assert.match(dom.window.document.getElementById("view-data")!.textContent!, /Loading/);
  } finally {
    dom.window.close();
  }
});
test("model context shows per-call metadata and escapes transport text", async () => {
  const dom = setup();
  try {
    await dom.window.eval(
      `services.api=async()=>({ok:true,data:{requests:[{model:'m',transport:{modelId:'<script>bad</script>'}}]}});ui.contextPage('s','1',services)`,
    );
    const doc = dom.window.document;
    assert.match(doc.querySelector("pre")!.textContent!, /^model: <script>bad<\/script>/);
    assert.equal(doc.querySelectorAll("script").length, 0);
    assert.match(doc.querySelector(".context-note")!.textContent!, /not stored here/);
  } finally {
    dom.window.close();
  }
});
test("deep-link back navigation uses the fetched session scope", async () => {
  const dom = setup();
  try {
    dom.window.history.replaceState({ deepLink: true }, "");
    dom.window.eval(
      'window.shell=null;window.destination=null;services.pageShell=value=>shell=value;services.go=value=>destination=value;data={session:{scopeId:"channel:actual"},items:[]}',
    );
    await dom.window.eval('ui.show("session",60,false,services)');
    dom.window.eval("shell.back.onClick()");
    assert.equal(dom.window.eval("destination.scope"), "channel:actual");
    assert.equal(dom.window.eval("destination.session"), null);
  } finally {
    dom.window.close();
  }
});

async function transcript(data: Record<string, unknown>) {
  const admin = await mountAdmin("/settings/history/s/sess-1", {
    "/scopes": { scopes: [], environments: [] },
    "/sessions/sess-1/llm": { requests: [] },
    "/sessions/sess-1": data,
  });
  await admin.settle(10);
  return admin;
}

const coreItem = (seq: number, kind: string, extra: Record<string, unknown> = {}) =>
  item(seq, kind, { sessionId: "sess-1", isError: null, ...extra });

test("admin transcript renders core items with the real controller helpers", async () => {
  const admin = await transcript({
    session: { scopeId: "org:acme" },
    items: [
      coreItem(1, "UserMessage", { text: "hello", author: "u1", body: { name: "Ada" } }),
      coreItem(2, "ToolCall", { callId: "c", tool: "execute", body: { command: "ls -la" } }),
      coreItem(3, "ToolResult", { callId: "c", tool: "execute", text: "total 0", body: { code: 0 } }),
      coreItem(4, "AgentMessage", { text: "all done" }),
    ],
  });
  const doc = admin.document;
  assert.equal(doc.querySelector("#view-data .empty"), null);
  assert.equal(doc.querySelector(".user-entry .entry-label")!.textContent!.trim(), "Ada");
  assert.match(doc.querySelector(".user-entry")!.textContent!, /hello/);
  assert.match(doc.querySelector(".assistant-entry")!.textContent!, /all done/);
  const tool = doc.querySelector(".tool-line-entry")!;
  assert.equal(tool.querySelector(".tool-label")!.textContent, "execute");
  assert.equal(tool.querySelector(".tool-line-preview")!.textContent, "ls -la");
  assert.match(tool.querySelector(".meta-row")!.textContent!, /exit 0/);
  admin.close();
});

test("transcript filters hide thinking and tool items but keep messages", async () => {
  const admin = await transcript({
    session: { scopeId: "org:acme" },
    items: [
      coreItem(1, "UserMessage", { text: "hello" }),
      coreItem(2, "Reasoning", { text: "private thought" }),
      coreItem(3, "ToolCall", { callId: "plain", tool: "read" }),
      coreItem(4, "ToolResult", { callId: "plain", tool: "read" }),
      coreItem(5, "AgentMessage", { text: "reply" }),
    ],
  });
  const doc = admin.document;
  const hidden = (selector: string) =>
    [...doc.querySelectorAll(`#view-data ${selector}`)].map((entry) => entry.classList.contains("filtered"));
  assert.deepEqual(hidden(".thinking-entry"), [false]);
  doc.querySelector<HTMLInputElement>('[aria-label="Show thinking"]')!.click();
  assert.deepEqual(hidden(".thinking-entry"), [true]);
  assert.deepEqual(hidden(".tool-entry"), [false, false]);
  doc.querySelector<HTMLInputElement>('[aria-label="Show tool results"]')!.click();
  assert.deepEqual(hidden(".tool-entry"), [true, true]);
  assert.deepEqual(hidden(".user-entry, .assistant-entry"), [false, false]);
  doc.querySelector<HTMLInputElement>('[aria-label="Show thinking"]')!.click();
  assert.deepEqual(hidden(".thinking-entry"), [false]);
  admin.close();
});
