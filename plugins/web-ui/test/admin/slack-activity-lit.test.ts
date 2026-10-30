import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
const bundle = buildSync({
  entryPoints: [new URL("../../src/admin/slack-activity.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "slackUI",
}).outputFiles[0].text;
function setup() {
  const dom = new JSDOM('<div id="shellbar"></div><div id="view-data"></div>', {
    runScripts: "outside-only",
    url: "http://localhost/settings/judgments",
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.scrollTo = () => {};
  dom.window.requestAnimationFrame = () => 0;
  dom.window.eval(
    bundle +
      `;window.ui=slackUI;window.currentView='judgments';window.state={};window.calls=[];window.responses=[];window.shells=[];ui.configure({api:async(method,path)=>{calls.push(path);return responses.shift();},go:st=>{state=st;currentView=st.view},stateToUrl:st=>'/admin/'+st.view,pageShell:s=>{shells.push(s);document.getElementById('shellbar').innerHTML='<button class="back">Back</button><span class="shell-title">Title</span><span class="shell-context">Context</span><span class="shell-spacer"></span>';},navLink:()=>document.createElement('a'),relTime:x=>x,fmtTime:x=>x,slackContainerLabel:x=>x,slackContainerScope:()=>null,loadSlackContainers:async()=>({ok:true,data:{}}),containers:()=>[],view:()=>currentView});`,
  );
  return dom;
}
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
