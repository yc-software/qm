import { html, nothing } from "lit";
import type { AdminPage } from "./sections.ts";
import { formatMessageTime } from "../message-time.ts";
import { badge, card, stacked, subline, table } from "./shared.ts";

export function offboardingCard(
  page: AdminPage,
  principal: string,
  deactivatedAtLoad: boolean,
  recordAtLoad: any,
  draw: () => void,
) {
  let [plan, hint, busy, deactivated, record] = [null as any, "", false, deactivatedAtLoad, recordAtLoad];
  const path = (action: string) => "/api/users/" + encodeURIComponent(principal) + "/" + action;
  async function send(action: string, body: unknown, label: string) {
    [busy, hint] = [true, label];
    draw();
    const r = await page.api("POST", path(action), body);
    busy = false;
    hint = r.ok ? "" : r.data?.message || "Failed (" + r.status + ").";
    draw();
    return r.ok ? r.data : null;
  }
  async function preview() {
    plan = await send("offboard", {}, "Checking what this person owns…");
    draw();
  }
  async function apply() {
    const count = plan?.changes?.length ?? 0;
    if (
      !window.confirm(
        `Offboard ${principal}? This applies the ${count} changes listed. Retired computers lose their disks.`,
      )
    )
      return;
    plan = await send("offboard", { apply: true }, "Offboarding…");
    if (!plan) return;
    record = plan.user ?? record;
    deactivated ||= plan.changes.some((c: any) => c.kind === "principal" && c.result === "done");
    const failed = plan.changes.filter((c: any) => c.result === "failed").length;
    hint = failed ? `${failed} failed. Preview again to retry.` : "Done.";
    draw();
  }
  async function reactivate() {
    if (!window.confirm(`Turn sign-in back on for ${principal}? Archived items stay archived.`)) return;
    const done = await send("reactivate", undefined, "Reactivating…");
    if (done) [deactivated, plan, hint, record] = [false, null, "Sign-in is back on.", done.user ?? null];
    draw();
  }
  function result(c: any) {
    if (!c.result) return subline("planned");
    return c.result === "done" ? badge("done", "ok") : stacked(badge("failed", "warn"), c.error);
  }
  const when = (at: number, by?: string) => formatMessageTime(at) + (by ? " by " + by : "");
  const history = () =>
    record?.offboardedAt
      ? html`<p class="obstatus">
          ${badge("offboarded", "warn")} ${subline("Offboarded " + when(record.offboardedAt, record.offboardedBy))}
        </p>`
      : nothing;
  return () =>
    card(
      "Offboarding",
      "Turn off a departed person's sign-in and stop or archive what they own. Conversations, memory and files stay.",
      html`${history()}
        ${
          deactivated
            ? html`<p class="obstatus">
                Sign-in: ${badge("deactivated", "warn")}
                <button type="button" class="link" ?disabled=${busy} @click=${reactivate}>Reactivate</button>
              </p>`
            : nothing
        }
        ${
          plan
            ? table(
                ["Change", "Item", "Result"],
                plan.changes.map((c: any) => [
                  { node: stacked(c.action.replaceAll("_", " "), c.kind) },
                  { node: stacked(c.label, c.id), cls: "mono" },
                  { node: result(c) },
                ]),
                "Nothing to change.",
              )
            : nothing
        }
        <div class="obactions">
          ${
            plan && !plan.applied && plan.changes.length
              ? html`<button type="button" class="btn danger" ?disabled=${busy} @click=${apply}>Offboard</button>`
              : html`<button type="button" class="btn" ?disabled=${busy} @click=${preview}>Preview offboarding</button>`
          }
        </div>
        <p class="hint">${hint}</p>`,
    );
}
