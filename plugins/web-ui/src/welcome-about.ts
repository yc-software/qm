import { LitElement, html, nothing, render, type TemplateResult } from "lit";
import { animateSwarm, aboutTiles } from "./welcome-about-tiles";
import { SCENES, emptySlack, slackScene, webFrame } from "./welcome-about-scenes";
import "./welcome-about.css";

const SPEED = 0.55;
const cues = (root: Element, name: string) => [...root.querySelectorAll<HTMLElement>(`[data-${name}]`)];
const classCues = (el: HTMLElement) => el.dataset.cls!.split(",").map((pair) => pair.split("@") as [string, string]);
const swapCue = (el: HTMLElement): [number, string] => {
  const value = el.dataset.swap!;
  const split = value.indexOf(":");
  return [Number(value.slice(0, split)), value.slice(split + 1)];
};
const paneOf = (el: Element) => el.closest<HTMLElement>(".wb-chat, .sl-msgs");

function play(root: Element): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const at = (ms: number, run: () => void) => timers.push(setTimeout(run, ms * SPEED));
  const type = (el: HTMLElement) => {
    const full = el.dataset.type!;
    const duration = Number(el.dataset.dur) * SPEED;
    el.classList.add("typing-caret");
    for (let i = 1; i <= full.length; i++)
      timers.push(
        setTimeout(
          () => {
            el.textContent = full.slice(0, i);
            el.classList.toggle("typing-caret", i < full.length);
          },
          (duration * i) / full.length,
        ),
      );
  };
  for (const el of cues(root, "at"))
    at(Number(el.dataset.at), () => {
      el.classList.add("in");
      if (el.dataset.type) type(el);
      const pane = paneOf(el);
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  for (const el of cues(root, "out")) at(Number(el.dataset.out), () => el.classList.add("gone"));
  for (const el of cues(root, "cls"))
    for (const [name, ms] of classCues(el)) at(Number(ms), () => el.classList.add(name));
  for (const el of cues(root, "swap")) {
    const [ms, text] = swapCue(el);
    at(ms, () => (el.textContent = text));
  }
  return () => timers.forEach(clearTimeout);
}

function settle(root: Element): void {
  for (const el of cues(root, "at")) {
    el.classList.add("in", "noanim");
    if (el.dataset.type) el.textContent = el.dataset.type;
  }
  for (const el of cues(root, "out")) el.classList.add("gone");
  for (const el of cues(root, "cls")) for (const [name] of classCues(el)) el.classList.add(name);
  for (const el of cues(root, "swap")) el.textContent = swapCue(el)[1];
}

function show(box: Element, scene: TemplateResult): void {
  render(nothing, box as HTMLElement);
  render(scene, box as HTMLElement);
}

export class WelcomeAbout extends LitElement {
  static properties = { onBack: { attribute: false } };
  declare onBack: (() => void) | undefined;
  private stop = () => {};
  private next?: ReturnType<typeof setTimeout>;

  protected createRenderRoot(): HTMLElement {
    return this;
  }
  protected firstUpdated(): void {
    const root = this.querySelector<HTMLElement>(".welcome-about")!;
    const box = { slack: root.querySelector(".dwin.slack")!, web: root.querySelector(".dwin.web")! };
    const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches !== false;
    const go = (i: number) => {
      const scene = SCENES[i]!;
      this.stop();
      root.dataset.focus = scene.side;
      if (scene.side === "web") {
        show(box.slack, slackScene(1));
        settle(box.slack);
      }
      show(box[scene.side], scene.render());
      if (still) settle(box[scene.side]);
      else this.stop = play(box[scene.side]);
      const last = i + 1 === SCENES.length;
      if (still || last)
        this.next = setTimeout(() => (root.dataset.focus = "both"), still ? 0 : scene.duration * SPEED);
      else this.next = setTimeout(() => go(i + 1), scene.duration * SPEED);
    };
    show(box.web, webFrame());
    show(box.slack, emptySlack);
    if (still) return go(SCENES.length - 1);
    animateSwarm(root);
    this.next = setTimeout(() => go(0), 600);
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stop();
    clearTimeout(this.next);
  }
  protected render() {
    return html`<section class="welcome-about" data-focus="slack">
      <div class="W-text welcome-beat" style="--welcome-delay:0ms">
        <p class="welcome-what"><button type="button" @click=${() => this.onBack?.()}>← Back to welcome</button></p>
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
