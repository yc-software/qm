import { html, svg, type TemplateResult } from "lit";
import { Check, Clock, Search, Users } from "lucide";
import { icon } from "./icons";
import { DEMO } from "./welcome-about-scenes";

interface Point {
  x: number;
  y: number;
}
interface Agent {
  size: "" | " l" | " r";
  at: Point;
  frames: Keyframe[];
}
interface Link {
  from: Point;
  to: Point;
  frames: Keyframe[];
}

const BUSY = "var(--muted-foreground)";
const DONE = "var(--success)";
const LOOP = { duration: 9000, iterations: Infinity, fill: "both" } as const;
const jitter = (seed: number) => (((Math.sin(seed * 12.9898) * 43758.5453) % 1) + 1) % 1;
const round = (value: number) => Number(value.toFixed(2));

function stop(at: number, point: Point, opacity: number, background: string, scale: number): Keyframe {
  return {
    offset: round(at) / 100,
    left: `${round(point.x)}%`,
    top: `${round(point.y)}%`,
    opacity,
    background,
    transform: `translate(-50%,-50%) scale(${scale})`,
    easing: "ease-in-out",
  };
}

function life(
  from: Point,
  to: Point,
  out: number,
  fly: number,
  done: number,
  back: number,
  gone: number,
  seed: number,
): Keyframe[] {
  const blinks: Keyframe[] = [];
  for (let at = out + fly + 1.5 + jitter(seed) * 3, k = 0; at < done - 1.5; at += 3.5, k++)
    blinks.push({ offset: round(at) / 100, opacity: k % 2 ? 1 : 0.35, easing: "ease-in-out" });
  return [
    stop(0, from, 0, BUSY, 0.4),
    stop(out, from, 0, BUSY, 0.4),
    stop(out + fly, to, 1, BUSY, 1),
    ...blinks,
    stop(done - 0.6, to, 1, BUSY, 1),
    stop(done, to, 1, DONE, 1.8),
    stop(done + 2.5, to, 1, DONE, 1),
    stop(back, to, 1, DONE, 1),
    stop(gone, from, 0, DONE, 0.6),
    stop(100, from, 0, DONE, 0.6),
  ];
}

const fade = (stops: [number, number][]): Keyframe[] => stops.map(([at, opacity]) => ({ offset: at / 100, opacity }));

function swarm(): { agents: Agent[]; links: Link[]; count: Keyframe[] } {
  const root = { x: 6, y: 50 };
  const agents: Agent[] = [];
  const links: Link[] = [];
  const finished: number[] = [];
  let id = 0;
  [7, 7, 7, 6].forEach((workers, team) => {
    const lead = { x: 21, y: 14 + team * 24 };
    const spawn = 17 + team * 1.5;
    const teamFade = fade([
      [0, 0],
      [round(spawn + 1), 0],
      [round(spawn + 8), 1],
      [85, 1],
      [89.5, 0],
      [100, 0],
    ]);
    let last = 0;
    for (let worker = 0; worker < workers; worker++) {
      id += 1;
      const at = {
        x: 35 + (worker * 60) / (workers - 1) + (jitter(id * 3.1) - 0.5) * 3,
        y: lead.y + (worker % 2 ? 6.5 : -6.5) + (jitter(id * 5.7) - 0.5) * 4,
      };
      const done = round(38 + jitter(id * 7.3) * 39);
      last = Math.max(last, done);
      finished.push(done);
      agents.push({ size: "", at, frames: life(lead, at, spawn + worker * 0.6, 5, done, 85, 89.5, id) });
      links.push({ from: lead, to: at, frames: teamFade });
    }
    const leadDone = round(last + 2);
    finished.push(leadDone);
    agents.push({
      size: " l",
      at: lead,
      frames: life(root, lead, 8 + team * 1.2, 6, leadDone, 89.5, 93.5, 100 + team),
    });
    links.push({
      from: root,
      to: lead,
      frames: fade([
        [0, 0],
        [9, 0],
        [16, 1],
        [89.5, 1],
        [93.5, 0],
        [100, 0],
      ]),
    });
  });
  const rootDone = round(Math.max(...finished) + 2.5);
  finished.push(rootDone);
  finished.sort((a, b) => a - b);
  const ink = "var(--foreground)";
  agents.push({
    size: " r",
    at: root,
    frames: [
      stop(0, root, 0, ink, 0.3),
      stop(2.5, root, 0, ink, 0.3),
      stop(6, root, 1, ink, 1),
      stop(rootDone - 0.6, root, 1, ink, 1),
      {
        ...stop(rootDone, root, 1, DONE, 1.5),
        boxShadow: "0 0 0 0 color-mix(in srgb, var(--success) 60%, transparent)",
      },
      { ...stop(rootDone + 4, root, 1, DONE, 1), boxShadow: "0 0 0 9px transparent" },
      stop(92, root, 1, DONE, 1),
      stop(94, root, 1, DONE, 1.4),
      stop(96.5, root, 1, DONE, 1),
      stop(99, root, 0, DONE, 0.4),
      stop(100, root, 0, DONE, 0.4),
    ],
  });
  const count: Keyframe[] = [
    { offset: 0, "--swn": 0, easing: "steps(1)" },
    ...finished.map((at, i) => ({ offset: at / 100, "--swn": i + 1, easing: "steps(1)" })),
    { offset: 1, "--swn": finished.length },
  ];
  return { agents, links, count };
}

