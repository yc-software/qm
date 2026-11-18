const OPEN_SESSION_MESSAGE = "qm:open-session";

const windowClients = () => self.clients.matchAll({ type: "window", includeUncontrolled: true });

const showing = (client, sessionId) =>
  client.focused &&
  client.visibilityState === "visible" &&
  new URL(client.url).pathname.endsWith(`/s/${encodeURIComponent(sessionId)}`);

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const notice = event.data?.json();
  if (!notice?.sessionId) return;
  event.waitUntil(
    windowClients().then((clients) =>
      clients.some((client) => showing(client, notice.sessionId))
        ? undefined
        : self.registration.showNotification(notice.title, { body: notice.body, tag: notice.sessionId, data: notice }),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  const notice = event.notification.data;
  event.notification.close();
  event.waitUntil(
    windowClients().then(async (clients) => {
      const client = clients.find((candidate) => candidate.focused) ?? clients[0];
      if (!client) return self.clients.openWindow(notice.url);
      await client.focus();
      client.postMessage({ type: OPEN_SESSION_MESSAGE, sessionId: notice.sessionId });
    }),
  );
});
