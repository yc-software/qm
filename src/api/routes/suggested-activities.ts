import { samePerson } from "../../directory/person.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { Route } from "./route.ts";
import { companyActivitySeeds, type WebMeConfig } from "./web-me.ts";
import type { SuggestedActivity } from "../../../plugins/chassis/src/suggested-activities.ts";

async function seedActivities(config: WebMeConfig | undefined): Promise<SuggestedActivity[]> {
  if (!config) return [];
  return (await companyActivitySeeds(config))?.activities ?? config.suggestedActivities;
}

export const suggestedActivityRoutes: Route[] = [
  {
    method: "GET",
    path: "/v1/suggested-activities",
    actor: "person",
    auth: "source",
    handle: ({ res, deps }) => sendJson(res, 200, { enabled: Boolean(deps.suggestedActivities) }),
  },
  {
    method: "POST",
    path: "/v1/suggested-activities",
    browser: true,
    actor: "body.principalId",
    auth: "source",
    handle: async ({ res, deps, body, actor }) => {
      if (!deps.suggestedActivities) return sendJson(res, 404, { error: "not_found" });
      if (!isObj(body) || typeof body.principalId !== "string" || !body.principalId || body.principalId.length > 200) {
        return sendJson(res, 400, { error: "bad_request" });
      }
      if (actor && !samePerson(actor.p, body.principalId)) return sendJson(res, 403, { error: "forbidden" });
      const timezone = body.timezone ?? "UTC";
      if (typeof timezone !== "string" || timezone.length > 100) return sendJson(res, 400, { error: "bad_request" });
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        return sendJson(res, 400, { error: "bad_request" });
      }
      return sendJson(
        res,
        200,
        await deps.suggestedActivities.get(body.principalId, await seedActivities(deps.web?.me), {
          timezone,
          poll: body.poll === true,
          refresh: body.refresh === true,
        }),
      );
    },
  },
  {
    method: "POST",
    path: "/v1/suggested-activities/dismiss",
    browser: true,
    actor: "body.principalId",
    auth: "source",
    handle: async ({ res, deps, body, actor }) => {
      if (!deps.suggestedActivities) return sendJson(res, 404, { error: "not_found" });
      if (
        !isObj(body) ||
        typeof body.principalId !== "string" ||
        !body.principalId ||
        body.principalId.length > 200 ||
        typeof body.id !== "string" ||
        body.id.length > 64
      ) {
        return sendJson(res, 400, { error: "bad_request" });
      }
      if (actor && !samePerson(actor.p, body.principalId)) return sendJson(res, 403, { error: "forbidden" });
      if (!(await deps.suggestedActivities.dismiss(body.principalId, body.id))) {
        return sendJson(res, 404, { error: "not_found" });
      }
      return sendJson(res, 200, { dismissed: true });
    },
  },
];
