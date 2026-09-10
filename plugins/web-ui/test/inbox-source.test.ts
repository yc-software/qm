import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const shellState = readFileSync(new URL("../src/shell-state.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const draftReview = readFileSync(new URL("../src/draft-review.ts", import.meta.url), "utf8");

test("inbox is a first-class view with a draggable sidebar entry", () => {
  assert.match(shellState, /"chats",\s*"inbox",\s*"contexts"/);
  assert.match(shell, /case "inbox":\s*void renderInbox\(\);/);
  assert.match(shell, /data-view="inbox"/);
  assert.match(shell, /application\/x-webui-inbox/);
  assert.match(shell, /nav-badge/);
});

test("inbox access rides the existing permissions plumbing", () => {
  assert.match(shell, /can\("inbox"\) \? inboxNavRow\(\) : nothing/);
  assert.match(shellState, /if \(view === "inbox"\) return can\("inbox"\);/);
  assert.match(server, /process\.env\.INBOX_USERS/);
  assert.match(server, /INBOX_USERS\.has\("all"\) \|\| INBOX_USERS\.has\(principalId\.trim\(\)\.toLowerCase\(\)\)/);
  assert.match(server, /if \(isInboxUser\(user\)\) permissions\.push\("inbox"\);/);
  assert.match(draftReview, /if \(!can\("inbox"\)\)/);
  assert.match(draftReview, /can\("inbox"\) \? inboxOpenCount\(id\) : 0/);
  assert.match(inbox, /if \(!can\("inbox"\)\) return;/);
});

test("the split canvas accepts inbox views as panes alongside sessions", () => {
  assert.match(inbox, /registerPaneKind\(\{/, "the inbox registers itself as a pane kind");
  assert.match(inbox, /paramsKey: "inboxView"/, "saved layouts keep loading under the inboxView key");
  assert.match(inbox, /mountInboxPane\(\{ host, viewId: id/, "pane content mounts the inbox surface");
  assert.match(
    inbox,
    /badge: \(id\) => \(can\("inbox"\) \? inboxOpenCount\(id\) : 0\)/,
    "the gated tab strip shows the open count",
  );
  assert.match(split, /paneKindEntry\(this\.params\)/, "pane content resolves its kind through the registry");
  assert.match(split, /conversation: Conversation \| null = null/);
  assert.match(split, /private ensureConversation\(\): Conversation/);
});

test("an inbox drag paints drop zones on every existing pane", () => {
  assert.match(
    split,
    /render\(paneDrag \? paneZonesTpl\(this\.panelId\) : nothing/,
    "zones render for any pane drag, inbox included",
  );
  assert.match(
    inbox,
    /beginPaneKindDrag\("draftReview", surface\.viewId\)/,
    "draft review enters the shared drag path",
  );
  assert.match(shell, /beginPaneKindDrag\("inboxView", "all"\)/, "the sidebar row drags the whole inbox");
  assert.doesNotMatch(inbox, /beginPaneKindDrag\("inboxView"/, "view chips are plain tabs, not drag handles");
});

test("email items edit like an email; slack items like slack", () => {
  assert.match(inbox, /<span>To<\/span>/);
  assert.match(inbox, /<span>Subject<\/span>/);
  assert.match(inbox, /Send it/, "send lives in the composer as a suggested action");
  assert.match(inbox, /inbox-chat-suggest/, "suggested actions render inside the ask composer");
  assert.match(inbox, /Send the drafted reply in Gmail/);
  assert.match(inbox, /Send the drafted reply to Slack/);
  assert.match(inbox, /rows=\$\{gmail \? 7 : 3\}/, "email drafts get a taller editor than slack replies");
});

test("the address keeps naming the open item, even after switchView writes the bare view path", () => {
  assert.match(
    inbox,
    /if \(fullSurface\.selectedId && !openItem && inboxState\.loaded\) fullSurface\.selectedId = null;\s*(\/\*[\s\S]*?\*\/\s*)?syncItemUrl\(fullSurface\.selectedId\);/,
    "every draw re-states the URL from the selection it just rendered",
  );
  assert.match(
    shell,
    /const next = deepLinkPath\(UI_BASE, appState\.currentView, sessionId, contextsState\.selected\);/,
    "syncUrlFromState carries no item id, which is what the inbox has to heal after",
  );
  const draw = inbox.match(/function drawFull\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(draw, /pendingItemId/, "a deep link reaches the draw as pendingItemId");
  assert.match(inbox, /function syncItemUrl\(itemId: string \| null, push = false\)/);
  assert.match(inbox, /if \(appState\.currentView !== "inbox"\) return;/, "and never writes from another view");
});

test("every draft links back to the session that produced it", () => {
  assert.match(inbox, /draftSessionId/);
  assert.match(inbox, /deepLinkPath\(UI_BASE, "chats", item.draftSessionId\)/);
  assert.match(inbox, /Open agent session/);
});

test("drafts persist on blur and send uses the current edit", () => {
  assert.match(inbox, /@blur=\$\{\(\) => void persistDraft\(item\)\}/);
  assert.match(inbox, /const draft = effectiveDraft\(item\);/);
  assert.match(
    inbox,
    /`\/api\/loops\/\$\{encodeURIComponent\(item\.loopId\)\}\/items\/\$\{encodeURIComponent\(item\.id\)\}\/\$\{leaf\}`/,
    "every item mutation addresses the ledger item under its own loop",
  );
  assert.match(inbox, /postAction\(item, "edit", \{\s*proposal,/, "a blurred edit revises the proposal");
  assert.match(
    inbox,
    /postAction\(item, "send", \{\s*proposal: draft,\s*\.\.\.\(basedOnAt !== undefined \? \{ expectedProposalAt: basedOnAt \} : \{\}\),\s*\}\)/,
    "send carries the current edit and the draft version it was based on",
  );
  assert.match(inbox, /postAction\(item, status === "dismissed" \? "dismiss" : "reopen"\)/);
});

test("the inbox reads the loop's ledger, not a bespoke inbox endpoint", () => {
  assert.doesNotMatch(inbox, /\/api\/inbox\/items/, "the bespoke item routes are gone");
  assert.match(inbox, /api<\{ items: LedgerItem\[\] \}>\(`\/api\/loops\/\$\{encodeURIComponent\(loopId\)\}\/items`\)/);
  assert.match(inbox, /inboxState\.loopId = found\.loop\?\.id \?\? null;/);
  assert.match(inbox, /if \(entry\.state === "actioned"\) return "sent";/);
  assert.match(inbox, /return entry\.actionKind === "replied" \? "replied" : "dismissed";/);
  assert.match(inbox, /const payload = entry\.sourcePayload;/, "source fields are read out of the opaque payload");
});

test("each item carries a follow-up chat with the agent", () => {
  assert.match(inbox, /export function chatTpl\(item: InboxItem\): TemplateResult/);
  assert.match(inbox, /actionPath\(item, "followup"\)/);
  assert.match(inbox, /body: JSON\.stringify\(\{ message: text \}\)/);
  assert.match(inbox, /\$\{chatTpl\(item\)\}/, "the chat pane hangs off the draft editor");
  assert.match(inbox, /item\.thread\.map\(/, "the thread transcript renders");
  assert.match(inbox, /draftEdits\.delete\(item\.id\);/, "a revised proposal supersedes the local edit");
  assert.match(css, /\.inbox-chat-log \{/);
  assert.match(css, /\.inbox-chat-msg\.human \{/);
  assert.match(css, /\.inbox-chat-composer \{/);
});

test("handled items keep their history but stay out of the way", () => {
  assert.match(inbox, /Handled \(/);
  assert.match(inbox, /if \(item\.status === "sent"\) return "Sent";/);
  assert.match(inbox, /if \(item\.status === "replied"\) return "Replied";/);
  assert.match(inbox, /return "Dismissed";/);
  assert.match(inbox, /Reopen/);
});

test("an external reply in Slack or Gmail closes the loop in the UI", () => {
  assert.match(
    inbox,
    /status: "open" \| "sent" \| "dismissed" \| "replied"/,
    "the item type learns the replied status",
  );
  assert.match(inbox, /externalReplyText\?: string;/);
  assert.match(inbox, /You replied in \$\{where\}/);
  assert.match(inbox, /item\.source === "slack" \? "Slack" : "Gmail"/);
  assert.match(inbox, /item\.externalReplyText \? html`<div class="inbox-replied-text">/);
  assert.match(
    inbox,
    /resolved === "replied" && entry\.actionResult \? \{ externalReplyText: entry\.actionResult \}/,
    "the reply text rides the ledger action result, not a bespoke field",
  );
});

test("the inbox reads reactions but no longer writes them — no react or emoji-insert affordance", () => {
  assert.doesNotMatch(inbox, /reactToItem/, "reacting from the inbox is gone with its button");
  assert.doesNotMatch(inbox, /insertIntoDraftBody/, "so is inserting an emoji into a draft");
  assert.doesNotMatch(inbox, /openEmojiPicker/, "and nothing opens the picker anymore");
  assert.match(inbox, /item\.reactions\?\.length/, "reactions added elsewhere still render as chips");
  assert.match(inbox, /charForName\(name\)/);
  assert.match(inbox, /Array\.isArray\(payload\.reactions\)/, "the chips read the opaque source payload");
  assert.doesNotMatch(inbox, /\/api\/inbox\/items/, "ledger actions ride the generic loop item routes");
  assert.match(
    server,
    /\/v1\/loops\/\$\{encodeURIComponent\(params\.id!\)\}\/items\/\$\{encodeURIComponent\(params\.itemId!\)\}\/\$\{leaf\}/,
    "one relay still carries every ledger item intent",
  );
});

test("the reaction chip and replied-text styles ship with the stylesheet", () => {
  assert.doesNotMatch(css, /\.emoji-picker/, "the picker went with the affordance that opened it");
  assert.match(css, /\.inbox-reaction-chip \{/);
  assert.match(css, /\.inbox-replied-text \{/);
});

test("the inbox stylesheet exists and scopes to inbox- classes", () => {
  assert.match(css, /\.inbox-surface \{/);
  assert.match(css, /\.inbox-chip\.active \{/);
  assert.match(css, /\.pane-kind-count \{/);
  assert.match(css, /\.nav-badge \{/);
});

test("a send refused because the agent redrafted keeps the person's edit and shows the new draft", () => {
  assert.match(inbox, /status === 409 && \/draft changed\/i\.test\(e\.message\)/);
  assert.match(inbox, /await refetchItem\(item\);/);
  assert.match(
    inbox,
    /redrafted this reply while you were editing\. Your text is kept in the box\. New draft: "\$\{preview\}"/,
  );
});

test("an edit remembers the draft version it started from, and both edit and send carry it", () => {
  assert.match(inbox, /const basedOnAt = draftEdits\.get\(item\.id\)\?\.basedOnAt \?\? item\.draftAt;/);
  assert.match(
    inbox,
    /postAction\(item, "edit", \{\s*proposal,\s*\.\.\.\(basedOnAt !== undefined \? \{ expectedProposalAt: basedOnAt \} : \{\}\),/,
  );
  assert.match(inbox, /const basedOnAt = edited\?\.basedOnAt \?\? item\.draftAt;/);
  assert.match(inbox, /if \(isDraftConflict\(e\)\) return explainDraftConflict\(item, true\);/);
});

test("draft header links stay together after the label", () => {
  assert.match(css, /\.inbox-draft-label \{[^}]*margin-right: auto;/);
  assert.doesNotMatch(css, /\.inbox-session-link \{[^}]*margin-left: auto;/);
  assert.doesNotMatch(css, /\.inbox-draft-head \.inbox-external-link \{[^}]*margin-left: auto;/);
});

test("suggested draft actions yield to typed instructions without reflow", () => {
  assert.match(inbox, /inbox-chat-composer \$\{pending\.trim\(\) \? "has-text" : ""\}/);
  assert.match(inbox, /if \(had !== Boolean\(box\.value\.trim\(\)\)\) drawAll\(\);/);
  assert.match(css, /\.inbox-chat-composer\.has-text \.inbox-chat-suggest \{\s*visibility: hidden;/);
  assert.doesNotMatch(inbox, /inbox-draft-actions|function sendLabel/);
});

test("conversation messages use the containing view's scroll instead of clipping the latest message", () => {
  const context = css.match(/\.inbox-context \{[^}]*\}/)?.[0] ?? "";
  assert.match(context, /flex: none;/);
  assert.doesNotMatch(context, /max-height:|overflow-y:/);
});
