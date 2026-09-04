export type RouteShape = { method: string; path: string } | { match: (method: string, pathname: string) => boolean };

interface Matcher {
  test: (method: string, pathname: string, params: Record<string, string>) => boolean;
}

export function compilePath(path: string): Matcher {
  const want = path.split("/").map((seg) => (seg.startsWith(":") ? { param: seg.slice(1) } : { literal: seg }));
  return {
    test(_method, pathname, out) {
      const got = pathname.split("/");
      if (got.length !== want.length) return false;
      for (let i = 0; i < want.length; i++) {
        const seg = want[i]!;
        const value = got[i]!;
        if ("literal" in seg) {
          if (value !== seg.literal) return false;
        } else {
          try {
            out[seg.param] = decodeURIComponent(value);
          } catch {
            return false;
          }
        }
      }
      return true;
    },
  };
}

function matcherFor<R extends RouteShape>(
  route: R,
): (method: string, pathname: string, params: Record<string, string>) => boolean {
  if ("path" in route) {
    const compiled = compilePath(route.path);
    return (method, pathname, params) => method === route.method && compiled.test(method, pathname, params);
  }
  return (method, pathname) => route.match(method, pathname);
}

export function findRoute<R extends RouteShape>(
  routes: ReadonlyArray<R>,
  method: string,
  pathname: string,
): { route: R; params: Record<string, string> } | null {
  for (const route of routes) {
    const params: Record<string, string> = {};
    if (matcherFor(route)(method, pathname, params)) return { route, params };
  }
  return null;
}
