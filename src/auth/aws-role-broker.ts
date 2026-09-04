import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

interface VendedAwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
  expiresAt: number;
}

export interface AwsRoleBroker {
  credsForActor(userId: string): Promise<VendedAwsCreds>;
}

export function brokerSessionName(userId: string): string {
  const cleaned = userId.replace(/[^\w+=,.@-]/g, "-").slice(0, 64);
  return cleaned.length >= 2 ? cleaned : `u-${cleaned}`;
}

function sessionPolicy(actions: readonly string[]): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: actions.length === 1 ? actions[0] : [...actions], Resource: "*" }],
  });
}

type AssumeRole = (input: {
  RoleArn: string;
  RoleSessionName: string;
  DurationSeconds: number;
  Policy: string;
}) => Promise<{
  Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date };
}>;

export interface AwsRoleBrokerOptions {
  roleArn: string;
  region: string;
  sessionActions: readonly string[];
  durationSeconds?: number;
  refreshMarginMs?: number;
  now?: () => number;
  assumeRole?: AssumeRole;
}

export function createAwsRoleBroker(opts: AwsRoleBrokerOptions): AwsRoleBroker {
  const duration = opts.durationSeconds ?? 3600;
  const refreshMargin = opts.refreshMarginMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const policy = sessionPolicy(opts.sessionActions);
  const assumeRole: AssumeRole =
    opts.assumeRole ??
    ((): AssumeRole => {
      const client = new STSClient({ region: opts.region });
      return (input) => client.send(new AssumeRoleCommand(input));
    })();
  const cache = new Map<string, VendedAwsCreds>();

  return {
    async credsForActor(userId: string): Promise<VendedAwsCreds> {
      const sessionName = brokerSessionName(userId);
      const cached = cache.get(sessionName);
      if (cached && cached.expiresAt - now() > refreshMargin) return cached;
      const out = await assumeRole({
        RoleArn: opts.roleArn,
        RoleSessionName: sessionName,
        DurationSeconds: duration,
        Policy: policy,
      });
      const c = out.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
        throw new Error("aws-role-broker: AssumeRole returned incomplete credentials");
      }
      const creds: VendedAwsCreds = {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        region: opts.region,
        expiresAt: c.Expiration ? c.Expiration.getTime() : now() + duration * 1000,
      };
      cache.set(sessionName, creds);
      return creds;
    },
  };
}
