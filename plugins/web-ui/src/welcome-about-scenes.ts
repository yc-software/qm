import { html, nothing, type TemplateResult } from "lit";
import { ArrowUp, ArrowUpRight, ChevronDown, Clock, Copy, Layers, Paperclip, Rocket, Users } from "lucide";
import { icon } from "./icons";
import { slackMark } from "./slack-mark";
import { brandMark } from "./ui";

export const DEMO = {
  company: "Tidewater",
  people: { maya: { name: "Maya", tint: "#e4dcf3" }, dev: { name: "Dev", tint: "#d7eadd" } },
  tool: {
    channel: "fundraising",
    ask: "make me a CRM to track our fundraise",
    reply: "On it. Pulling investors from your inbox and your pipeline sheet.",
    card: { icon: "📊", title: "Seed round CRM", sub: "42 investors" },
  },
  ritual: {
    ask: "set up a daily X posting ritual sourced from our Slack",
    reply: "Done. I'll draft a post from what shipped and send it to you for a 👍 first.",
    card: { icon: "⏰", title: "Daily X post", sub: "Weekdays at 9:00 AM" },
  },
  collab: {
    ask: "Add check size and last touch.",
    reply: "Added. 9 investors are waiting on a reply.",
    columns: ["Investor", "Check", "Last touch"],
    rows: [
      ["Harbor Ventures", "$250k", "6 days"],
      ["Northline Capital", "$500k", "2 days"],
      ["Anchor Fund", "$100k", "8 days"],
    ],
    flagged: [0, 2],
    follow: "Flag anyone we have not touched in 5 days.",
    followReply: "Flagged 2. Want reply drafts for both?",
  },
  qa: {
    title: "Pre-pilot QA",
    ask: "QA signup and claims upload before Thursday's pilot.",
    runs: [
      { name: "Signup", env: "Chrome", lines: ["Open /signup", "Create account, verify email"], bug: false },
      { name: "Signup", env: "Safari", lines: ["Open /signup", "Verify email link"], bug: true },
      { name: "Claims upload", env: "Chrome", lines: ["Upload 40-claim CSV", "Totals match"], bug: false },
      { name: "Claims upload", env: "Mobile", lines: ["Photo of bill of lading", "Upload on slow network"], bug: true },
    ],
  },
  outreach: {
    title: "3PL outreach",
    ask: "Draft outreach to the 3PLs on our waitlist.",
    count: 30,
    drafts: [
      {
        to: "Sam at Bluewater Freight",
        subject: "Claims filed in minutes, not days",
        body: "Saw you moved 4,000 loads last quarter. How many turned into claims?",
      },
      {
        to: "Priya at Longhaul Logistics",
        subject: "Your carrier claims backlog",
        body: "You said on the waitlist form that claims eat two days a week.",
      },
    ],
  },
  app: {
    ask: "make me an app that tracks claims by carrier",
    title: "Claims tracker",
    host: "claims.tidewater.apps",
    chart: "Claims by carrier",
    bars: [
      ["Atlas", 88],
      ["Meridian", 61],
      ["Polar", 42],
      ["Onyx", 24],
    ] as [string, number][],
    stats: [
      ["$184k", "open"],
      ["37", "claims"],
    ],
  },
  search: {
    query: "claims manager 3pl",
    people: [
      { name: "Sam Ortiz", headline: "Claims Manager at Bluewater Freight" },
      { name: "Priya Nair", headline: "Ops at Longhaul Logistics" },
    ],
  },
};

type Who = keyof typeof DEMO.people | "qm";
type Cue = number | undefined;
const cue = (at: Cue) => at ?? nothing;
const nameOf = (who: Who) => (who === "qm" ? "QM" : DEMO.people[who].name);

function avatar(who: Who, size: number, round = false): TemplateResult {
  const shape = round ? " round" : "";
  if (who === "qm") return html`<span class="ava${shape}" style="--s:${size}px">${brandMark()}</span>`;
  const person = DEMO.people[who];
  return html`<span class="ava pale${shape}" style="--s:${size}px;background:${person.tint}">${person.name[0]}</span>`;
}

const mention = html`<span class="mention">@qm</span>`;
const dots = html`<span class="dots"><i></i><i></i><i></i></span>`;

function slackMessage(who: Who, time: string, body: TemplateResult, at?: Cue): TemplateResult {
  return html`<div class="sl-msg" data-at=${cue(at)}>
    ${avatar(who, 30)}
    <div class="sl-b">
      <div class="sl-h">
        <b>${nameOf(who)}</b>${who === "qm" ? html`<i class="sl-app">APP</i>` : nothing}<time>${time}</time>
      </div>
      ${body}
    </div>
  </div>`;
}

