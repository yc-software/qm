import { test, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("../src/util/async.ts", { namedExports: { sleep: async () => {} } });

const { formatDeployNotice, postDeployNotice } = await import("../scripts/deploy-notice.ts");

const REPO = "yc-software/qm";
const SHA = "82e6c9550aa11bb22cc33dd44ee55ff66aa77bb8";

const notice = (subject: string) => formatDeployNotice({ subject, repo: REPO, sha: SHA });

test("a PR reference becomes a Slack link and the bare parens go away", () => {
  assert.equal(
    notice("fix(web-ui): align the sample toolbar (#101)"),
    "🔧 fix(web-ui): align the sample toolbar " + `<https://github.com/${REPO}/pull/101|#101>`,
  );
});

test("the emoji comes from the conventional-commit type", () => {
  assert.match(notice("feat(files): add sample export (#102)"), /^✨ /);
  assert.match(notice("perf: speed up sample lookup (#103)"), /^⚡ /);
  assert.match(notice("refactor: simplify sample formatter (#104)"), /^🧹 /);
  assert.match(notice("revert: restore sample layout (#105)"), /^⏪ /);
  assert.match(notice("feat!: replace sample format (#106)"), /^✨ /);
});

test("prose before a colon is not mistaken for a commit type", () => {
  assert.equal(
    notice("Update sample settings: use consistent defaults (#107)"),
    `🚀 Update sample settings: use consistent defaults <https://github.com/${REPO}/pull/107|#107>`,
  );
  assert.match(notice("wibble(thing): not a real type (#7)"), /^🚀 /);
});

test("without a PR reference the notice links the commit by short sha", () => {
  assert.equal(
    notice("docs: hand-written deploy note"),
    `📝 docs: hand-written deploy note <https://github.com/${REPO}/commit/${SHA}|82e6c95>`,
  );
});

test("only a trailing PR reference is rewritten", () => {
  assert.equal(
    notice("fix: revert (#12) so the ordering holds (#34)"),
    `🔧 fix: revert (#12) so the ordering holds <https://github.com/${REPO}/pull/34|#34>`,
  );
});

test("Slack's control characters in a subject are escaped", () => {
  assert.equal(
    notice("chore: tidy <Files> & Connectors (#99)"),
    `⚙️ chore: tidy &lt;Files&gt; &amp; Connectors <https://github.com/${REPO}/pull/99|#99>`,
  );
});

test("postDeployNotice sends the text as a Slack webhook payload", async () => {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response("ok", { status: 200 });
  };
  try {
    await postDeployNotice("https://hooks.slack.test/services/abc", "🚀 hello");
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(calls, [{ url: "https://hooks.slack.test/services/abc", body: { text: "🚀 hello" } }]);
});

test("postDeployNotice retries a failing post and then throws", async () => {
  const real = globalThis.fetch;
  let attempts = 0;
  (globalThis as any).fetch = async () => {
    attempts++;
    return new Response("no_service", { status: 404 });
  };
  try {
    await assert.rejects(
      () => postDeployNotice("https://hooks.slack.test/dead", "🚀 hello"),
      /after 3 attempts: 404 no_service/,
    );
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(attempts, 3);
});

test("postDeployNotice stops retrying once a post succeeds", async () => {
  const real = globalThis.fetch;
  let attempts = 0;
  (globalThis as any).fetch = async () => {
    attempts++;
    return attempts === 1 ? new Response("", { status: 503 }) : new Response("ok", { status: 200 });
  };
  try {
    await postDeployNotice("https://hooks.slack.test/flaky", "🚀 hello");
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(attempts, 2);
});
