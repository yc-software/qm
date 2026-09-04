export class SkillsMutationSequence {
  private latest = 0;

  begin(): number {
    return ++this.latest;
  }

  invalidate(): void {
    this.latest += 1;
  }

  isCurrent(operation: number): boolean {
    return operation === this.latest;
  }
}
