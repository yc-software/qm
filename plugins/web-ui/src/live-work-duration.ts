import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { workPausedForApproval, type WorkBlock } from "./core-bridge.ts";
import { currentTextPhase } from "./timeline.ts";
import { workDuration, workSeconds } from "./work-duration.ts";

class LiveWorkDuration extends AsyncDirective {
  private timer: ReturnType<typeof setInterval> | undefined;
  private work!: WorkBlock;

  render(work: WorkBlock) {
    this.work = work;
    const ticking =
      this.isConnected &&
      (work.status === "working" || work.status === "thinking") &&
      !work.stale &&
      !workPausedForApproval(work) &&
      currentTextPhase(work)?.phase !== "final_answer";
    if (ticking && !this.timer) this.timer = setInterval(() => this.setValue(this.label()), 50);
    else if (!ticking) this.disconnected();
    return this.label();
  }

  private label() {
    return workDuration(workSeconds(this.work));
  }

  protected disconnected() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  protected reconnected() {
    this.setValue(this.render(this.work));
  }
}

export const liveWorkDuration = directive(LiveWorkDuration);
