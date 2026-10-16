export interface WebhookEvent {
  id: string;
  scheme: string;
  deliveryId: string;
  action: string;
  payload: string;
}

export function webhookEventOf(payload: unknown): WebhookEvent | undefined {
  const text = (payload as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || !text.startsWith("<wake ")) return undefined;
  const root = new DOMParser().parseFromString(text, "application/xml").documentElement;
  if (
    root.tagName !== "wake" ||
    root.getAttribute("reason") !== "webhook" ||
    root.getAttribute("surface") !== "webhook"
  )
    return undefined;
  const event = Array.from(root.children).find((child) => child.tagName === "event");
  if (!event) return undefined;
  return {
    id: root.getAttribute("webhook-id") ?? "",
    scheme: root.getAttribute("scheme") ?? "",
    deliveryId: root.getAttribute("delivery-id") ?? "",
    action:
      Array.from(root.children)
        .find((child) => child.tagName === "standing-orders")
        ?.textContent?.trim() ?? "",
    payload: event.textContent?.trim() ?? "",
  };
}
