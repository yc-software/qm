import type { AdminPage } from "./sections.ts";

export class SettingState {
  key: string;
  draft: Record<string, any> = {};
  baseline = "{}";
  available = false;
  saving = false;
  message = "";
  tone = "";
  render = () => {};
  save: () => unknown = () => {};
  constructor(key: string) {
    this.key = key;
  }
  collect(_validate = true): Record<string, any> {
    return structuredClone(this.draft);
  }
  get dirty() {
    return JSON.stringify(this.collect(false)) !== this.baseline;
  }
  change(field: string, value: unknown) {
    this.draft[field] = value;
    this.changed();
  }
  changed() {
    if (!this.saving) {
      this.message = this.dirty ? "Unsaved changes" : "";
      this.tone = this.dirty ? "dirty" : "";
    }
    this.render();
  }
  loaded() {
    this.baseline = JSON.stringify(this.collect(false));
    this.message = "";
    this.tone = "";
    this.saving = false;
    this.render();
  }
  commit(body: unknown) {
    this.baseline = JSON.stringify(body);
    this.saving = false;
    this.message = this.dirty ? "Unsaved changes" : "Saved";
    this.tone = this.dirty ? "dirty" : "ok";
    this.render();
  }
}

export function settingRegistry<T extends SettingState>(states: Map<string, T>) {
  return {
    owns: (key: string) => states.has(key),
    collect: (key: string) => states.get(key)!.collect(),
    capture(key: string) {
      const state = states.get(key)!;
      state.baseline = JSON.stringify(state.collect(false));
      state.changed();
    },
    commit: (key: string, body: unknown) => states.get(key)!.commit(body),
    status(key: string, message: string, tone = "") {
      const state = states.get(key)!;
      state.message = message;
      state.tone = tone;
      state.saving = tone === "saving";
      state.render();
    },
    statusKey(id: string) {
      const key = id.replace(/^st-/, "");
      return states.has(key) ? key : undefined;
    },
  };
}

export async function putSetting(
  page: Pick<AdminPage, "api" | "current">,
  scope: string,
  s: SettingState,
  path: string,
  body: unknown,
) {
  Object.assign(s, { saving: true, message: "Saving...", tone: "saving" }).render();
  const r = await page.api("PUT", "/api/scopes/" + encodeURIComponent(scope) + "/" + path, body);
  s.saving = false;
  if (!page.current()) {
    Object.assign(s, { message: "", tone: "" });
    return null;
  }
  if (!r.ok) {
    const message = r.status === 403 ? "Not authorized for this scope." : r.data?.message || "Save failed.";
    Object.assign(s, { message, tone: "err" }).render();
  }
  return r;
}