function slackCard(card: { icon: string; title: string; sub: string }, at: Cue, open: boolean): TemplateResult {
  return html`<div class="sl-card" data-at=${cue(at)}>
    <span class="ic">${card.icon}</span><span><b>${card.title}</b><small>${card.sub}</small></span
    >${open ? html`<span class="sl-btn">Open</span>` : nothing}
  </div>`;
}

export function slackScene(step: 0 | 1): TemplateResult {
  const live = (at: number) => (step === 0 ? at : undefined);
  const { tool, ritual } = DEMO;
  return html`<section class="sl-main">
    <div class="sl-msgs">
      ${slackMessage("maya", "9:41 AM", html`<div class="sl-t">${mention} ${tool.ask}</div>`, live(500))}
      ${slackMessage(
        "qm",
        "9:41 AM",
        html`<div class="sl-t">${tool.reply}</div>
          ${slackCard(tool.card, live(3100), true)}`,
        live(1900),
      )}
      ${
        step
          ? html`${slackMessage("dev", "9:42 AM", html`<div class="sl-t">${mention} ${ritual.ask}</div>`, 500)}
            ${slackMessage(
              "qm",
              "9:42 AM",
              html`<div class="sl-t">${ritual.reply}</div>
                ${slackCard(ritual.card, 3100, false)}`,
              1900,
            )}`
          : nothing
      }
    </div>
  </section>`;
}

export const emptySlack = html`<section class="sl-main"><div class="sl-msgs"></div></section>`;

interface WebFrame {
  title?: string;
  swap?: string;
  from?: string;
  people?: TemplateResult;
  chat?: TemplateResult;
  app?: TemplateResult;
  presence?: TemplateResult;
  typed?: { text: string; send: number };
}

