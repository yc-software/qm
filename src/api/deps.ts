import type { Core } from "../wiring.ts";
import type { WebEvents } from "./routes/web-events.ts";
import type { WebShell } from "../web/shell.ts";
import type { WebMeConfig } from "./routes/web-me.ts";
import type { SlackWebClientFactory } from "../slack/web-client.ts";
import type { ManagedSlack } from "../surfaces/slack-managed.ts";
import type { FetchLike } from "../connectors/oauth.ts";
import type { BrokerFetch } from "./credential-broker.ts";
import type { GitHttpFetch } from "./git-http-broker.ts";
import type { AddressFetch } from "../util/network.ts";
import type { ControlService } from "./control-service.ts";
import type { SlackSocketAppIdReader } from "../surfaces/slack-installation.ts";

export interface ServerDeps extends Core {
  requestBodyDeadlineMs?: number;
  draining?: AbortSignal;
  composioFetch?: typeof fetch;
  openaiApiKey?: string;
  portalSession?: {
    secret: string;
    maxAgeSeconds: number;
    apiOrigins?: ReadonlySet<string>;
  };
  web?: { events: WebEvents; me: WebMeConfig; shell: WebShell };
  control: ControlService;
  managedSlack?: ManagedSlack;
  slackInstallationFetch?: typeof fetch;
  slackWebClient?: SlackWebClientFactory;
  slackInstallationSocketAppId?: SlackSocketAppIdReader;
  slackEnvironmentState?: "absent" | "configured" | "partial";
  slackEnvBotToken?: string;
  oauthStateSecret?: string;
  oauthFetch?: FetchLike;
  brokerFetch?: BrokerFetch;
  gitHttpFetch?: GitHttpFetch;
  itemImageFetch?: AddressFetch;
  modelCredentialFetch?: typeof fetch;
}
