import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
const bundle = buildSync({
  entryPoints: [new URL("../ui/slack-activity.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "slackUI",
}).outputFiles[0].text;
function setup() {
  const dom = new JSDOM('<div id="shellbar"></div><div id="view-data"></div>', {
    runScripts: "outside-only",
    url: "http://localhost/admin/slack",
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.scrollTo = () => {};
  dom.window.requestAnimationFrame = () => 0;
  dom.window.eval(
    bundle +
      `;window.ui=slackUI;window.currentView='slack';window.state={container:'C1'};window.calls=[];window.responses=[];window.shells=[];ui.configure({api:async(method,path)=>{calls.push(path);return responses.shift();},go:st=>{state=st;currentView=st.view},urlToState:()=>state,stateToUrl:st=>'/admin/'+st.view,pageShell:s=>{shells.push(s);document.getElementById('shellbar').innerHTML='<button class="back">Back</button><span class="shell-title">Title</span><span class="shell-context">Context</span><span class="shell-spacer"></span>';},navLink:()=>document.createElement('a'),relTime:x=>x,fmtTime:x=>x,brandSelfLabel:()=>"QM",slackParseText:text=>document.createTextNode(text),slackContainerLabel:x=>x,slackContainerScope:()=>null,loadSlackContainers:async()=>({ok:true,data:{}}),containers:()=>[],truncated:()=>false,view:()=>currentView,loaded:()=>{}});`,
  );
  return dom;
}
const first = { ts: "2", authorId: "u", text: "second", createdAt: "2026-01-01T00:02:00Z" };
const older = { ts: "1", authorId: "u", text: "first", createdAt: "2026-01-01T00:01:00Z" };
test("Slack paging preserves keyed message nodes and recomputes the grouping seam", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      `responses.push({ok:true,data:{messages:[${JSON.stringify(first)}],hasMore:true}},{ok:true,data:{messages:[${JSON.stringify(older)}],hasMore:false}})`,
    );
    await dom.window.eval("ui.renderSlackMirror(state)");
    const original = dom.window.document.querySelector('[data-ts="2"]')!;
    await dom.window.eval("ui.activity.earlierMessages()");
    assert.equal(dom.window.document.querySelector('[data-ts="2"]'), original);
    assert.equal(original.classList.contains("sm-cont"), true);
    assert.equal(dom.window.document.querySelectorAll(".sm-day").length, 1);
    assert.equal(dom.window.document.querySelector(".load-earlier"), null);
    assert.equal(dom.window.document.querySelectorAll(".sm-msg").length, 2);
  } finally {
    dom.window.close();
  }
});
test("Slack search ignores responses from superseded queries", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      'window.pending=[];ui.configure({...{} ,api:()=>new Promise(resolve=>pending.push(resolve)),view:()=>"slack",urlToState:()=>state,slackParseText:text=>document.createTextNode(text),slackContainerLabel:x=>x,brandSelfLabel:()=>"QM",fmtTime:x=>x,relTime:x=>x});window.first=ui.activity.search("old",null);window.second=ui.activity.search("new",null);pending[1]({ok:true,data:{messages:[]}})',
    );
    await dom.window.eval("second");
    dom.window.eval('pending[0]({ok:false,status:500,data:{message:"obsolete"}})');
    await dom.window.eval("first");
    assert.equal(dom.window.document.getElementById("view-data")!.textContent, "No matches in the mirror.");
  } finally {
    dom.window.close();
  }
});
test("Judgment pagination updates from state and escapes untrusted reasons", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      `currentView='judgments';state={};responses.push({ok:true,data:{judgments:[{id:1,container:'C1',decision:'ignore',reason:'<img src=x>',createdAt:'now'}],counts:{ignore:1},hasMore:true}},{ok:true,data:{judgments:[{id:2,container:'C1',decision:'act',createdAt:'before'}],hasMore:false}})`,
    );
    await dom.window.eval("ui.renderAmbientJudgments(state)");
    assert.equal(dom.window.document.querySelectorAll("img").length, 0);
    assert.match(dom.window.document.querySelector(".dense-preview")!.textContent!, /<img src=x>/);
    await dom.window.eval('ui.activity.earlierLog("judgments","/api/ambient-judgments?decision=act%2Cignore")');
    assert.equal(dom.window.document.querySelectorAll(".dense-row").length, 2);
    assert.equal(dom.window.document.querySelector(".load-earlier"), null);
  } finally {
    dom.window.close();
  }
});
test("Ack detail renders its message, candidate slate and Slack link from fetched data", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      `currentView='ackemoji';state={jid:'7'};responses.push({ok:true,data:{workspaceUrl:'https://acme.slack.com/',pick:{id:7,channel:'C1',ts:'12.34',outcome:'picked',picked:'eyes',message:'hello',candidates:'eyes wave',createdAt:'today'}}})`,
    );
    await dom.window.eval("ui.renderAckEmojiPicks(state)");
    assert.equal(dom.window.document.querySelector("pre")!.textContent, "hello");
    assert.equal(dom.window.document.querySelector(".pill.accent")!.textContent, ":eyes:");
    assert.equal(
      dom.window.document.querySelector<HTMLAnchorElement>(".judg-extlink")!.href,
      "https://acme.slack.com/archives/C1/p1234",
    );
  } finally {
    dom.window.close();
  }
});
