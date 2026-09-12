import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./support/auto-fake-sprites.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { mentionsOtherMember } from "../src/core/orchestrator/human-mention.ts";
import type { Principal } from "../src/types.ts";

const p = (id: string, displayName: string): Principal => ({ id, displayName, type: "internal" });
const audience: Principal[] = [
  p("zhangsan@example.com", "张三"),
  p("lisi@example.com", "李四"),
  p("wangwu@example.com", "王五"),
];

describe("mentionsOtherMember", () => {
  it("detects a full-name mention mid-sentence without spaces", () => {
    assert.equal(mentionsOtherMember("帮我看下@李四这个方案", audience, "zhangsan@example.com", "QM"), true);
  });

  it("treats an ambiguous single-char surname prefix as not human-directed", () => {
    assert.equal(mentionsOtherMember("@李 你看下", audience, "zhangsan@example.com", "QM"), false);
    assert.equal(mentionsOtherMember("@李四的方案 我看看", audience, "zhangsan@example.com", "QM"), true);
  });

  it("ignores a self-mention", () => {
    assert.equal(mentionsOtherMember("@张三 记一下", audience, "zhangsan@example.com", "QM"), false);
  });

  it("ignores unknown tokens and emails", () => {
    assert.equal(mentionsOtherMember("发给 a@b.com 了", audience, "zhangsan@example.com", "QM"), false);
    assert.equal(mentionsOtherMember("@赵六 在吗", audience, "zhangsan@example.com", "QM"), false);
  });

  it("ignores text without any at-sign", () => {
    assert.equal(mentionsOtherMember("李四 看一下", audience, "zhangsan@example.com", "QM"), false);
  });

  it("returns false when the audience has no other named members", () => {
    assert.equal(mentionsOtherMember("@李四 看", [p("x", "张三")], "x", "QM"), false);
  });

  it("does not treat a message naming the bot as human-directed", () => {
    assert.equal(mentionsOtherMember("@李四 和 QM 一起看看", audience, "zhangsan@example.com", "QM"), false);
  });

  it("does not match a longer ascii word that merely starts with a member name", () => {
    const asciiAudience = [
      p("sam@example.com", "Sam"),
      p("al@example.com", "Al"),
      p("ann@example.com", "Ann"),
    ];
    assert.equal(
      mentionsOtherMember("@sample the new endpoint and post the results", asciiAudience, "x@example.com", "QM"),
      false,
    );
    assert.equal(mentionsOtherMember("@all hands", asciiAudience, "x@example.com", "QM"), false);
    assert.equal(mentionsOtherMember("@announce it", asciiAudience, "x@example.com", "QM"), false);
  });

  it("still matches a name extended by CJK suffixes", () => {
    const mixed = [p("amy@example.com", "Amy"), ...audience];
    assert.equal(mentionsOtherMember("@amy看看这个", mixed, "zhangsan@example.com", "QM"), true);
  });
});

describe("web group human-directed turns", () => {
  function freshApp() {
    return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "hm-")) }));
  }

  async function projectFixture(
    ownerId: string,
    ownerName: string,
    memberId: string,
    memberName: string,
  ): Promise<{ app: ReturnType<typeof buildApp>["app"]; groupRef: string }> {
    const built = freshApp();
    await built.app.upsertDirectory([
      { principalId: ownerId, displayName: ownerName, type: "internal" },
      { principalId: memberId, displayName: memberName, type: "internal" },
    ]);
    const project = await built.projects.create({ name: "Launch", ownerId });
    await built.projects.addMember(project.id, ownerId, memberId);
    return { app: built.app, groupRef: `web-project-${project.id}` };
  }

  function groupTurn(
    actor: { externalId: string; displayName?: string },
    groupRef: string,
    text: string,
    extra: Partial<TurnRequest> = {},
  ): TurnRequest {
    return {
      surface: "web",
      actor,
      origin: { kind: "human" },
      conversation: { kind: "group", channelRef: groupRef, threadRef: `${groupRef}:t1`, audience: [actor] },
      text,
      ...extra,
    };
  }

  it("appends the typed message and stays silent", async () => {
    const { app, groupRef } = await projectFixture("U1", "张三", "U2", "李四");
    const res = await app.turn(groupTurn({ externalId: "U1" }, groupRef, "@李四 看下这个方案"));
    assert.equal(res.status, "silent", res.reason);
    const found = await app.getSession(res.sessionId!);
    assert.deepEqual(found!.entries.map((e) => e.type), ["user"]);
    assert.equal((found!.entries[0]!.payload as { text: string }).text, "@李四 看下这个方案");
  });

  it("matches the typed message, not spine-envelope metadata that happens to contain the bot label", async () => {
    const { app, groupRef } = await projectFixture("qiming@acme.com", "Qiming", "U2", "李四");
    const res = await app.turn(
      groupTurn({ externalId: "qiming@acme.com" }, groupRef, "@李四 看下这个方案"),
    );
    assert.equal(res.status, "silent", "a sender whose id contains the bot label must not be vetoed");
  });

  it("a mention carrying attachments still reaches the model", async () => {
    const { app, groupRef } = await projectFixture("U1", "张三", "U2", "李四");
    const res = await app.turn(
      groupTurn({ externalId: "U1" }, groupRef, "@李四 看这张图", {
        attachments: [{ name: "shot.png", mimetype: "image/png", sizeBytes: 3, blobId: "b1" }],
      }),
    );
    assert.notEqual(res.status, "silent");
  });

  it("slack-originated group mentions still reach the model", async () => {
    const { app, groupRef } = await projectFixture("U1", "张三", "U2", "李四");
    const res = await app.turn({
      ...groupTurn({ externalId: "U1" }, groupRef, "@李四 看下这个方案"),
      surface: "slack",
    });
    assert.equal(res.status, "ok");
  });
});
