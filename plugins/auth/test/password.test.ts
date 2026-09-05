import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeQuery,
  fakePasswords,
  hiddenChangeToken,
  hiddenRequestToken,
  pkcePair,
  REDIRECT_URI,
  startHarness,
  type FakePasswords,
  type Harness,
} from "./helpers.ts";

const form = (entries: Record<string, string>): { method: string; headers: Record<string, string>; body: string } => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(entries).toString(),
});

const PASSWORD_ENV = { AUTH_CREDENTIAL_TRANSPORT: "password", CORE_SIGNING_SECRET: "x".repeat(40) };

async function passwordHarness(
  passwords: FakePasswords,
  env: Record<string, string | undefined> = {},
): Promise<Harness> {
  return startHarness({ env: { ...PASSWORD_ENV, ...env }, passwords });
}

/** Render the sign-in form and return the request token it carries. */
async function openForm(h: Harness): Promise<{ request: string; verifier: string; state: string; html: string }> {
  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge });
  const page = await fetch(`${h.base}/authorize?${query}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  return { request: hiddenRequestToken(html), verifier, state: query.get("state")!, html };
}

test("the authorize page asks for a password, not an emailed link", async () => {
  const h = await passwordHarness(fakePasswords({ "ops@example.com": { password: "correct horse" } }));
  try {
    const { html } = await openForm(h);
    assert.match(html, /name="password"/);
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /Email me a sign-in link/);
  } finally {
    await h.close();
  }
});

test("a correct password returns an authorization code and mails nothing", async () => {
  const h = await passwordHarness(fakePasswords({ "ops@example.com": { password: "correct horse" } }));
  try {
    const { request, state } = await openForm(h);
    const res = await fetch(`${h.base}/authorize`, {
      ...form({ request, email: "ops@example.com", password: "correct horse" }),
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location")!);
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
    assert.equal(location.searchParams.get("state"), state);
    assert.ok(location.searchParams.get("code"));
    assert.equal(h.mailer.sent.length, 0);
  } finally {
    await h.close();
  }
});

test("a wrong password and an unknown address are indistinguishable", async () => {
  const h = await passwordHarness(fakePasswords({ "ops@example.com": { password: "correct horse" } }));
  try {
    const wrong = await openForm(h);
    const a = await fetch(
      `${h.base}/authorize`,
      form({ request: wrong.request, email: "ops@example.com", password: "no" }),
    );
    const unknown = await openForm(h);
    const b = await fetch(
      `${h.base}/authorize`,
      form({ request: unknown.request, email: "nobody@example.com", password: "no" }),
    );
    assert.equal(a.status, b.status);
    const [textA, textB] = await Promise.all([a.text(), b.text()]);
    // The pages differ only in the value echoed back and the fresh request
    // token; the outcome they report must be the same sentence.
    const outcome = (html: string): string => /<p class="reason">(.*?)<\/p>/s.exec(html)?.[1] ?? "";
    assert.equal(outcome(textA), outcome(textB));
    assert.match(outcome(textA), /did not match an account/);
  } finally {
    await h.close();
  }
});

test("an account that must change its password reaches no code until it does", async () => {
  const passwords = fakePasswords({ "ops@example.com": { password: "issued-by-admin", mustChange: true } });
  const h = await passwordHarness(passwords);
  try {
    const { request, state } = await openForm(h);
    const gate = await fetch(
      `${h.base}/authorize`,
      form({ request, email: "ops@example.com", password: "issued-by-admin" }),
    );
    assert.equal(gate.status, 200);
    const html = await gate.text();
    assert.match(html, /Choose a new password/);
    const change = hiddenChangeToken(html);

    const mismatch = await fetch(
      `${h.base}/password`,
      form({ change, current: "issued-by-admin", password: "a-longer-one", confirm: "different" }),
    );
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /did not match/);

    const short = await fetch(
      `${h.base}/password`,
      form({ change, current: "issued-by-admin", password: "short", confirm: "short" }),
    );
    assert.equal(short.status, 400);
    assert.match(await short.text(), /at least 8 characters/);

    const done = await fetch(`${h.base}/password`, {
      ...form({ change, current: "issued-by-admin", password: "a-longer-one", confirm: "a-longer-one" }),
      redirect: "manual",
    });
    assert.equal(done.status, 302);
    assert.equal(new URL(done.headers.get("location")!).searchParams.get("state"), state);
    assert.equal(passwords.accounts.get("ops@example.com")!.password, "a-longer-one");
    assert.equal(passwords.accounts.get("ops@example.com")!.mustChange, false);
  } finally {
    await h.close();
  }
});

test("core being unreachable refuses rather than admits", async () => {
  const passwords = fakePasswords({ "ops@example.com": { password: "correct horse" } });
  passwords.unavailable = true;
  const h = await passwordHarness(passwords);
  try {
    const { request } = await openForm(h);
    const res = await fetch(
      `${h.base}/authorize`,
      form({ request, email: "ops@example.com", password: "correct horse" }),
    );
    assert.equal(res.status, 503);
    assert.doesNotMatch(res.headers.get("location") ?? "", /code=/);
  } finally {
    await h.close();
  }
});

test("the mailed-link endpoints do not exist in password mode", async () => {
  const h = await passwordHarness(fakePasswords({ "ops@example.com": { password: "correct horse" } }));
  try {
    assert.equal((await fetch(`${h.base}/verify`)).status, 404);
    assert.equal((await fetch(`${h.base}/verify`, form({ token: "anything" }))).status, 404);
  } finally {
    await h.close();
  }
});

test("an allow-list still applies in password mode when one is configured", async () => {
  const h = await passwordHarness(fakePasswords({ "outsider@elsewhere.test": { password: "correct horse" } }), {
    AUTH_ALLOWED_EMAILS: "ops@example.com",
  });
  try {
    const { request } = await openForm(h);
    const res = await fetch(
      `${h.base}/authorize`,
      form({ request, email: "outsider@elsewhere.test", password: "correct horse" }),
    );
    assert.equal(res.status, 400);
    // Refused before the password ever left the broker.
    assert.equal(h.passwords.calls.length, 0);
  } finally {
    await h.close();
  }
});

test("the password change route is absent in email-link mode", async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.base}/password`, form({ change: "x", password: "y", confirm: "y" }));
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

// The portal proxies a fixed list of broker paths and nothing else, so a broker
// page the portal does not know about is unreachable from a browser. That is
// how the change step shipped broken. This pins the path the portal was told
// about, so moving it fails here rather than in a deployment.
test("the change-password form posts to /password, which the portal's proxy list names", async () => {
  const h = await passwordHarness(
    fakePasswords({ "ops@example.com": { password: "issued-by-admin", mustChange: true } }),
  );
  try {
    const { request } = await openForm(h);
    const res = await fetch(`${h.base}/authorize`, form({ request, email: "ops@example.com", password: "issued-by-admin" }));
    assert.equal(res.status, 200);
    const html = await res.text();
    const action = /<form[^>]*action="([^"]*)"/.exec(html)?.[1];
    assert.ok(action, "the change page must render a form");
    assert.equal(
      new URL(action, "http://broker.invalid").pathname.replace(/^.*(?=\/password$)/, ""),
      "/password",
      "plugins/portal BROKER_PUBLIC_ROUTES must carry whatever this is",
    );
  } finally {
    await h.close();
  }
});
