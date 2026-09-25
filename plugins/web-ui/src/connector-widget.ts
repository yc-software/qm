import { html, type TemplateResult } from "lit";
import { ArrowUpRight, Check } from "lucide";
import { icon } from "./ui";
import { connectorLogo } from "./connector-logo";
import { CONNECTOR_NAMES, connectorService, type ConnectorLink } from "./connector-link";

export function connectorCard(
  link: ConnectorLink,
  connected = false,
  withReturnTo: (url: string) => string = (url) => url,
): TemplateResult {
  const composio = link.provider === "composio";
  const name = CONNECTOR_NAMES[link.provider] ?? "your account";
  const service = connectorService(link);
  if (!composio && connected) {
    return html`<div class="connector-widget connected" role="status">
      ${connectorLogo(service)}
      <span class="connector-widget-text"><strong>Connected ${name}</strong><small>Ready to use in chat</small></span>
      <span class="connector-widget-status" aria-hidden="true">${icon(Check, 16)}</span>
    </div>`;
  }
  return html`<a
    class="connector-widget"
    href=${composio ? link.url : withReturnTo(link.url)}
    target="_blank"
    rel="noreferrer"
    title="Opens in a new tab"
  >
    ${connectorLogo(service)}
    <span class="connector-widget-text"
      ><strong>${(composio && link.label) || `Connect ${name}`}</strong> <small>Authorize access · New tab</small></span
    >
    <span class="connector-widget-action" aria-hidden="true">${icon(ArrowUpRight, 16)}</span>
  </a>`;
}
