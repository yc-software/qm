import { assert, waitForFinalBotMessage, type Actor, type Ctx, type Scenario } from "./harness.ts";
import { sleep, type SlackMessage } from "./slack.ts";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../src/auth/portal-identity.ts";
import { trimTrailingSlashes } from "../../src/util/text.ts";

const CORE = () => trimTrailingSlashes(process.env.CORE_API_URL ?? "http://localhost:8181");
const SECRET = () => process.env.CORE_SIGNING_SECRET ?? "";
const ORG = () => (process.env.LIVE_E2E_ORG_SCOPE ?? "org:acme").split(":")[1] ?? "acme";
const ADMIN = () => process.env.LIVE_E2E_ADMIN_PRINCIPAL || "admin-alice";
const TURN_MS = 4 * 60_000;

interface CronRow {
  id: string;
  owner: string;
  ownerScopeId: string;
  createdBy?: string;
  enabled: boolean;
  title?: string;
  action?: string;
  message?: string;
  sharedFrom?: string;
  forkedAt?: number;
}

interface Grantee {
  scope: string;
  permission: string;
  status?: string;
}

async function api(
  as: string,
  method: string,
  path: string,
  body?: unknown,
  admin = false,
): Promise<{ status: number; data: any; text: string }> {
  const salted = `${path}${path.includes("?") ? "&" : "?"}_nonce=${crypto.randomUUID()}`;
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = signedRequestHeaders(SECRET(), method, salted, raw, {
    "content-type": "application/json",
    [PORTAL_IDENTITY_HEADER]: await mintPortalIdentity({ p: as, exp: Date.now() + 60_000 }, SECRET()),
    ...(admin ? { "x-admin-actor": `${as}@${ORG()}` } : {}),
  });
  const res = await fetch(`${CORE()}${salted}`, {
    method,
    headers,
    signal: AbortSignal.timeout(120_000),
    ...(raw ? { body: raw } : {}),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch {
    void 0;
  }
  return { status: res.status, data, text };
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last error: ${String(last)})` : ""}`);
}

const principals = new Map<string, string>();

async function prime(ctx: Ctx): Promise<void> {
  for (const a of ctx.env.actors.values()) {
    if (principals.has(a.userId)) continue;
    const r = await ctx.env.core.resolveDirectory(a.handle);
    const hit = r.members.find((m) => m.principalId === a.userId || m.displayName === a.handle) ?? r.members[0];
    principals.set(a.userId, hit?.principalId ?? a.userId);
  }
}

const pid = (a: Actor): string => principals.get(a.userId) ?? a.userId;

async function cronsOf(principal: string): Promise<CronRow[]> {
  const r = await api(principal, "GET", `/v1/crons?viewer=${encodeURIComponent(principal)}`);
  assert.equal(r.status, 200, `list crons for ${principal}: ${r.text.slice(0, 200)}`);
  return r.data.crons as CronRow[];
}

async function cronTitled(principal: string, marker: string): Promise<CronRow | undefined> {
  return (await cronsOf(principal)).find((c) => (c.title ?? "").includes(marker) && !c.sharedFrom);
}

async function copyOf(principal: string, sourceId: string): Promise<CronRow | undefined> {
  return (await cronsOf(principal)).find((c) => c.sharedFrom === sourceId);
}

async function sharesOf(owner: string, type: string, id: string): Promise<Grantee[]> {
  const r = await api(owner, "GET", `/v1/shares/${type}/${encodeURIComponent(id)}`);
  assert.equal(r.status, 200, `read shares of ${type} ${id}: ${r.text.slice(0, 200)}`);
  return r.data.grantees as Grantee[];
}

const granteeOf = (list: Grantee[], principal: string): Grantee[] =>
  list.filter((g) => g.scope === `personal:${principal}`);

class ActorDm {
  readonly ctx: Ctx;
  readonly actor: Actor;
  id = "";

  constructor(ctx: Ctx, actor: Actor) {
    this.ctx = ctx;
    this.actor = actor;
  }

  async open(): Promise<this> {
    this.id = await this.actor.client.openDm(this.ctx.env.botUserId);
    return this;
  }

  async send(text: string): Promise<string> {
    const ts = await this.actor.client.post(this.id, text);
    this.ctx.timeline.recordPost(this.id, ts, this.actor.name, text, ts, "dm");
    return ts;
  }

