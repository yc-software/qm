import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { prepare } from "../ui/transcript.ts";
const bundle = buildSync({
  entryPoints: [new URL("../ui/transcript.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "transcriptUI",
}).outputFiles[0].text;
function setup() {
  const dom = new JSDOM('<div id="header-controls"></div><div id="view-data"></div>', { runScripts: "outside-only" });
  dom.window.requestAnimationFrame = () => 0;
  dom.window.scrollTo = () => {};
  dom.window.eval(
    bundle +
      `;window.ui=transcriptUI;window.data={entries:[]};window.visible={thinking:true,toolResults:true};window.textNode=text=>{const p=document.createElement('pre');p.textContent=text;return p;};window.services={api:async(method,path)=>({ok:true,data:path.includes('/llm?')?{requests:[]}:data}),scope:'org:test',pageSize:60,visibility:visible,current:()=>true,pageShell:()=>{},shortName:x=>x,relTime:x=>x,fmtTime:x=>x,adminErrors:async()=>[],setObserver:()=>{},entryHidden:types=>!visible.thinking&&types.includes('thinking'),payloadText:x=>x,payloadName:()=>'',isXmlishText:()=>false,renderMarkdown:textNode,entryIsNoise:e=>e.type==='thinking',titleCase:x=>x,brandSelfLabel:()=>"QM",stepDurEl:()=>null,copyButton:()=>document.createElement('button'),deliveryFileBadges:()=>null};`,
  );
  return dom;
}
test("transcript grouping pairs tools, folds deliveries and anchors model requests on final assistant", () => {
  const data = {
    entries: [
      { seq: 1, type: "user", createdAt: 1 },
      { seq: 2, type: "tool_call", payload: { callId: "a" }, createdAt: 2 },
      { seq: 3, type: "tool_result", payload: { callId: "a", deliveryId: "d" }, createdAt: 3 },
      { seq: 4, type: "assistant", createdAt: 4 },
    ],
    deliveryEvents: [
      { type: "outbound_delivery", deliveryId: "d", createdAt: 3 },
      { type: "principal_delivery", deliveryId: "d", createdAt: 3 },
    ],
  };
  const result = prepare(data, [
    { turnSeq: 1, step: 2 },
    { turnSeq: 1, step: 1 },
  ]);
  assert.equal(result.units.length, 3);
  assert.equal(result.units[1].paired.seq, 3);
  assert.equal(result.units[1].delivery.deliveryId, "d");
  assert.equal(result.principalIds.has("d"), true);
  assert.deepEqual(
    result.units[2].llmReqs.map((r: any) => r.step),
    [1, 2],
  );
});
test("transcript controls filter state and preserve disclosure state without rebuilding message nodes", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      `data={entries:[{seq:1,type:'user',payload:'hello',createdAt:1},{seq:2,type:'thinking',payload:'private thought',createdAt:2},{seq:3,type:'assistant',payload:'reply',createdAt:3}]}`,
    );
    await dom.window.eval('ui.show("session",60,false,services)');
    const doc = dom.window.document,
      thinking = doc.querySelector(".thinking-entry")!;
    thinking.querySelector<HTMLButtonElement>(".disclosure")!.click();
    assert.equal(thinking.classList.contains("collapsed"), false);
    doc.querySelector<HTMLInputElement>('[aria-label="Show thinking"]')!.click();
    assert.equal(thinking.classList.contains("filtered"), true);
    assert.equal(thinking.classList.contains("collapsed"), false);
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
    dom.window.eval("ui.cancel();resolve({ok:true,data:{entries:[]}})");
    await dom.window.eval("pending");
    assert.match(dom.window.document.getElementById("view-data")!.textContent!, /Loading/);
  } finally {
    dom.window.close();
  }
});
test("model context selection and disclosure render from state and escape captured content", () => {
  const dom = setup();
  try {
    dom.window.eval(
      `Object.assign(services,{contextSections:()=>[{key:'system',label:'System',text:'<script>bad</script>',tokens:20,note:''},{key:'messages',label:'Messages',text:'hello',tokens:1,note:''}],requestBody:x=>x,fmtContextSize:()=> '21 tokens',sumCacheUsage:()=>null,metaChip:()=>document.createElement('span'),cacheMetaItems:()=>[],rawJsonLink:()=>document.createElement('a'),fmtTokens:x=>String(x)});document.getElementById('view-data').append(ui.requestsPanel([{}],services,{embedded:true,page:true,selectLargest:true}))`,
    );
    const doc = dom.window.document;
    assert.equal(doc.querySelector("pre")!.textContent, "<script>bad</script>");
    assert.equal(doc.querySelectorAll("script").length, 0);
    doc.querySelector<HTMLButtonElement>(".ctx-messages")!.click();
    assert.equal(doc.querySelector("pre")!.textContent, "hello");
    assert.equal(doc.querySelector(".ctx-messages")!.getAttribute("aria-pressed"), "true");
  } finally {
    dom.window.close();
  }
});
test("deep-link back navigation uses the fetched session scope", async () => {
  const dom = setup();
  try {
    dom.window.history.replaceState({ deepLink: true }, "");
    dom.window.eval(
      'window.shell=null;window.destination=null;services.pageShell=value=>shell=value;services.go=value=>destination=value;data={session:{scopeId:"channel:actual"},entries:[]}',
    );
    await dom.window.eval('ui.show("session",60,false,services)');
    dom.window.eval("shell.back.onClick()");
    assert.equal(dom.window.eval("destination.scope"), "channel:actual");
    assert.equal(dom.window.eval("destination.session"), null);
  } finally {
    dom.window.close();
  }
});
test("standalone delivery retains destination labels and never renders text as HTML", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      'services.deliveryLabel=()=>"Web delivery";services.deliverySurfaceLabel=()=>"Web";services.wakeOriginLabel=()=>"Manual";services.slackMirrorRef=()=>null;data={entries:[],deliveryEvents:[{type:"outbound_delivery",destination:{type:"web",target:"channel"},text:"<img src=x>",createdAt:1}]}',
    );
    await dom.window.eval('ui.show("session",60,false,services)');
    const doc = dom.window.document;
    assert.equal(doc.querySelector(".entry-label")!.textContent, "Web delivery");
    assert.equal(doc.querySelector(".badge")!.textContent, "Web");
    assert.equal(doc.querySelectorAll("img").length, 0);
    assert.match(doc.querySelector("pre")!.textContent!, /<img src=x>/);
  } finally {
    dom.window.close();
  }
});
