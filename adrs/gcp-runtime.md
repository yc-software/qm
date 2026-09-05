Following up on #367 / #735 in the format you asked for.

We run SimpleLend entirely on GCP — Cloud Run, Cloud SQL, Secret Manager, Artifact Registry, GKE. When we picked qm as the agent runtime for our team, the only piece that didn't fit was the sandbox path, which assumes AWS.

So we built a GCP path ourselves and have been running it in production since mid-August: GKE Autopilot with Google's Agent Sandbox for the isolated computers, GCS for durable files, Workload Identity instead of long-lived keys. Six agents on it behind a portal, used by actual staff. The isolation model lines up well — Agent Sandbox is gVisor, so it's the same shape as what you already do on AWS rather than a different concept bolted on.

The reason I'd rather this lived upstream than in our fork: today every qm release means re-applying our adapter by hand. That's survivable for us, but we drift a little further each time, and more to the point any team already on GCP has to do that same work before they can even try qm. That's the actual argument, more than wanting our patch merged.

If you do build it, I'm happy to be a tester. We have a real cluster under real load and can tell you quickly whether it holds up outside our own setup.

Not attached to any of the implementation choices in #367 — that was just what we needed to ship.
