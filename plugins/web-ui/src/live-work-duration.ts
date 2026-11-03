import { html } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { workPausedForApproval, type WorkBlock } from "./core-bridge.ts";
import { currentTextPhase } from "./timeline.ts";
import { workDurationParts, workSeconds } from "./work-duration.ts";

class LiveWorkDuration extends AsyncDirective {
  private timer: ReturnType<typeof setInterval> | undefined;
  private work!: WorkBlock;
  private seconds = 0;
  private sampledAt = 0;
  private ticking = false;

  render(work: WorkBlock) {
    this.work = work;
    this.seconds = workSeconds(work);
    this.sampledAt = Date.now();
    this.ticking =
      this.isConnected &&
      (work.status === "working" || work.status === "thinking") &&
      !work.stale &&
      !workPausedForApproval(work) &&
      currentTextPhase(work)?.phase !== "final_answer";
    if (this.ticking && !this.timer) this.timer = setInterval(() => this.setValue(this.label()), 50);
    else if (!this.ticking) this.disconnected();
    return this.label();
  }

  private label() {
    const { lead, seconds } = workDurationParts(
      this.seconds + (this.ticking ? (Date.now() - this.sampledAt) / 1000 : 0),
    );
    return html`${lead}<span class="work-elapsed-seconds">${seconds}</span>s`;
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
