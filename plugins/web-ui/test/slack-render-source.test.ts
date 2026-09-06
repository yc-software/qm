import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const search = readFileSync(new URL("../src/search.ts", import.meta.url), "utf8");
const slackText = readFileSync(new URL("../src/slack-text.ts", import.meta.url), "utf8");

test("inbox slack text renders through the wire decoder, not raw", () => {
  assert.match(inbox, /import \{ splitSlackWire \} from "\.\/slack-text";/);
  const tpl = inbox.slice(inbox.indexOf("export function slackTextTpl"), inbox.indexOf("function itemImagesTpl"));
  assert.match(tpl, /splitSlackWire\(text\)/, "wire tokens (<@U…>, <url|label>) tokenize before render");
  assert.match(tpl, /withMentions\(seg\.label\)/, "@handles inside a link label still chip");
  assert.match(tpl, /withMentions\(seg\.text\)/, "@handles in plain segments still chip");
  assert.match(tpl, /if \(item\.source !== "slack"\) return html`\$\{text\}`;/, "gmail text is untouched");
});

test("the snippet inside the row button renders links as labels, never nested anchors", () => {
  assert.match(inbox, /slackTextTpl\(item, item\.snippet, \{ links: false \}\)/);
});

test("reply text and context messages go through the same decoder", () => {
  assert.match(inbox, /slackTextTpl\(item, item\.externalReplyText\)/);
  assert.match(inbox, /slackTextTpl\(item, m\.text\)/);
});

test("splitSlackWire tokenizes on the raw wire, then unescapes prose and labels", () => {
  const fn = slackText.slice(
    slackText.indexOf("export function splitSlackWire"),
    slackText.indexOf("export function slackWireToPlain"),
  );
  assert.match(
    fn,
    /segments\.push\(\{ kind: "text", text: decodeSlackEntities\(raw\) \}\)/,
    "prose decodes after tokenizing",
  );
});

test("read-only slack sessions strip directives and decode user wire at render", () => {
  assert.match(chat, /import \{ slackWireToPlain, splitSlackWire, stripSlackDirectives \} from "\.\/slack-text";/);
  const gate = chat.slice(chat.indexOf("function isReadOnlySlackView"), chat.indexOf("function assistantDisplayText"));
  assert.match(
    gate,
    /!chatState\.agent && chatState\.forkSession !== null && surfaceOf\(chatState\.forkSession\) === "slack"/,
    "the read-only Slack predicate lives in one place",
  );
  assert.match(chat, /return isReadOnlySlackView\(\) \? stripSlackDirectives\(text\) : text;/, "assistant text strips");
  assert.match(
    chat,
    /isReadOnlySlackView\(\) \? slackWireBubble\(messageText\(message\)\) : markdown\(messageText\(message\)\)/,
    "user bubbles wire-decode in a read-only Slack view",
  );
});

test("copy and search surface the displayed text, not raw wire/directives", () => {
  assert.match(chat, /function copyableText\(message: AgentMessage\): string/);
  assert.match(chat, /const text = copyableText\(message\)\.trim\(\);/);
  assert.match(
    search,
    /hit\.surface === "slack" \? slackWireToPlain\(stripSlackDirectives\(hit\.snippet\)\) : hit\.snippet/,
  );
});
