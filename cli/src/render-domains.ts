import { CliError, note, ok } from "./log.ts";
import { list, RenderApiError, type RenderRequest, type RenderService } from "./render-api.ts";

export function httpsOrigin(value: string | undefined): string | undefined {
  const url = URL.parse(value ?? "");
  if (
    !url ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return undefined;
  return url.origin;
}
function assignedOrigin(value: string | undefined): string | undefined {
  const origin = httpsOrigin(value);
  return origin && new URL(origin).hostname.endsWith(".onrender.com") ? origin : undefined;
}
export function renderInternalUrl(service: Pick<RenderService, "name" | "slug">): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(service.slug))
    throw new CliError(`Render returned an invalid private hostname for ${service.name}`);
  return `http://${service.slug}:8080`;
}
export function publicUrl(service: RenderService): string {
  const origin = assignedOrigin(service.serviceDetails.url);
  if (!origin) throw new CliError(`Render returned an invalid public address for ${service.name}`);
  return origin;
}
interface CustomDomain {
  id: string;
  name: string;
  domainType: "apex" | "subdomain";
  redirectForName: string;
  verificationStatus: "verified" | "unverified";
}
function primaryDomain(domain: CustomDomain, service: RenderService): CustomDomain {
  if (domain.redirectForName)
    throw new CliError(
      `${service.name}: ${domain.name} redirects to ${domain.redirectForName} on Render; configure https://${domain.redirectForName} or remove the redirect in the Render dashboard`,
    );
  return domain;
}
function customDomainPath(service: RenderService, name?: string): string {
  return `/services/${service.id}/custom-domains${name ? `/${encodeURIComponent(name)}` : ""}`;
}
export function customDomains(request: RenderRequest, service: RenderService): Promise<CustomDomain[]> {
  return list<CustomDomain>(request, customDomainPath(service), "customDomain");
}
function dnsInstruction(domain: CustomDomain, service: RenderService): string {
  const record = domain.domainType === "apex" ? "an ALIAS or ANAME record" : "a CNAME record";
  return `point ${domain.name} at ${new URL(publicUrl(service)).hostname} with ${record}; Render verifies the domain and issues its certificate when the record resolves`;
}
async function ensureCustomDomain(request: RenderRequest, service: RenderService, origin: string): Promise<void> {
  const name = new URL(origin).hostname;
  const existing = (await customDomains(request, service)).find((item) => item.name === name);
  let domain = existing;
  if (!domain) {
    const created = await request<CustomDomain | CustomDomain[]>(customDomainPath(service), "POST", { name });
    domain = (Array.isArray(created) ? created : [created]).find((item) => item.name === name);
    if (!domain) throw new CliError(`Render returned no custom domain ${name} for ${service.name}`);
  }
  primaryDomain(domain, service);
  if (existing && domain.verificationStatus !== "verified")
    await request(`${customDomainPath(service, domain.id)}/verify`, "POST");
  if (domain.verificationStatus === "verified") ok(`${service.name}: custom domain ${name} verified`);
  else note(`${service.name}: custom domain ${name} is unverified; ${dnsInstruction(domain, service)}`);
}
export async function bindUrl(
  request: RenderRequest,
  service: RenderService,
  configured: string | undefined,
): Promise<string> {
  const origin = httpsOrigin(configured);
  if (!origin || assignedOrigin(origin)) return publicUrl(service);
  await ensureCustomDomain(request, service, origin);
  return origin;
}
export async function verifiedUrl(
  request: RenderRequest,
  service: RenderService,
  configured: string | undefined,
): Promise<string> {
  const origin = httpsOrigin(configured);
  if (!origin) throw new CliError(`${service.name} has no HTTPS origin URL configured; run qm check`);
  if (assignedOrigin(origin)) {
    if (origin !== publicUrl(service))
      throw new CliError("Configured Render URLs do not match the owned services; run qm up");
    return origin;
  }
  const name = new URL(origin).hostname;
  let domain: CustomDomain;
  try {
    domain = primaryDomain(await request<CustomDomain>(customDomainPath(service, name)), service);
  } catch (error) {
    if (error instanceof RenderApiError && error.status === 404)
      throw new CliError(`${service.name} has no custom domain ${name}; run qm up`);
    throw error;
  }
  if (domain.verificationStatus !== "verified")
    throw new CliError(`${service.name}: custom domain ${name} is unverified; ${dnsInstruction(domain, service)}`);
  return origin;
}
