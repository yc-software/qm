const OPEN_SESSION_MESSAGE = "qm:open-session";
const REPLY_NOTICE_MESSAGE = "qm:reply-notice";

const windowClients = () => self.clients.matchAll({ type: "window", includeUncontrolled: true });

const present = (client) => client.focused && client.visibilityState === "visible";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const notice = event.data?.json();
  if (!notice?.sessionId) return;
  event.waitUntil(
    windowClients().then((clients) => {
      const here = clients.filter(present);
      if (!here.length)
        return self.registration.showNotification(notice.title, {
          body: notice.body,
          tag: notice.sessionId,
          data: notice,
        });
      for (const client of here) client.postMessage({ type: REPLY_NOTICE_MESSAGE, notice });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  const notice = event.notification.data;
  event.notification.close();
  event.waitUntil(
    windowClients().then((clients) => {
      const client = clients.find((candidate) => candidate.focused) ?? clients[0];
      if (!client) return self.clients.openWindow(notice.url);
      client.postMessage({ type: OPEN_SESSION_MESSAGE, sessionId: notice.sessionId });
      return client.focus();
    }),
  );
});
