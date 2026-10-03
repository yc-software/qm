# App page views

The app gateway records each page load of a published app in the `app_page_views` table when core has a database and an apps domain configured. Each row holds the deployment ID, the deployed version, the viewer's principal (or null for an anonymous public visit), the auth mode (`signed_in`, `public` or `app_only`), the time, the request path without its query string, the client IP and the user agent. Request bodies, cookies, query strings and headers other than the user agent are never stored.

Only top-level document loads count, plus embeds framed by other sites. Scripts, images, styles and API calls do not. An owner's view counts once for the app shell, not again for the app frame inside it. Requests that are denied or sent to sign-in are not recorded; denials stay in the audit log.

Views are recorded when the gateway forwards the request, so they include loads the app itself answers with an error or redirect. The path is stored as requested; apps that put secrets in paths should expect them here. The client IP is supplied by the portal and is best effort for any caller that reaches core directly.

Recording never delays or fails the request. A failed write is reported with the deployment ID. If writes back up under heavy traffic, further views are dropped and the number dropped is reported at most once a minute.

## Retention

Rows are not pruned automatically. The table grows with traffic and contains personal data (principals, IP addresses and user agents), so operators should set a retention period that matches their privacy policy and delete older rows on a schedule, for example:

```sql
DELETE FROM app_page_views WHERE at < (extract(epoch FROM now() - interval '90 days') * 1000)::bigint;
```

The `at` index keeps this delete cheap.
