export interface SkillEditReview {
  description: string;
  body: string;
}

export interface SkillCreateReview extends SkillEditReview {
  name: string;
  scopeId: string;
}

export function reviewMatches(review: SkillEditReview | null, description: string, body: string): boolean {
  return review?.description === description && review.body === body;
}

export function createReviewMatches(
  review: SkillCreateReview | null,
  name: string,
  description: string,
  body: string,
  scopeId: string,
): boolean {
  return (
    review?.name === name && review.description === description && review.body === body && review.scopeId === scopeId
  );
}

export function isSharedSkillScope(scopeId?: string): boolean {
  return Boolean(scopeId && !scopeId.startsWith("personal:"));
}

export function shouldBlockRepeatedPublishClick(reviewed: boolean, clickCount: number): boolean {
  return reviewed && clickCount > 1;
}
