\set ON_ERROR_STOP on
CREATE TEMP TABLE keychain_credentials_import (id TEXT, json JSONB);
\copy keychain_credentials_import FROM STDIN WITH (FORMAT csv, HEADER true)
INSERT INTO keychain_credentials (id, json)
SELECT i.id, i.json
FROM keychain_credentials_import i
ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json;
