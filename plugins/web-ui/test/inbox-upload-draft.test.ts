import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComposerSurface } from "../src/conv-types.ts";
import { createInboxFixture, inboxRuntime, until } from "./inbox-composer-fixture.ts";

test("a submission freezes the edited draft before upload and never retries a conflicting blur save", async () => {
  const state = globalThis as typeof globalThis & { inboxTestComposer?: ComposerSurface };
  const { vite, host, close } = await createInboxFixture({
    dom: { pretendToBeVisual: true },
    plugins: [
      {
        name: "capture-inbox-composer",
        enforce: "pre",
        transform(code, id) {
          if (id.endsWith("/embedded-composer.ts"))
            return code.replace(
              "this.ctx = ctx;",
              "(globalThis as any).inboxTestComposer = ctx.composer; this.ctx = ctx;",
            );
        },
      },
    ],
  });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "taylor@example.com" };
    const inbox = await vite.ssrLoadModule("/src/inbox.ts");
    const { render } = await vite.ssrLoadModule("lit");
    for (const conflict of [true, false]) {
      render(null, host);
      inbox.resetInboxState();
      const ledger = {
        id: `upload-${conflict}`,
        loopId: "loop",
        state: "held",
        source: "gmail",
        sourcePayload: {},
        proposal: { data: { body: "Original" }, by: "agent", at: 100 },
        thread: [],
        updatedAt: 100,
      };
      const item = inbox.toInboxItem(ledger);
      inbox.inboxState.items = [item];
      let releaseEdit: (() => void) | undefined;
      let releaseUpload: (() => void) | undefined;
      let edits = 0;
      let followups = 0;
      globalThis.fetch = async (url, init) => {
        const path = String(url);
        if (path.includes("runtime-config")) return Response.json(inboxRuntime);
        if (path.includes("/api/blobs")) {
          await new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          return Response.json({ blobId: "test-file", sizeBytes: 1 });
        }
        if (path.endsWith("/action")) {
          edits++;
          await new Promise<void>((resolve) => {
            releaseEdit = resolve;
          });
          ledger.proposal = {
            data: { body: conflict ? "Unreviewed replacement" : "My edited draft" },
            by: conflict ? "agent" : "human",
            at: 101,
          };
          return conflict
            ? Response.json({ message: "the draft changed" }, { status: 409 })
            : Response.json({ item: ledger });
        }
        if (path.endsWith("/followup")) {
          followups++;
          const body = JSON.parse(String(init?.body));
          assert.equal(body.message, "Send it");
          assert.equal(body.expectedProposalAt, 101);
          assert.equal(body.attachments[0].blobId, "test-file");
        }
        return Response.json({ item: ledger });
      };
      render(inbox.chatTpl(item), host);
      await until(() => Boolean(host.querySelector(".composer-input:not(:disabled)")));
      const draft = host.querySelector<HTMLTextAreaElement>(".inbox-draft-body")!;
      draft.value = "My edited draft";
      draft.dispatchEvent(new Event("input", { bubbles: true }));
      state.inboxTestComposer!.state.attachments = [
        { id: "file", type: "document", fileName: "notes.txt", mimeType: "text/plain", size: 1, content: "eA==" },
      ];
      const saving = inbox.persistDraft(item);
      await until(() => Boolean(releaseEdit));
      host.querySelector<HTMLButtonElement>(".inbox-suggest-chip.primary")!.click();
      await until(() => Boolean(releaseUpload));
      releaseEdit!();
      await saving;
      releaseUpload!();
      await until(() => followups > 0 || Boolean(host.querySelector(".composer-error")));
      assert.equal(edits, 1);
      assert.equal(followups, conflict ? 0 : 1);
      if (conflict) {
        assert.equal(state.inboxTestComposer!.state.attachments[0]?.fileName, "notes.txt");
        assert.equal(state.inboxTestComposer!.state.draft, "Send it");
      }
    }
    render(null, host);
  } finally {
    delete state.inboxTestComposer;
    await close();
  }
});
