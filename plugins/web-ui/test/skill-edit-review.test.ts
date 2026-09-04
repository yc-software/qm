import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReviewMatches,
  isSharedSkillScope,
  reviewMatches,
  shouldBlockRepeatedPublishClick,
} from "../src/skill-edit-review.ts";

test("a shared edit review applies only to the exact reviewed draft", () => {
  const review = { description: "Summarize incidents", body: "Read the timeline." };
  assert.equal(reviewMatches(review, review.description, review.body), true);
  assert.equal(reviewMatches(review, review.description, `${review.body} Then notify the team.`), false);
  assert.equal(reviewMatches(null, review.description, review.body), false);
});

test("only non-personal skill homes require shared-audience review", () => {
  assert.equal(isSharedSkillScope("personal:U1"), false);
  assert.equal(isSharedSkillScope("channel:C1"), true);
  assert.equal(isSharedSkillScope("group:G1"), true);
});

test("a shared create review is invalidated by any publish-relevant change", () => {
  const review = {
    name: "incident-brief",
    description: "Summarize incidents",
    body: "Read the timeline.",
    scopeId: "channel:C1",
  };
  assert.equal(createReviewMatches(review, review.name, review.description, review.body, review.scopeId), true);
  assert.equal(createReviewMatches(review, "incident-digest", review.description, review.body, review.scopeId), false);
  assert.equal(createReviewMatches(review, review.name, `${review.description}.`, review.body, review.scopeId), false);
  assert.equal(
    createReviewMatches(review, review.name, review.description, `${review.body} Notify the team.`, review.scopeId),
    false,
  );
  assert.equal(createReviewMatches(review, review.name, review.description, review.body, "group:G1"), false);
});

test("a double-click cannot confirm a review rendered by its first click", () => {
  assert.equal(shouldBlockRepeatedPublishClick(false, 1), false);
  assert.equal(shouldBlockRepeatedPublishClick(true, 2), true);
  assert.equal(shouldBlockRepeatedPublishClick(true, 0), false);
  assert.equal(shouldBlockRepeatedPublishClick(true, 1), false);
});
