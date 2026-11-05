\set ON_ERROR_STOP on
\copy (SELECT id, json FROM keychain_credentials WHERE json ->> 'service' ILIKE '%netsuite%' OR json ->> 'slug' ILIKE '%netsuite%' OR json ->> 'name' ILIKE '%netsuite%' ORDER BY id LIMIT 4) TO STDOUT WITH (FORMAT csv, HEADER true)
