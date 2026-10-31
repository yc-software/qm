import { html, nothing } from "lit";
import { badge, card, muted, stacked, table } from "./shared.ts";

const COLS = ["16%", "30%", "22%", "32%"];
const NOUN: Record<string, string> = {
  principal: "sign-in",
  deployment: "app",
  sandbox: "computer",
  keychain: "keychain grant",
  admin_grant: "admin grant",
};
const noun = (kind: string) => NOUN[kind] ?? kind;

export function offboardingCard(
  principal: string,
  s: Record<string, any>,
  deactivatedAtLoad: boolean,
  recordAtLoad: any,
  draw: () => void,
) {
  let plan: any = null;
  let hint = "";
  let busy = false;
  let deactivated = deactivatedAtLoad;
  let record = recordAtLoad;
  const path = (action: string) => "/api/users/" + encodeURIComponent(principal) + "/" + action;

  async function request(label: string, send: () => Promise<any>, done: (data: any) => void) {
    busy = true;
    hint = label;
    draw();
    const result = await send().catch(() => null);
    busy = false;
    if (!result) hint = "Network error. Try again.";
    else if (!result.ok) hint = result.data?.message || "Failed (" + result.status + ").";
    else done(result.data);
    draw();
  }
  const run = (apply: boolean) =>
    request(
      apply ? "Offboarding…" : "Checking what this person owns…",
      () => s.api("POST", path("offboard"), { apply }),
      (data) => {
        plan = data;
        const failed = plan.changes.filter((c: any) => c.result === "failed").length;
        if (plan.changes.some((c: any) => c.kind === "principal" && c.result === "done")) deactivated = true;
        if (data.principal) record = data.principal;
        hint = "";
        if (apply) hint = failed ? s.plural(failed, "change") + " failed. Preview again to retry." : "Done.";
      },
    );
  function confirmApply() {
    const message =
      "Offboard " +
      principal +
      "? This applies the " +
      s.plural(plan?.changes?.length || 0, "change") +
      " listed. Retired computers lose their disks. Conversations, memory and files are kept.";
    if (s.confirm(message)) void run(true);
  }
  function reactivate() {
    if (!s.confirm("Turn sign-in back on for " + principal + "? Archived items stay archived.")) return;
    void request(
      "Reactivating…",
      () => s.api("POST", path("reactivate")),
      (data) => {
        deactivated = false;
        record = data.principal || record;
        plan = null;
        hint = "Sign-in is back on.";
      },
    );
  }
  function result(c: any) {
    if (!c.result) return muted("planned");
    return c.result === "done" ? badge("done", "ok") : stacked(badge("failed", "warn"), c.error);
  }
  function history() {
    if (!record?.offboardedAt) return nothing;
    const when = (at: number, by?: string) => s.fmtTime(at) + (by ? " by " + by : "");
    return html`<p class="obstatus">
      ${record.offboarded ? badge("Offboarded", "warn") : badge("Reactivated", "ok")}
      ${muted(
        "Offboarded " +
          when(record.offboardedAt, record.offboardedBy) +
          (record.offboarded || !record.reactivatedAt
            ? ""
            : "; reactivated " + when(record.reactivatedAt, record.reactivatedBy)),
      )}
    </p>`;
  }
  function render() {
    const changes = plan?.changes || [];
    const kept = plan?.kept || [];
    const pending = plan && !plan.applied;
    return card(
      "Offboarding",
      "Turn off a departed person's sign-in and clean up what they own. Conversations, memory and files stay as the record.",
      html`<div class="offboard">
        ${history()}
        ${
          deactivated
            ? html`<p class="obstatus">
                Sign-in: ${badge("Deactivated", "warn")}
                <button type="button" class="link" ?disabled=${busy} @click=${reactivate}>Reactivate sign-in</button>
              </p>`
            : nothing
        }
        ${
          plan
            ? table(
                ["Change", "Item", "Scope", "Result"],
                changes.map((c: any) => [
                  { node: stacked(c.action.replaceAll("_", " "), noun(c.kind)) },
                  { node: stacked(c.label, c.id), cls: "mono" },
                  { node: muted(c.scopeId) },
                  { node: result(c) },
                ]),
                pending ? "Nothing to change." : "Nothing was changed.",
                undefined,
                { cols: COLS },
              )
            : nothing
        }
        ${
          kept.length
            ? table(
                ["Kept", "Item", "Scope", "Why"],
                kept.map((k: any) => [
                  { node: muted(noun(k.kind)) },
                  { node: stacked(k.label, k.id), cls: "mono" },
                  { node: muted(k.scopeId) },
                  { node: muted(k.reason) },
                ]),
                "",
                undefined,
                { cols: COLS },
              )
            : nothing
        }
        <div class="obactions">
          ${
            pending && changes.length
              ? html`<button type="button" class="danger" ?disabled=${busy} @click=${confirmApply}>
                  Offboard (${s.plural(changes.length, "change")})
                </button>`
              : html`<button type="button" ?disabled=${busy} @click=${() => run(false)}>Preview offboarding</button>`
          }
        </div>
        <p class="hint">${hint}</p>
      </div>`,
    );
  }
  return { render };
}
