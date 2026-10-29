export class SettingState {
  key: string;
  draft: Record<string, any> = {};
  baseline = "{}";
  available = false;
  saving = false;
  message = "";
  tone = "";
  render = () => {};
  constructor(key: string) {
    this.key = key;
  }
  collect(_validate = true): Record<string, any> {
    return structuredClone(this.draft);
  }
  get dirty() {
    return JSON.stringify(this.collect(false)) !== this.baseline;
  }
  changed() {
    if (!this.saving) {
      this.message = this.dirty ? "Unsaved changes" : "";
      this.tone = this.dirty ? "dirty" : "";
    }
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
