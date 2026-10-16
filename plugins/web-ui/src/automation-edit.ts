import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { errMessage } from "../../chassis/src/errors.ts";

interface AutomationEditOptions {
  heading: string;
  title?: string;
  task?: string;
  message?: string;
  hint: string | TemplateResult;
  onCancel: () => void;
  onSave: (values: { title?: string; task?: string }) => Promise<void>;
  onSaved: () => void | Promise<void>;
  onEditWithAgent?: () => void;
}

export function automationEditDialog(options: AutomationEditOptions): TemplateResult {
  let saving = false;
  const cancel = () => {
    if (!saving) options.onCancel();
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget as HTMLFormElement;
    const titleField = form.elements.namedItem("title") as HTMLInputElement | null;
    const taskField = form.elements.namedItem("task") as HTMLTextAreaElement | null;
    const title = titleField?.value.trim();
    const task = taskField?.value.trim();
    const error = form.querySelector<HTMLElement>(".form-error")!;
    error.textContent = "";
    if ((titleField && !title) || (taskField && !task)) {
      const requiredFields = [titleField && "Title", taskField && "task"].filter(Boolean);
      error.textContent = `${requiredFields.join(" and ")} ${requiredFields.length > 1 ? "are" : "is"} required.`;
      error.textContent = error.textContent[0].toUpperCase() + error.textContent.slice(1);
      return;
    }
    const controls = Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button"),
    );
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    saving = true;
    for (const control of controls) control.disabled = true;
    submit.textContent = "Saving…";
    try {
      await options.onSave({ ...(titleField ? { title } : {}), ...(taskField ? { task } : {}) });
      if (form.isConnected) await options.onSaved();
    } catch (cause) {
      error.textContent = errMessage(cause, "Couldn't save changes.");
    } finally {
      saving = false;
      for (const control of controls) control.disabled = false;
      submit.textContent = "Save";
    }
  };
  return html`<div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && cancel()}
    @keydown=${(event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        cancel();
      }
    }}
  >
    <form
      class="project-dialog automation-edit-dialog"
      role="dialog"
      aria-modal="true"
      aria-label=${options.heading}
      @submit=${save}
      ${ref((element) => {
        if (element)
          queueMicrotask(() =>
            element.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus(),
          );
      })}
    >
      <div class="project-dialog-head">
        <div><h2>${options.heading}</h2></div>
      </div>
      ${options.title !== undefined ? html`<label>Title<input name="title" maxlength="80" .value=${options.title} required /></label>` : nothing}
      ${options.task !== undefined ? html`<label>Task<textarea name="task" rows="5" .value=${options.task} required></textarea></label>` : nothing}
      ${
        options.message !== undefined
          ? html`<div class="field">
              <label>Message</label>
              <div class="value pre">${options.message}</div>
            </div>`
          : nothing
      }
      <p class="hint">${options.hint}</p>
      <div class="form-error" role="alert"></div>
      <div class="project-dialog-actions">
        ${options.onEditWithAgent ? html`<button class="btn" type="button" @click=${options.onEditWithAgent}>Edit behavior with agent</button>` : nothing}
        <button class="btn" type="button" @click=${cancel}>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>
  </div>`;
}
