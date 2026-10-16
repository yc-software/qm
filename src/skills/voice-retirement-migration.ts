const previousInstruction =
  '3. For each new or refreshed item, investigate before drafting: read the whole thread, and check whatever context makes the reply substantive (calendar for scheduling asks, earlier email/Slack history for open questions). Draft the reply in the user\'s own voice \u2014 for email follow the email-draft-in-voice skill (build the voice profile first if it is missing); for Slack match how the user actually writes in Slack (check their recent messages: register, length, punctuation). Punctuation hard rule: never use em dashes or en dashes in a draft; use a comma, period, or "..." instead, and re-read every draft before posting to strip any that slipped in.'.replaceAll(
    "'",
    "''",
  );
const replacementInstruction =
  "3. For each new or refreshed item, investigate before drafting: read the whole thread, and check whatever context makes the reply substantive (calendar for scheduling asks, earlier email/Slack history for open questions). Follow the available writing skills for both email and Slack, using the user's own profile and recent writing from this source. Respect this loop's source restriction. If a required profile or skill asset is missing, leave the draft pending and report what is needed; do not build or refresh a profile during inbox sync.".replaceAll(
    "'",
    "''",
  );

export const VOICE_RETIREMENT_MIGRATION = {
  id: "durable-map/skills/0002-retire-email-voice",
  statements: [
    "CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS loops (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS crons (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
    `UPDATE skills SET json = json || jsonb_build_object('status', 'archived', 'updatedAt', floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint)
     WHERE json ->> 'createdBy' = 'system:skills-seed' AND starts_with(json ->> 'scopeId', 'org:')
       AND json #>> '{manifest,name}' IN ('email-draft-in-voice', 'email-voice-profile') AND json ->> 'status' <> 'archived'`,
    `UPDATE loops SET json = json || jsonb_build_object(
       'playbook', replace(replace(json ->> 'playbook', '${previousInstruction}', '${replacementInstruction}'), 'Inbox sync v6.', 'Inbox sync v7.'),
       'playbookVersion', COALESCE((json ->> 'playbookVersion')::int, 0) + 1,
       'playbookHistory', COALESCE(json -> 'playbookHistory', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
         'version', COALESCE((json ->> 'playbookVersion')::int, 0) + 1,
         'at', floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint,
         'by', 'system:voice-skill-retirement')),
       'updatedAt', floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint)
     WHERE (json ->> 'surface' = 'inbox' OR starts_with(json ->> 'surface', 'inbox:'))
       AND strpos(json ->> 'playbook', '${previousInstruction}') > 0`,
    `UPDATE crons SET json = json || jsonb_build_object(
       'action', replace(replace(json ->> 'action', '${previousInstruction}', '${replacementInstruction}'), 'Inbox sync v6.', 'Inbox sync v7.'),
       'updatedAt', floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint)
     WHERE id IN (SELECT json ->> 'cronId' FROM loops WHERE json ->> 'surface' = 'inbox' OR starts_with(json ->> 'surface', 'inbox:'))
       AND strpos(json ->> 'action', '${previousInstruction}') > 0`,
  ],
};
