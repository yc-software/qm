import { parseSuggestedActivities } from "../../../plugins/chassis/src/suggested-activities.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { Route } from "./route.ts";

export const suggestedActivityRoutes: Route[] = [
  {
    method: "GET",
    path: "/v1/suggested-activities",
    auth: "source",
    handle: ({ res, deps }) => sendJson(res, 200, { enabled: Boolean(deps.suggestedActivities) }),
  },
  {
    method: "POST",
    path: "/v1/suggested-activities",
    auth: "source",
    handle: async ({ res, deps, body, actor }) => {
      if (!deps.suggestedActivities) return sendJson(res, 404, { error: "not_found" });
      if (!isObj(body) || typeof body.principalId !== "string" || !body.principalId || body.principalId.length > 200) {
        return sendJson(res, 400, { error: "bad_request" });
      }
      if (actor && actor.p !== body.principalId) return sendJson(res, 403, { error: "forbidden" });
      let seeds;
      try {
        seeds = parseSuggestedActivities(JSON.stringify(body.seeds ?? []));
      } catch {
        return sendJson(res, 400, { error: "bad_request" });
      }
      const activities = await deps.suggestedActivities(body.principalId, seeds);
      return sendJson(res, 200, { activities });
    },
  },
];
