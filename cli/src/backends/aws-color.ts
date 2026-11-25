import type { QmConfig } from "../config.ts";
import { CliError, errMessage } from "../log.ts";
import { awsJson, awsPublicRouting, type AwsColorRoute } from "./aws.ts";

const QUIET_MS = 300_000;
const METRIC_LAG_MS = 120_000;
const DRAIN_DEADLINE_MS = 1_200_000;
const DRAIN_POLL_MS = 30_000;

export function awsColorRoutes(config: QmConfig): { loadBalancerArn: string; routes: AwsColorRoute[] } {
  let state: ReturnType<typeof awsPublicRouting>;
  try {
    state = awsPublicRouting(config);
  } catch (error) {
    throw new CliError(`color-paired ALB is not ready: ${errMessage(error)}`, { cause: error });
  }
  if (!state.colorRoutes.size) throw new CliError(`${config.aws!.cluster} does not share its ALB with a peer stack`);
  const routes = [...state.colorRoutes.values()].sort((a, b) => a.route.localeCompare(b.route));
  return { loadBalancerArn: state.loadBalancerArn, routes };
}

export function awsTakeColorTraffic(config: QmConfig, log: (line: string) => void = console.log): void {
  for (const route of awsColorRoutes(config).routes) {
    if (route.ownWeight > 0 && route.peerWeight === 0) continue;
    awsJson(config.aws!, [
      "elbv2",
      "modify-rule",
      "--rule-arn",
      route.ruleArn,
      "--actions",
      JSON.stringify([
        {
          Type: "forward",
          ForwardConfig: {
            TargetGroups: [
              { TargetGroupArn: route.own, Weight: 1 },
              { TargetGroupArn: route.peer, Weight: 0 },
            ],
            TargetGroupStickinessConfig: { Enabled: false },
          },
        },
      ]),
    ]);
    log(`${route.route}: routed to ${config.aws!.cluster}`);
  }
  const left = awsColorRoutes(config).routes.filter((route) => route.ownWeight <= 0 || route.peerWeight !== 0);
  if (left.length) {
    throw new CliError(`ALB still routes ${left.map((route) => route.route).join(", ")} to the peer stack`);
  }
}

const elbDimension = (arn: string, kind: "loadbalancer" | "targetgroup"): string => {
  const index = arn.indexOf(`:${kind}/`);
  if (index < 0) throw new CliError(`${arn} is not a ${kind} ARN`);
  return kind === "loadbalancer" ? arn.slice(index + kind.length + 2) : arn.slice(index + 1);
};

export async function awsRequireColorDrained(
  config: QmConfig,
  clock: { now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<void> {
  const aws = config.aws!;
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = clock.log ?? console.log;
  const started = now();
  for (;;) {
    const { loadBalancerArn, routes } = awsColorRoutes(config);
    const routed = routes.filter((route) => route.ownWeight > 0);
    if (routed.length) {
      throw new CliError(`${aws.cluster} still receives ${routed.map((route) => route.route).join(", ")} traffic`);
    }
    const end = now() - METRIC_LAG_MS;
    const start = end - QUIET_MS;
    let requests = 0;
    for (const own of new Set(routes.map((route) => route.own))) {
      const points =
        awsJson<{ Datapoints?: Array<{ Sum?: number }> }>(aws, [
          "cloudwatch",
          "get-metric-statistics",
          "--namespace",
          "AWS/ApplicationELB",
          "--metric-name",
          "RequestCount",
          "--dimensions",
          `Name=LoadBalancer,Value=${elbDimension(loadBalancerArn, "loadbalancer")}`,
          `Name=TargetGroup,Value=${elbDimension(own, "targetgroup")}`,
          "--start-time",
          new Date(start).toISOString(),
          "--end-time",
          new Date(end).toISOString(),
          "--period",
          "60",
          "--statistics",
          "Sum",
        ]).Datapoints ?? [];
      requests += points.reduce((sum, point) => sum + (point.Sum ?? 0), 0);
    }
    const window = `${new Date(start).toISOString()} to ${new Date(end).toISOString()}`;
    if (requests === 0) {
      log(`${aws.cluster} served no requests from ${window}`);
      return;
    }
    if (now() - started >= DRAIN_DEADLINE_MS) {
      throw new CliError(`${aws.cluster} still served ${requests} requests from ${window}; it has not drained`);
    }
    log(`${aws.cluster} served ${requests} requests from ${window}; waiting for it to drain`);
    await sleep(DRAIN_POLL_MS);
  }
}
