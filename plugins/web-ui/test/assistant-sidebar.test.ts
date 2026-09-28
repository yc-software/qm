import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture } from "./inbox-composer-fixture.ts";

test("shared sidebar prompts follow thread state and whole inbox context", async () => {
  const { vite, host, close } = await createInboxFixture();
  try {
    const { assistantPrompts, assistantSidebar, assistantMessage } =
      await vite.ssrLoadModule("/src/assistant-sidebar.ts");
    const { render, html } = await vite.ssrLoadModule("lit");
    const thread = { kind: "thread", source: "gmail", hasDraft: true, sent: false, resolved: false };
    assert.deepEqual(assistantPrompts(thread), ["Make it shorter", "Make it more friendly", "Remove the salutations"]);
    assert.deepEqual(assistantPrompts({ ...thread, hasDraft: false }), [
      "Summarize this thread",
      "Help me write a reply",
    ]);
    assert.deepEqual(assistantPrompts({ ...thread, resolved: true }), [
      "Summarize this thread",
      "Does this still need a reply?",
    ]);
    assert.deepEqual(assistantPrompts({ ...thread, sent: true }), [
      "Summarize this email",
      "What should I follow up on?",
    ]);
    assert.deepEqual(assistantPrompts({ ...thread, source: "generic" }), [
      "Explain the proposal",
      "What needs my input?",
    ]);
    const contexts = [thread, { kind: "inbox", hasEmail: true, hasSlack: false, hasDrafts: false }];
    const classes: string[] = [];
    for (const context of contexts) {
      const clicked: string[] = [];
      render(
        assistantSidebar({
          context,
          messages: assistantMessage({ role: "human", text: "Keep it short.\nTwo lines." }),
          composer: html`<textarea></textarea>`,
          showPrompts: true,
          onPrompt: (prompt: string) => clicked.push(prompt),
        }),
        host,
      );
      assert.equal(host.querySelector(".inbox-chat-text")!.textContent, "Keep it short.\nTwo lines.");
      host.querySelector<HTMLButtonElement>(".inbox-chat-suggestion")!.click();
      assert.deepEqual(clicked, [assistantPrompts(context)[0]]);
      classes.push([...new Set([...host.querySelectorAll("[class]")].map((element) => element.className))].join("|"));
    }
    assert.equal(classes[0], classes[1]);
    render(assistantMessage({ role: "human", text: "", before: html`<a>Attachment</a>` }), host);
    assert.equal(host.querySelector<HTMLElement>(".inbox-chat-text")!.hidden, true);
    assert.equal(host.querySelector("a")!.textContent, "Attachment");
  } finally {
    await close();
  }
});
