import { html, nothing } from "lit";
import type { AdminPage } from "./sections.ts";
import { badge, card, stacked, subline, table } from "./shared.ts";

export function offboardingCard(page: AdminPage, principal: string, deactivatedAtLoad: boolean, draw: () => void) {
  let [plan, hint, busy, deactivated] = [null as any, "", false, deactivatedAtLoad];
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
    deactivated ||= plan.changes.some((c: any) => c.kind === "principal" && c.result === "done");
    const failed = plan.changes.filter((c: any) => c.result === "failed").length;
    hint = failed ? `${failed} failed. Preview again to retry.` : "Done.";
    draw();
  }
  async function reactivate() {
    if (!window.confirm(`Turn sign-in back on for ${principal}? Archived items stay archived.`)) return;
    if (await send("reactivate", undefined, "Reactivating…"))
      [deactivated, plan, hint] = [false, null, "Sign-in is back on."];
    draw();
  }
  function result(c: any) {
    if (!c.result) return subline("planned");
    return c.result === "done" ? badge("done", "ok") : stacked(badge("failed", "warn"), c.error);
  }
  return () =>
    card(
      "Offboarding",
      "Turn off a departed person's sign-in and stop or archive what they own. Conversations, memory and files stay.",
      html`${
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
              ? html`<button type="button" class="btn" ?disabled=${busy} @click=${apply}>Offboard</button>`
              : html`<button type="button" class="btn" ?disabled=${busy} @click=${preview}>Preview offboarding</button>`
          }
        </div>
        <p class="hint">${hint}</p>`,
    );
}