export function webFrame(frame: WebFrame = {}): TemplateResult {
  const composer = frame.typed
    ? html`<span class="ph" data-out="350">Ask QM anything</span
        ><span
          class="noanim"
          data-type=${frame.typed.text}
          data-at="350"
          data-dur=${frame.typed.send - 750}
          data-out=${frame.typed.send}
        ></span
        ><span class="ph noanim" data-at=${frame.typed.send}>Ask anything</span>`
    : html`<span class="ph">Ask anything</span>`;
  return html`<section class="wb-main">
    <header class="wb-head">
      ${frame.chat ? html`<span class="rs-crumb">${DEMO.company} /</span>` : nothing}
      <b data-swap=${frame.swap ?? nothing}>${frame.title ?? "New chat"}</b>
      ${frame.from ? html`<span class="from">${slackMark(10)} from #${frame.from}</span>` : nothing}<span class="people"
        >${frame.people ?? nothing}</span
      ><span class="rs-icons">${icon(Clock, 11)}${icon(Rocket, 11)}${icon(Layers, 11)}</span>
    </header>
    <div class="wb-body">
      <div class="wb-chatcol">
        ${
          frame.chat
            ? html`<div class="wb-chat">${frame.chat}</div>`
            : html`<div class="wb-idle real"><b>Ahoy, what are we after?</b></div>`
        }
        <div class="wb-presence">${frame.presence ?? nothing}</div>
        <div class="wb-comp">
          <span class="txt">${composer}</span><span class="clip">${icon(Paperclip, 12)}</span
          ><span class="model">Fable 5.2 <i>Low</i> ${icon(ChevronDown, 9)}</span
          ><span class="send">${icon(ArrowUp, 12)}</span>
        </div>
      </div>
      ${frame.app ?? nothing}
    </div>
  </section>`;
}

function userTurn(who: Who, text: string, at: number, named = false): TemplateResult {
  return html`<div class="wb-user" data-at=${at}>
    ${named ? html`<span class="who">${avatar(who, 15, true)} ${nameOf(who)}</span>` : nothing}
    <div class="bubble">${text}</div>
  </div>`;
}

const reply = (body: TemplateResult | string, at: number) => html`<div class="wb-qm" data-at=${at}>${body}</div>`;

function collabScene(): TemplateResult {
  const { collab, tool } = DEMO;
  return webFrame({
    title: tool.card.title,
    from: tool.channel,
    people: html`<span class="joined noanim" data-at="2300" data-out="4000">${nameOf("dev")} joined</span>${avatar(
        "maya",
        20,
        true,
      )}<span data-at="2300">${avatar("dev", 20, true)}</span>`,
    presence: html`<span class="noanim" data-at="2700" data-out="3600">${nameOf("dev")} is typing${dots}</span>`,
    chat: html`${userTurn("maya", collab.ask, 250, true)}
    ${reply(
      html`${collab.reply}
        <div class="mini-table">
          <div class="tr">${collab.columns.map((column) => html`<span>${column}</span>`)}</div>
          ${collab.rows.map((row, i) => {
            const flag = collab.flagged.indexOf(i);
            return html`<div class="tr" data-cls=${flag < 0 ? nothing : `flag@${4600 + flag * 150}`}>
              ${row.map((cell) => html`<span>${cell}</span>`)}
            </div>`;
          })}
        </div>`,
      1100,
    )}
    ${userTurn("dev", collab.follow, 3600, true)} ${reply(collab.followReply, 4600)}`,
  });
}

function qaScene(): TemplateResult {
  const { runs } = DEMO.qa;
  const bugs = runs.filter((run) => run.bug).length;
  const summary = `${runs.length} runs, ${
    bugs ? `${bugs} bug${bugs > 1 ? "s" : ""}. ${bugs > 1 ? "Both" : "It's"} filed with repro steps.` : "all clean."
  }`;
  return webFrame({
    title: DEMO.qa.title,
    people: avatar("maya", 20, true),
    chat: html`${userTurn("maya", DEMO.qa.ask, 250)} ${reply(`Starting a swarm of ${runs.length} agents.`, 1000)}
      <div class="sw" data-at="1500">
        <div class="sw-strip">
          ${icon(Users, 12)}<span>Swarm · <em data-swap=${`4900:${runs.length} done`}>${runs.length} running</em></span
          >${icon(ChevronDown, 11)}
        </div>
        <div class="sw-panel">
          ${runs.map((run, i) => {
            const doneAt = [3700, 4500, 4100, 4900][i]!;
            return html`<div
              class="sw-row"
              data-at=${1650 + i * 150}
              data-cls=${`${run.bug ? "bug" : "done"}@${doneAt}`}
            >
              <b>${run.name} · ${run.env}</b><span data-swap=${`${doneAt}:${run.lines[1]}`}>${run.lines[0]}</span
              ><em data-swap=${`${doneAt}:${run.bug ? "1 bug" : "Done"}`}>Running</em>
            </div>`;
          })}
        </div>
      </div>
      ${reply(summary, 5200)}`,
  });
}

function outreachScene(): TemplateResult {
  const { outreach } = DEMO;
  return webFrame({
    title: outreach.title,
    people: avatar("maya", 20, true),
    chat: html`${userTurn("maya", outreach.ask, 250)}
    ${reply(
      html`${outreach.count} drafts, written the way you write.
        <div class="drafts">
          ${outreach.drafts.map(
            (draft, i) =>
              html`<div class="qdraft" data-at=${1600 + i * 300}>
                <div class="qdraft-h"><span>Draft</span>${icon(Copy, 11)}</div>
                <div class="qdraft-b">${`To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`}</div>
              </div>`,
          )}
        </div>
        <div data-at="2800">Say the word and I'll send all ${outreach.count} from your Gmail.</div>`,
      1100,
    )}`,
  });
}

function appScene(): TemplateResult {
  const { app } = DEMO;
  return webFrame({
    swap: `2000:${app.title}`,
    people: avatar("maya", 20, true),
    typed: { text: app.ask, send: 2000 },
    chat: html`${userTurn("maya", app.ask, 2000)}
    ${reply(
      html`<span class="wb-work" data-out="4700"><i class="spin"></i> Building it on my computer</span
        ><span data-at="4700"
          >Live, and shared with ${nameOf("dev")}.<span class="link-pill"
            >${app.host} ${icon(ArrowUpRight, 11)}</span
          ></span
        >`,
      2600,
    )}`,
    app: html`<div class="wb-app" data-cls="open@3400">
      <div class="wb-app-in">
        <div class="app-url"><i></i>${app.host}</div>
        <div class="app-card">
          <b>${app.chart}</b>
          <div class="bars">
            ${app.bars.map(
              ([name, height], i) => html`<div><i style="--h:${height}%;--dl:${300 + i * 90}ms"></i>${name}</div>`,
            )}
          </div>
          <div class="app-stats">${app.stats.map(([value, label]) => html`<div><b>${value}</b>${label}</div>`)}</div>
        </div>
      </div>
    </div>`,
  });
}

export const SCENES: { side: "slack" | "web"; duration: number; render: () => TemplateResult }[] = [
  { side: "slack", duration: 5200, render: () => slackScene(0) },
  { side: "slack", duration: 5600, render: () => slackScene(1) },
  { side: "web", duration: 6300, render: collabScene },
  { side: "web", duration: 6500, render: qaScene },
  { side: "web", duration: 5600, render: outreachScene },
  { side: "web", duration: 6600, render: appScene },
];