const SWARM = swarm();

export function animateSwarm(root: Element): void {
  root.querySelectorAll(".swm-d").forEach((dot, i) => dot.animate(SWARM.agents[i]!.frames, LOOP));
  root.querySelectorAll(".swm-f line").forEach((line, i) => line.animate(SWARM.links[i]!.frames, LOOP));
  root.querySelector(".swt-h em")?.animate(SWARM.count, LOOP);
}

function swarmArt(): TemplateResult {
  return html`<div class="art art-sw">
    <div class="swt-h">
      ${icon(Users, 10)}<span>Swarm · ${SWARM.agents.length} agents</span><em style="--swn:${SWARM.agents.length}"></em>
    </div>
    <div class="swm-f">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${SWARM.links.map(
          ({ from, to }) => svg`<line x1=${round(from.x)} y1=${round(from.y)} x2=${round(to.x)} y2=${round(to.y)} />`,
        )}
      </svg>
      ${SWARM.agents.map(
        ({ size, at }) => html`<i class="swm-d${size}" style="left:${round(at.x)}%;top:${round(at.y)}%"></i>`,
      )}
    </div>
  </div>`;
}

function browserArt(): TemplateResult {
  const { search } = DEMO;
  return html`<div class="art art-li">
    <div class="li-top">
      <span class="li-logo">in</span><span class="li-search">${icon(Search, 9)}<em>${search.query}</em></span
      ><span class="li-me"></span>
    </div>
    <div class="li-tabs"><b>People</b><span>2nd</span><span>Locations</span><span>Current company</span></div>
    ${search.people.map(
      (person, i) =>
        html`<div class="li-row" style="animation-name:about-seq${i + 1}">
          <span class="li-ava" data-i=${i}>${person.name[0]}</span
          ><span class="li-who"
            ><b>${person.name}<small> · 2nd</small></b
            ><span>${person.headline}</span></span
          ><span class="li-btn">${i ? "Connect" : html`<u>Connect</u><u class="p">${icon(Clock, 8)} Pending</u>`}</span>
        </div>`,
    )}
    <svg class="li-cur" width="11" height="15" viewBox="0 0 12 16">
      <path d="M1 1v12l3.2-3 2 4.6 2-.9-2-4.5H10z" fill="#111" stroke="#fff" stroke-width="1" />
    </svg>
  </div>`;
}

function computerArt(): TemplateResult {
  const { outreach } = DEMO;
  return html`<div class="art art-dk">
    <div class="br-bar"><i></i><i></i><i></i><span>Mail · ${outreach.title}</span></div>
    ${outreach.drafts.map(
      (draft, i) =>
        html`<div class="dk-row" style="animation-name:about-seq${i * 2}">
          <em>${draft.to[0]}</em><span><b>${draft.to}</b>${draft.subject}</span
          ><i style="animation-name:about-seq${i * 2 + 1}">${icon(Check, 9)}</i>
        </div>`,
    )}
    <div class="dk-foot" style="animation-name:about-seq4">
      ${outreach.count} of ${outreach.count} sent, in your voice
    </div>
  </div>`;
}

const MODELS = ["Claude Fable 5.2", "GPT-6 Astra", "Kimi K3", "GLM 5.3", "Abliterated Large"];

function modelArt(): TemplateResult {
  return html`<div class="art art-md">
    <div class="md-hl">${icon(Check, 11)}</div>
    ${MODELS.map((model) => html`<div class="md-r">${model}</div>`)}
  </div>`;
}

export function aboutTiles(): TemplateResult {
  const tiles: [string, string, TemplateResult][] = [
    ["Browser use", "Like Muse or Instinct: it logs in, searches and clicks on real sites.", browserArt()],
    ["Computer use", "Has a computer of its own, and can drive yours: real apps, real sends.", computerArt()],
    ["Any model", "Pick one per task, including abliterated ones.", modelArt()],
    ["Agent swarms", "Splits a big job across many agents working in parallel, then reports back.", swarmArt()],
  ];
  return html`<div class="tiles">
    ${tiles.map(([title, text, art]) => html`<div class="tile">${art}<b>${title}</b><span>${text}</span></div>`)}
  </div>`;
}
