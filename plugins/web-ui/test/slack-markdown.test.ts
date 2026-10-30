import assert from "node:assert/strict";
import test from "node:test";

import { slackWireToMarkdown } from "../src/slack-text.ts";

test("slackWireToMarkdown converts Slack wire tokens, entities and mrkdwn", () => {
  assert.equal(
    slackWireToMarkdown("hi <@U1|regan> see <https://x.co/a?b=1&amp;c=2|the doc> *bold* _it_ ~gone~"),
    "hi **@regan** see [the doc](<https://x.co/a?b=1&c=2>) **bold** *it* ~~gone~~",
  );
  assert.equal(slackWireToMarkdown("<https://y.co>"), "<https://y.co>");
  assert.equal(slackWireToMarkdown("• one\n• two"), "- one  \n- two");
});

test("slackWireToMarkdown keeps code literal and angle text inert", () => {
  assert.equal(slackWireToMarkdown("`a &lt;b&gt; *x*` &lt;tag&gt;"), "`a <b> *x*` &lt;tag&gt;");
  assert.equal(slackWireToMarkdown("<javascript:alert(1)|x>"), "&lt;javascript:alert(1)|x&gt;");
});

test("slackWireToMarkdown emphasis:false leaves Markdown emphasis alone", () => {
  assert.equal(
    slackWireToMarkdown("**done** _see_ <https://a.co|[x]> in <#C1|general>", { emphasis: false }),
    "**done** _see_ [\\[x\\]](<https://a.co>) in #general",
  );
});