  reply(afterTs: string, match?: RegExp): Promise<SlackMessage> {
    return waitForFinalBotMessage(() => this.actor.client.history(this.id, afterTs), this.ctx.env.botUserId, afterTs, {
      timeoutMs: TURN_MS,
      ...(match ? { match } : {}),
      record: (ts, text) => this.ctx.timeline.recordBotVersion(this.id, ts, text),
    });
  }

  async ask(text: string, match?: RegExp): Promise<SlackMessage> {
    return this.reply(await this.send(text), match);
  }

  async botSince(ts: string): Promise<SlackMessage[]> {
    return (await this.actor.client.history(this.id, ts)).filter(
      (m) => m.user === this.ctx.env.botUserId && Number(m.ts) > Number(ts),
    );
  }

  async waitBot(label: string, sinceTs: string, test: (text: string) => boolean, timeoutMs = 90_000) {
    return waitFor(
      label,
      async () => {
        const hit = (await this.botSince(sinceTs)).find((m) => test(m.text ?? ""));
        if (hit) this.ctx.timeline.recordBotVersion(this.id, hit.ts, hit.text ?? "");
        return hit;
      },
      timeoutMs,
    );
  }
}

const dm = (ctx: Ctx, name: string) => new ActorDm(ctx, ctx.actor(name)).open();
const nowTs = () => String(Date.now() / 1000 - 1);

function cronAsk(marker: string, extra: string): string {
  return (
    `Create a cron titled "${marker}" that runs every day at 3:17am America/Los_Angeles with the task: ` +
    `reply with exactly "${marker}-fire" and nothing else. ${extra}`
  );
}

async function createAndShare(
  ctx: Ctx,
  owner: ActorDm,
  marker: string,
  shareLine: string,
): Promise<{ source: CronRow; reply: SlackMessage }> {
  const reply = await owner.ask(cronAsk(marker, shareLine));
  const source = await waitFor(`source cron ${marker}`, () => cronTitled(pid(owner.actor), marker), 30_000);
  assert.equal(source.owner, pid(owner.actor), "the source cron belongs to its creator");
  return { source, reply };
}

async function runCron(as: string, id: string): Promise<void> {
  const r = await api(as, "POST", `/v1/crons/${encodeURIComponent(id)}/run?principalId=${encodeURIComponent(as)}`);
  assert.equal(r.status, 200, `run cron ${id} as ${as}: ${r.text.slice(0, 300)}`);
}

const OFFER = /wants to share their cron/;
const STARTED = /shared their cron .* with you, and it is on/;

