export interface CanaryChannelCandidate {
  id: string;
  name: string;
  is_archived?: boolean;
}

const CI_THROWAWAY = /^ci-[a-z0-9-]*-?\d+$/;

export function pickCanaryChannel(channels: CanaryChannelCandidate[]): CanaryChannelCandidate | null {
  const live = channels.filter((c) => c.id && c.name && !c.is_archived);
  return live.find((c) => c.name === "dev-canary") ?? live.find((c) => CI_THROWAWAY.test(c.name)) ?? null;
}

export async function discoverCanaryChannel(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
  apiBase = "https://slack.com/api/",
): Promise<CanaryChannelCandidate | null> {
  const channels: CanaryChannelCandidate[] = [];
  let cursor = "";
  try {
    for (let page = 0; page < 5; page++) {
      const url =
        `${apiBase.replace(/\/+$/, "")}/users.conversations?types=public_channel,private_channel&exclude_archived=true&limit=200` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        channels?: CanaryChannelCandidate[];
        response_metadata?: { next_cursor?: string };
      };
      if (!body.ok || !Array.isArray(body.channels)) return channels.length ? pickCanaryChannel(channels) : null;
      channels.push(...body.channels);
      const dedicated = channels.find((c) => c.name === "dev-canary" && !c.is_archived);
      if (dedicated) return dedicated;
      cursor = body.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return pickCanaryChannel(channels);
  } catch {
    return channels.length ? pickCanaryChannel(channels) : null;
  }
}
