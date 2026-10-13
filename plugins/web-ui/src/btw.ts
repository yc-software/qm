import { html, nothing } from "lit";
import { SquareArrowOutUpRight, X } from "lucide";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  api,
  forkSession,
  runIsTerminal,
  turnRequestBody,
  type CoreSession,
  type RunPoll,
  type TurnOptions,
} from "./core-bridge";
import { markdown } from "./message-markdown";
import { icon, waveLoader } from "./ui";
import { errMessage } from "../../chassis/src/errors";
import { btwPrompt } from "./btw-command";

interface BtwCard {
  question: string;
  reply: string;
  done: boolean;
  session?: CoreSession;
}

export function createBtw(redraw: () => void, open: (session: CoreSession) => void) {
  const cards = new Map<string, BtwCard[]>();

  async function ask(sessionId: string, question: string, agent: Agent, options: () => TurnOptions): Promise<void> {
    const card: BtwCard = { question, reply: "", done: false };
    cards.set(sessionId, [...(cards.get(sessionId) ?? []), card]);
    redraw();
    try {
      card.session = (await forkSession(sessionId)).session;
      const body = turnRequestBody(card.session.threadRef, btwPrompt(question), agent.state.model, agent, options);
      const { runId } = await api<{ runId?: string }>("/api/turn", { method: "POST", body: JSON.stringify(body) });
      if (!runId) throw new Error("The side agent couldn't start.");
      for (;;) {
        const run = await api<RunPoll>(`/api/runs/${encodeURIComponent(runId)}`);
        card.reply = run.result?.reply || run.partial || run.result?.reason || "";
        if (runIsTerminal(run)) break;
        redraw();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (err) {
      card.reply = errMessage(err, "The side agent couldn't answer.");
    }
    card.done = true;
    redraw();
  }

  function dismiss(sessionId: string, card: BtwCard): void {
    cards.set(
      sessionId,
      (cards.get(sessionId) ?? []).filter((c) => c !== card),
    );
    redraw();
  }

  function view(sessionId: string | null) {
    if (!sessionId) return nothing;
    return (cards.get(sessionId) ?? []).map(
      (card) =>
        html`<section class="bg-activity btw-card ${card.done ? "done" : ""}">
          <header>
            <b>btw</b><span>${card.question}</span>
            ${card.done ? nothing : waveLoader({ width: 13, height: 13, label: "Side agent answering" })}
            ${card.session ? html`<button type="button" title="Open the side chat" @click=${() => open(card.session!)}>${icon(SquareArrowOutUpRight, 13)}</button>` : nothing}
            <button type="button" title="Dismiss" @click=${() => dismiss(sessionId, card)}>${icon(X, 13)}</button>
          </header>
          <div class="btw-body">${card.reply ? markdown(card.reply, !card.done) : "Thinking…"}</div>
        </section>`,
    );
  }

  return { ask, view };
}
