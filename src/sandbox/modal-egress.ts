import { modalEgressAllowlist, type ModalClient, type ModalSession } from "./modal-client.ts";
import { tenantEgressProxyUrl } from "./tenant-sandbox-shape.ts";
import { swallowAs } from "../util/errors.ts";

export interface ModalEgressRecord {
  egressPolicy?: string;
}

export interface ModalEgress {
  proxyUrl(): string | undefined;
  client(base: ModalClient): ModalClient;
  createdPolicy(session: ModalSession): string | undefined;
  stale(record: ModalEgressRecord | null | undefined): boolean;
  retireStaleScratch(held: ModalSession | undefined, active: number): Promise<boolean>;
}

const policyOf = (egressProxyUrl: string | undefined): string =>
  egressProxyUrl ? JSON.stringify(modalEgressAllowlist(egressProxyUrl)) : "open";

export function createModalEgress(deploymentProxyUrl: string | undefined): ModalEgress {
  const deploymentPolicy = policyOf(deploymentProxyUrl);
  const createdWith = new WeakMap<ModalSession, string>();
  const proxyUrl = (): string | undefined => tenantEgressProxyUrl(deploymentProxyUrl);
  const want = (): string => policyOf(proxyUrl());
  return {
    proxyUrl,
    client: (base) => ({
      ...base,
      async create(createOpts): Promise<ModalSession> {
        const egressProxyUrl = proxyUrl();
        const policy = policyOf(egressProxyUrl);
        const session = await base.create({ ...createOpts, ...(egressProxyUrl ? { egressProxyUrl } : {}) });
        createdWith.set(session, policy);
        return session;
      },
    }),
    createdPolicy: (session) => createdWith.get(session),
    stale: (record) => !!record && (record.egressPolicy ?? deploymentPolicy) !== want(),
    async retireStaleScratch(held, active): Promise<boolean> {
      if (!held || (createdWith.get(held) ?? deploymentPolicy) === want()) return false;
      if (active > 0) throw egressReplaceFailed(new Error("this scratch computer is still in use"));
      await held.terminate().catch(swallowAs("modal-egress: retire scratch with a stale egress setting", undefined));
      return true;
    },
  };
}

export function egressReplaceFailed(cause: unknown): Error {
  return new Error(
    `this Modal computer has to be replaced to apply its organization's egress setting, and replacing it failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
}
