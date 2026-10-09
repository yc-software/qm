# Receiving webhooks without a public URL via Svix Ingest

Svix Ingest is the Svix product for _receiving_ webhooks, and when paired with a Polling Endpoint, it makes really easy to start consuming events with little to no setup.
Ingest supports all providers that qm currently have (think of GitHub, Hubspot, Stripe etc) and many more, it also has support for 'generic' webhooks so signature verification can be completely delegated to Svix and it would just need to poll an URL to start consuming events after setting up the Ingest URLs and creating a _AutoConfigConsumer_ token.

AutoConfig is the recently launched webhooks-setup-as-code API that Svix Launched, so instead of opening the UI to declare/edit your routes, you can programatically create/change your webhooks by running the code that you used to declare them :)
AutoConfigConsumer, specifically, is what you need to transform a Ingest 'endpoint' into something that you can poll to get your messages instead of setting up a server and exposing a route to the web.