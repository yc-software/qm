import { LitElement, html, nothing, render, type TemplateResult } from "lit";
import { animateSwarm, aboutTiles } from "./welcome-about-tiles";
import { SCENES, emptySlack, slackScene, webFrame } from "./welcome-about-scenes";
import "./welcome-about.css";

const SPEED = 0.55;

function show(box: Element, scene: TemplateResult): void {
  render(nothing, box as HTMLElement);
  render(scene, box as HTMLElement);
}

export class WelcomeAbout extends LitElement {
  static properties = { onBack: { attribute: false } };
  declare onBack: (() => void) | undefined;
  private next?: ReturnType<typeof setTimeout>;

  protected createRenderRoot(): HTMLElement {
    return this;
  }
  protected firstUpdated(): void {
    const root = this.querySelector<HTMLElement>(".welcome-about")!;
    const box = { slack: root.querySelector(".dwin.slack")!, web: root.querySelector(".dwin.web")! };
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches !== false) {
      show(box.slack, slackScene(1));
      show(box.web, SCENES.at(-1)!.render());
      root.dataset.focus = "both";
      return;
    }
    const go = (i: number) => {
      const scene = SCENES[i]!;
      root.dataset.focus = scene.side;
      if (scene.side === "web") {
        box.slack.classList.add("settled");
        show(box.slack, slackScene(1));
      }
      show(box[scene.side], scene.render());
      const last = i + 1 === SCENES.length;
      this.next = setTimeout(() => (last ? (root.dataset.focus = "both") : go(i + 1)), scene.duration * SPEED);
    };
    show(box.web, webFrame());
    show(box.slack, emptySlack);
    animateSwarm(root);
    this.next = setTimeout(() => go(0), 600);
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.next);
  }
  protected render() {
    return html`<section class="welcome-about" data-focus="slack" style="--about-speed:${SPEED}ms">
      <div class="W-text welcome-beat" style="--welcome-delay:0ms">
        <p class="welcome-what">
          <button type="button" class="welcome-more-ideas" @click=${() => this.onBack?.()}>← Back to welcome</button>
        </p>
        <h1>What is this?</h1>
        <p class="W-lead">
          You are probably familiar with Codex, Claude Cowork, Claude Tag, Grok Bot, and others.<br /><a
            href="https://github.com/yc-software/qm"
            target="_blank"
            rel="noopener"
            >QM</a
          >
          is our open-source version. It has most of the same features, but is also wired into YC systems, with context
          on your company. It allows us to use any model provider with minimal guardrails, and we suspect this will be
          useful to you as well.
        </p>
      </div>
      <div class="W-figs welcome-beat" style="--welcome-delay:120ms">
        <figure>
          <div class="dwin slack"></div>
          <figcaption>A virtual employee in Slack</figcaption>
        </figure>
        <figure>
          <div class="dwin web"></div>
          <figcaption>Multiplayer work on web, desktop and iOS</figcaption>
        </figure>
      </div>
      <div class="welcome-beat" style="--welcome-delay:240ms">${aboutTiles()}</div>
    </section>`;
  }
}
if (!customElements.get("qm-welcome-about")) customElements.define("qm-welcome-about", WelcomeAbout);
