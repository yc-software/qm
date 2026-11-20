import { html } from "lit";

export const switchTrack = (on: boolean) =>
  html`<span class=${on ? "qm-switch on" : "qm-switch"} aria-hidden="true"></span>`;