export const sharingScenarios: Scenario[] = [
  {
    name: "share-cron-offer-accept-runs-as-recipient",
    lane: "dm",
    tags: ["twin", "sharing"],
    actors: ["alice", "bob"],
    timeoutMs: 15 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const alice = await dm(ctx, "alice");
      const bob = await dm(ctx, "bob");
      const since = nowTs();
      const { source } = await createAndShare(ctx, alice, marker, "Then share that cron with bob.");
      const copy = await waitFor("bob's linked copy", () => copyOf(pid(bob.actor), source.id));
      assert.equal(copy.owner, pid(bob.actor));
      assert.equal(copy.ownerScopeId, `personal:${pid(bob.actor)}`);
      assert.equal(copy.createdBy, pid(bob.actor), "the copy runs as the recipient");
      assert.equal(copy.enabled, false, "a non-admin's share waits paused");
      const offer = await bob.waitBot("bob's offer DM", since, (t) => OFFER.test(t) && t.includes(marker));
      assert.ok(offer.text?.includes(copy.id), "the offer names the copy to turn on");
      const before = granteeOf(await sharesOf(pid(alice.actor), "cron", source.id), pid(bob.actor));
      assert.deepEqual(
        before.map((g) => g.status),
        ["paused"],
        `access list shows bob paused: ${JSON.stringify(before)}`,
      );

      const again = await api(pid(alice.actor), "POST", `/v1/shares/cron/${source.id}`, { recipient: "bob" });
      assert.equal(again.status, 200, again.text.slice(0, 200));
      const bobCopies = (await cronsOf(pid(bob.actor))).filter((c) => c.sharedFrom === source.id);
      assert.equal(bobCopies.length, 1, "sharing twice keeps one copy");

      await bob.ask(`I accept the cron "${marker}" that alice shared with me. Please turn it on.`);
      await waitFor("bob's copy to turn on", async () =>
        (await copyOf(pid(bob.actor), source.id))?.enabled ? true : undefined,
      );
      const after = granteeOf(await sharesOf(pid(alice.actor), "cron", source.id), pid(bob.actor));
      assert.deepEqual(
        after.map((g) => g.status),
        ["on"],
        `access list shows bob on: ${JSON.stringify(after)}`,
      );
      const sourceNow = (await cronsOf(pid(alice.actor))).find((c) => c.id === source.id);
      assert.equal(sourceNow?.enabled, true, "the owner's own cron is untouched");

      const fireSince = nowTs();
      await runCron(pid(bob.actor), copy.id);
      await bob.waitBot("the copy's fire in bob's DM", fireSince, (t) => t.includes(`${marker}-fire`), TURN_MS);
      await sleep(5000);
      const leaked = (await alice.botSince(fireSince)).filter((m) => (m.text ?? "").includes(`${marker}-fire`));
      assert.equal(leaked.length, 0, "the copy's fire must not post to the owner");
    },
  },
  {
    name: "share-cron-decline-deletes-copy",
    lane: "dm",
    tags: ["twin", "sharing"],
    actors: ["alice", "carol"],
    timeoutMs: 12 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const alice = await dm(ctx, "alice");
      const carol = await dm(ctx, "carol");
      const since = nowTs();
      const { source } = await createAndShare(ctx, alice, marker, "Then share that cron with carol.");
      const copy = await waitFor("carol's copy", () => copyOf(pid(carol.actor), source.id));
      await carol.waitBot("carol's offer", since, (t) => OFFER.test(t) && t.includes(marker));
      await carol.ask(`No thanks, I decline the cron "${marker}" that alice shared with me. Get rid of it.`);
      await waitFor("carol's copy to be deleted", async () =>
        (await cronsOf(pid(carol.actor))).some((c) => c.id === copy.id) ? undefined : true,
      );
      const after = granteeOf(await sharesOf(pid(alice.actor), "cron", source.id), pid(carol.actor));
      assert.equal(after.length, 0, `carol is gone from the access list: ${JSON.stringify(after)}`);
      assert.ok(
        (await cronsOf(pid(alice.actor))).some((c) => c.id === source.id && c.enabled),
        "declining leaves the owner's cron in place",
      );
    },
  },
  {
    name: "share-cron-write-refused-then-read-then-none",
    lane: "dm",
    tags: ["twin", "sharing"],
    actors: ["alice", "bob"],
    timeoutMs: 15 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const alice = await dm(ctx, "alice");
      const { source, reply } = await createAndShare(
        ctx,
        alice,
        marker,
        "Then share it with bob with write (edit) permission, so he can change it. Use permission write; don't fall back to anything else.",
      );
      await ctx.judge(
        "A person asked an assistant to share their personal cron with a teammate for editing (write permission). Does the reply tell them this was refused or isn't possible for a personal cron (rather than claiming the teammate can now edit it)?",
        reply.text ?? "",
      );
      assert.equal(await copyOf(pid(ctx.actor("bob")), source.id), undefined, "a refused write share makes no copy");
      const refused = granteeOf(await sharesOf(pid(alice.actor), "cron", source.id), pid(ctx.actor("bob")));
      assert.equal(refused.length, 0, `no grant after refusal: ${JSON.stringify(refused)}`);

      await alice.ask(`OK, then just share cron "${marker}" with bob normally (read).`);
      const copy = await waitFor("bob's copy", () => copyOf(pid(ctx.actor("bob")), source.id));
      const view = await alice.ask(`Remove bob's access to cron "${marker}" (permission none).`);
      await waitFor("copy detached", async () =>
        granteeOf(await sharesOf(pid(alice.actor), "cron", source.id), pid(ctx.actor("bob"))).length === 0
          ? true
          : undefined,
      );
      const left = (await cronsOf(pid(ctx.actor("bob")))).find((c) => c.id === copy.id);
      assert.ok(left, "unsharing leaves the recipient's copy in place");
      assert.equal(left.sharedFrom, undefined, "unsharing detaches the copy");
      assert.ok(view.text, "alice got a reply");
    },
  },
  {
    name: "share-skill-read-then-write-then-none",
    lane: "dm",
    tags: ["twin", "sharing"],
    actors: ["alice", "bob", "carol"],
    timeoutMs: 15 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const name = `qa-skill-${marker.slice(-24).replace(/[^a-z0-9-]/g, "-")}`.replace(/-+/g, "-");
      const secret = `${marker}-SECRET`;
      const alice = await dm(ctx, "alice");
      const bob = ctx.actor("bob");
      const saved = await api(pid(alice.actor), "POST", "/v1/skills", {
        principalId: pid(alice.actor),
        name,
        description: "QA sharing check",
        body: `The password is ${secret}.`,
      });
      assert.ok(saved.status < 300, `seed skill: ${saved.text.slice(0, 200)}`);
      const skill = saved.data.skill as { id: string; name: string };
      await alice.ask(`Share my skill "${name}" with bob (read).`);
      const read = await waitFor("bob read grant", async () => {
        const g = granteeOf(await sharesOf(pid(alice.actor), "skill", skill.id), pid(bob));
        return g.length ? g : undefined;
      });
      assert.deepEqual(
        read.map((g) => g.permission),
        ["read"],
      );
      const bobSees = await api(pid(bob), "GET", `/v1/skills?principalId=${pid(bob)}`);
      assert.ok(
        (bobSees.data.skills as Array<{ id: string }>).some((s) => s.id === skill.id),
        "bob can see the shared skill",
      );
      const carol = pid(ctx.actor("carol"));
      const carolSees = await api(carol, "GET", `/v1/skills?principalId=${carol}`);
      assert.ok(
        !(carolSees.data.skills as Array<{ id: string }> | undefined)?.some((s) => s.id === skill.id),
        "carol can't see it",
      );

      await alice.ask(`Upgrade bob to write (edit) access on skill "${name}".`);
      const write = await waitFor("bob write grant", async () => {
        const g = granteeOf(await sharesOf(pid(alice.actor), "skill", skill.id), pid(bob));
        return g.some((x) => x.permission === "write") ? g : undefined;
      });
      assert.deepEqual(
        write.map((g) => g.permission),
        ["write"],
        "a grant replaces the earlier permission",
      );

      await alice.ask(`Now remove bob's access to skill "${name}" entirely (permission none).`);
      await waitFor("bob's grant removed", async () =>
        granteeOf(await sharesOf(pid(alice.actor), "skill", skill.id), pid(bob)).length === 0 ? true : undefined,
      );
      const gone = await api(pid(bob), "GET", `/v1/skills?principalId=${pid(bob)}`);
      assert.ok(!(gone.data.skills as Array<{ id: string }>).some((s) => s.id === skill.id), "bob lost the skill");
    },
  },
  {
    name: "share-app-with-teammate-then-revoke",
    lane: "dm",
    tags: ["twin", "sharing", "deploy"],
    actors: ["alice", "bob"],
    timeoutMs: 12 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const slug = `share-${crypto.randomUUID().slice(0, 8)}`;
      const alice = await dm(ctx, "alice");
      const bob = await dm(ctx, "bob");
      const published = await api(pid(alice.actor), "POST", "/v1/apps", {
        ownerScopeId: `personal:${pid(alice.actor)}`,
        createdBy: pid(alice.actor),
        name: slug,
        entrypoint: "node server.mjs",
        files: [
          {
            path: "server.mjs",
            data: `import { createServer } from "node:http";\ncreateServer((q, s) => s.end("${marker}")).listen(Number(process.env.PORT));\n`,
          },
        ],
      });
      assert.equal(published.status, 200, `publish: ${published.text.slice(0, 300)}`);
      const appId = published.data.app.id as string;
      const since = nowTs();
      await alice.ask(`Share my app "${slug}" with bob so he can open it.`);
      const g = await waitFor("bob's app grant", async () => {
        const list = granteeOf(await sharesOf(pid(alice.actor), "deploy", appId), pid(bob.actor));
        return list.length ? list : undefined;
      });
      assert.deepEqual(
        g.map((x) => x.permission),
        ["read"],
      );
      await bob.waitBot("bob's app-shared DM", since, (t) => t.includes(slug));
      const bobView = await api(pid(bob.actor), "GET", `/v1/shares/deploy/${appId}`);
      assert.equal(bobView.status, 403, "a viewer can't manage the app's sharing");

      await alice.ask(`Remove bob's access to my app "${slug}".`);
      await waitFor("bob's app grant removed", async () =>
        granteeOf(await sharesOf(pid(alice.actor), "deploy", appId), pid(bob.actor)).length === 0 ? true : undefined,
      );
    },
  },
  {
    name: "share-file-recipient-can-read-it",
    lane: "dm",
    tags: ["twin", "sharing"],
    actors: ["alice", "bob", "carol"],
    timeoutMs: 12 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const alice = await dm(ctx, "alice");
      const bob = ctx.actor("bob");
      const fname = `${marker}.txt`;
      const ts = await alice.actor.client.uploadFile(alice.id, {
        filename: fname,
        bytes: new TextEncoder().encode(`notes ${marker}-CONTENT\n`),
        initialComment: `Share this file (${fname}) with bob, read-only.`,
      });
      ctx.timeline.recordPost(alice.id, ts, "alice", `[upload ${fname}] share this file with bob`, ts, "dm");
      await alice.reply(ts);
      const file = await waitFor("alice's file record", async () => {
        const r = await api(pid(alice.actor), "GET", `/v1/files?q=${encodeURIComponent(marker)}`);
        return ((r.data.owned ?? r.data.files) as Array<{ id: string; name: string }> | undefined)?.find((f) =>
          f.name.includes(marker),
        );
      });
      const g = await waitFor("bob's file grant", async () => {
        const list = granteeOf(await sharesOf(pid(alice.actor), "file", file.id), pid(bob));
        return list.length ? list : undefined;
      });
      assert.deepEqual(
        g.map((x) => x.permission),
        ["read"],
      );
      const bobRead = await api(pid(bob), "GET", `/v1/files/${file.id}/content`);
      assert.equal(bobRead.status, 200, `bob reads the file: ${bobRead.text.slice(0, 200)}`);
      assert.ok(bobRead.text.includes(`${marker}-CONTENT`));
      const carolRead = await api(pid(ctx.actor("carol")), "GET", `/v1/files/${file.id}/content`);
      assert.notEqual(carolRead.status, 200, "carol can't read an unshared file");
    },
  },
  {
    name: "share-cron-fork-and-linked-edits",
    lane: "dm",
    tags: ["twin", "sharing"],
    actors: ["alice", "bob", "carol"],
    timeoutMs: 18 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const alice = await dm(ctx, "alice");
      const bob = await dm(ctx, "bob");
      const { source } = await createAndShare(ctx, alice, marker, "Then share that cron with bob and with carol.");
      const bobCopy = await waitFor("bob's copy", () => copyOf(pid(bob.actor), source.id));
      const carolCopy = await waitFor("carol's copy", () => copyOf(pid(ctx.actor("carol")), source.id));
      await bob.ask(`Turn on the cron "${marker}" alice shared with me.`);
      await waitFor("bob's copy on", async () =>
        (await copyOf(pid(bob.actor), source.id))?.enabled ? true : undefined,
      );
      await bob.ask(
        `Edit my cron ${bobCopy.id} so its task is: reply with exactly "${marker}-bob" and nothing else. Keep it on.`,
      );
      const forked = await waitFor("bob's copy to fork", async () => {
        const c = (await cronsOf(pid(bob.actor))).find((x) => x.id === bobCopy.id);
        return c?.forkedAt ? c : undefined;
      });
      assert.ok((forked.action ?? forked.message ?? "").includes(`${marker}-bob`));

      await alice.ask(`Edit my cron ${source.id} so its task is: reply with exactly "${marker}-v2" and nothing else.`);
      await waitFor("source edit", async () =>
        ((await cronsOf(pid(alice.actor))).find((c) => c.id === source.id)?.action ?? "").includes(`${marker}-v2`)
          ? true
          : undefined,
      );
      const carolNow = await waitFor("carol's linked copy to follow", async () => {
        const c = (await cronsOf(pid(ctx.actor("carol")))).find((x) => x.id === carolCopy.id);
        return (c?.action ?? "").includes(`${marker}-v2`) ? c : undefined;
      });
      assert.equal(carolNow.forkedAt, undefined);
      const bobNow = (await cronsOf(pid(bob.actor))).find((x) => x.id === bobCopy.id)!;
      assert.ok((bobNow.action ?? "").includes(`${marker}-bob`), "a forked copy keeps its own edit");
      assert.ok(!(bobNow.action ?? "").includes(`${marker}-v2`), "the owner's edit skips a forked copy");
      const statuses = await sharesOf(pid(alice.actor), "cron", source.id);
      assert.deepEqual(
        granteeOf(statuses, pid(bob.actor)).map((g) => g.status),
        ["edited"],
      );
      assert.deepEqual(
        granteeOf(statuses, pid(ctx.actor("carol"))).map((g) => g.status),
        ["paused"],
      );
    },
  },
  {
    name: "share-cron-into-channel-member-only",
    lane: "dm",
    tags: ["twin", "sharing"],
    actors: ["alice", "bob"],
    timeoutMs: 12 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const alice = await dm(ctx, "alice");
      const mine = await ctx.freshChannel();
      const other = await ctx.env.qa.createChannel(`${mine.name}-x`.slice(0, 75), true);
      ctx.createdChannels.push({ id: other });
      await ctx.env.qa.invite(other, ctx.env.botUserId);
      await ctx.env.qa.invite(other, ctx.actor("bob").userId);
      const { source } = await createAndShare(
        ctx,
        alice,
        marker,
        `Then share that cron into the channel with scope channel:${mine.id} (read).`,
      );
      const g = await waitFor("channel grant", async () => {
        const list = (await sharesOf(pid(alice.actor), "cron", source.id)).filter((x) => x.scope.includes(mine.id));
        return list.length ? list : undefined;
      });
      assert.deepEqual(
        g.map((x) => x.permission),
        ["read"],
      );
      assert.equal(g[0]!.status, undefined, "a channel share is a grant, not a copy");
      const direct = await api(pid(alice.actor), "POST", `/v1/shares/cron/${source.id}`, {
        scope: `channel:${other}`,
      });
      assert.equal(
        direct.status,
        403,
        `sharing into a private channel she isn't in is refused: ${direct.text.slice(0, 200)}`,
      );
      const reply = await alice.ask(`Also share cron "${marker}" into scope channel:${other}.`);
      await ctx.judge(
        "Does the reply say the share into that channel was refused / not possible (e.g. because the person isn't a member), rather than claiming it succeeded?",
        reply.text ?? "",
      );
      const after = (await sharesOf(pid(alice.actor), "cron", source.id)).filter((x) => x.scope.includes(other));
      assert.equal(after.length, 0);
    },
  },
  {
    name: "share-cron-admin-share-starts-on",
    lane: "dm",
    tags: ["twin", "sharing"],
    actors: ["carol", "bob"],
    timeoutMs: 12 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const carol = await dm(ctx, "carol");
      const bob = await dm(ctx, "bob");
      const grant = await api(
        ADMIN(),
        "POST",
        "/v1/admin/grants",
        { principalId: pid(carol.actor), role: "org_admin", scopeId: `org:${ORG()}` },
        true,
      );
      assert.equal(grant.status < 300, true, `make carol admin: ${grant.text.slice(0, 200)}`);
      try {
        const since = nowTs();
        const { source } = await createAndShare(ctx, carol, marker, "Then share that cron with bob.");
        const copy = await waitFor("bob's copy", () => copyOf(pid(bob.actor), source.id));
        assert.equal(copy.enabled, true, "an admin's share starts on");
        await bob.waitBot("bob's started notice", since, (t) => STARTED.test(t) && t.includes(marker));
        const g = granteeOf(await sharesOf(pid(carol.actor), "cron", source.id), pid(bob.actor));
        assert.deepEqual(
          g.map((x) => x.status),
          ["on"],
        );
      } finally {
        await api(ADMIN(), "DELETE", `/v1/admin/grants/${encodeURIComponent(pid(carol.actor))}`, undefined, true);
      }
    },
  },
  {
    name: "share-cron-not-owner-refused",
    lane: "dm",
    tags: ["twin", "sharing"],
    actors: ["alice", "bob", "carol"],
    timeoutMs: 12 * 60_000,
    async run(ctx) {
      await prime(ctx);
      const marker = ctx.marker();
      const alice = await dm(ctx, "alice");
      const bob = await dm(ctx, "bob");
      const carol = await dm(ctx, "carol");
      await alice.ask(cronAsk(marker, "Don't share it."));
      const source = await waitFor("alice's cron", () => cronTitled(pid(alice.actor), marker), 30_000);
      const since = nowTs();
      const reply = await bob.ask(`Share cron ${source.id} with carol.`);
      await ctx.judge(
        "Someone asked an assistant to share a cron that belongs to a different person. Does the reply say it could not share it (e.g. not theirs / only the owner can), rather than claiming success?",
        reply.text ?? "",
      );
      const direct = await api(pid(bob.actor), "POST", `/v1/shares/cron/${source.id}`, { recipient: "carol" });
      assert.equal(direct.status, 403, `API refuses a non-owner share: ${direct.text.slice(0, 200)}`);
      assert.equal(await copyOf(pid(carol.actor), source.id), undefined, "no copy for carol");
      await sleep(5000);
      assert.equal(
        (await carol.botSince(since)).filter((m) => (m.text ?? "").includes(marker)).length,
        0,
        "carol got no offer",
      );
      const peek = await api(pid(bob.actor), "GET", `/v1/shares/cron/${source.id}`);
      assert.equal(peek.status, 403, "a non-owner can't read the access list");
    },
  },
];
