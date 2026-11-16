import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE = resolve(ROOT, "scripts/tenant-ratchet.json");

const SITES = {
  mintSites: { "plugins/chassis/src/tenant.ts": ["withTenant"] },
  implicitQueries: {
    "src/persistence/pg-pool.ts": [
      "PgPool.q",
      "PgPool.query",
      "PgPool.pool",
      "PgPool.sessionPool",
      "withPgTransaction",
    ],
  },
  ambientReads: {
    "plugins/chassis/src/tenant.ts": ["boundTenant", "ambientTenant"],
    "src/tenants/context.ts": ["currentTenant"],
  },
  ambientCaches: { "src/tenants/cache.ts": ["perTenant", "tenantListeners", "onTenantLoad"] },
} satisfies Record<string, Record<string, string[]>>;

type Metric = keyof typeof SITES;

function declarationName(declaration: ts.Declaration): string | undefined {
  if (ts.isFunctionDeclaration(declaration)) return declaration.name?.text;
  if ((ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration)) && ts.isIdentifier(declaration.name)) {
    const owner = declaration.parent;
    return ts.isInterfaceDeclaration(owner) ? `${owner.name.text}.${declaration.name.text}` : undefined;
  }
  return undefined;
}

function metricOf(declaration: ts.Declaration): Metric | undefined {
  const file = relative(ROOT, declaration.getSourceFile().fileName);
  const name = declarationName(declaration);
  if (name === undefined) return undefined;
  return (Object.keys(SITES) as Metric[]).find((metric) =>
    (SITES[metric] as Record<string, string[]>)[file]?.includes(name),
  );
}

function countTenantSites(): Record<Metric, Map<string, number>> {
  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!config) throw new Error("tsconfig.json could not be read");
  const roots = config.fileNames.filter((file) => relative(ROOT, file).startsWith("src/"));
  const program = ts.createProgram(roots, config.options);
  const checker = program.getTypeChecker();
  const counts = Object.fromEntries(Object.keys(SITES).map((metric) => [metric, new Map()])) as Record<
    Metric,
    Map<string, number>
  >;
  for (const source of program.getSourceFiles()) {
    const file = relative(ROOT, source.fileName);
    if (source.isDeclarationFile || !/^(src|plugins)\//.test(file) || file.endsWith(".test.ts")) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        const metric = declaration && !ts.isJSDocSignature(declaration) ? metricOf(declaration) : undefined;
        if (metric) counts[metric].set(file, (counts[metric].get(file) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return counts;
}

function total(sites: Map<string, number>): number {
  return [...sites.values()].reduce((sum, n) => sum + n, 0);
}

function main(args: string[]): number {
  const counts = countTenantSites();
  const totals = Object.fromEntries(Object.entries(counts).map(([metric, sites]) => [metric, total(sites)])) as Record<
    Metric,
    number
  >;
  if (args.includes("--list"))
    for (const [metric, sites] of Object.entries(counts))
      for (const [file, n] of [...sites].sort((a, b) => b[1] - a[1])) console.log(`${metric}\t${n}\t${file}`);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, unknown>;
  const metrics = Object.keys(totals) as Metric[];
  const problems = [
    ...Object.keys(baseline)
      .filter((key) => !metrics.includes(key as Metric))
      .map((key) => `${key} is not a metric this script counts; remove it from the baseline`),
    ...metrics.flatMap((metric) => {
      const now = totals[metric];
      const was = baseline[metric];
      if (typeof was !== "number") return [`${metric} has no numeric baseline; set "${metric}": ${now} by hand`];
      if (now > was) return [`${metric} rose from ${was} to ${now}; see docs/tenant-tokens.md`];
      if (now < was && !args.includes("--update"))
        return [`${metric} fell from ${was} to ${now}: run node scripts/tenant-ratchet.ts --update`];
      return [];
    }),
  ];
  for (const problem of problems) console.error(`tenant ratchet: ${problem}`);
  if (problems.length) return 1;
  if (args.includes("--update")) writeFileSync(BASELINE, `${JSON.stringify(totals, null, 2)}\n`);
  console.log(`tenant ratchet: ${JSON.stringify(totals)}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
