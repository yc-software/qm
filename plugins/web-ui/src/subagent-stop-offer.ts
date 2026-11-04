import { html, nothing, type TemplateResult } from "lit";
import { Square } from "lucide";
import { ApiError, stopRunTree } from "./core-bridge.ts";
import { icon } from "./icons.ts";

interface Offer {
  sessionId: string;
  runId: string;
  generation: number;
  pending: boolean;
}

export function createSubagentStopOffer(redraw: () => void, onError: (message: string) => void) {
  let offer: Offer | null = null;

  async function stopAll(current: Offer): Promise<void> {
    current.pending = true;
    redraw();
    try {
      await stopRunTree(current.runId);
      if (offer === current) offer = null;
    } catch (error) {
      if (offer !== current) return;
      if (error instanceof ApiError && error.status === 409) offer = null;
      else {
        current.pending = false;
        onError("Could not stop the subagents. Try again.");
      }
    } finally {
      redraw();
    }
  }

  return {
    offer(sessionId: string | null, runId: string | null, generation: number, working: number): void {
      offer = sessionId && runId && working > 0 ? { sessionId, runId, generation, pending: false } : null;
    },
    view(sessionId: string, generation: number, working: number): TemplateResult | typeof nothing {
      if (offer && (offer.sessionId !== sessionId || offer.generation !== generation || working === 0)) offer = null;
      const current = offer;
      if (!current) return nothing;
      const label = current.pending ? "Stopping subagents…" : `Stop ${working} subagent${working === 1 ? "" : "s"} too`;
      return html`<button
        type="button"
        class="subagent-row-action subagent-stop-all"
        ?disabled=${current.pending}
        @click=${() => void stopAll(current)}
      >
        ${icon(Square, 11)}<span>${label}</span>
      </button>`;
    },
  };
}
