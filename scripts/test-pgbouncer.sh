#!/usr/bin/env bash
set -euo pipefail
name="qm-pgbouncer-test-$$"
fixture=$(mktemp -d)
cleanup() {
  docker rm -f "$name-pool" "$name-db" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT
docker network create "$name" >/dev/null
docker run -d --name "$name-db" --network "$name" -e POSTGRES_PASSWORD=test-password -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
for attempt in $(seq 1 60); do
  if docker exec "$name-db" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$fixture/server.key" -out "$fixture/server.crt" -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 >/dev/null 2>&1
cat > "$fixture/pgbouncer.ini" <<CONFIG
[databases]
postgres = host=$name-db port=5432 dbname=postgres pool_size=1
[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir = /tmp
pool_mode = transaction
auth_type = scram-sha-256
auth_file = /fixture/users.txt
client_tls_sslmode = require
client_tls_cert_file = /fixture/server.crt
client_tls_key_file = /fixture/server.key
server_tls_sslmode = disable
max_client_conn = 100
default_pool_size = 1
query_wait_timeout = 10
CONFIG
printf '"postgres" "test-password"\n' > "$fixture/users.txt"
chmod 755 "$fixture"
chmod 644 "$fixture"/*
docker create --name "$name-pool" --network "$name" -p 127.0.0.1::6432 alpine:3.22 sh -c 'apk add --no-cache pgbouncer >/dev/null && adduser -D pool && exec su pool -s /bin/sh -c "pgbouncer /fixture/pgbouncer.ini"' >/dev/null
docker cp "$fixture" "$name-pool:/fixture"
docker start "$name-pool" >/dev/null
direct_port=$(docker port "$name-db" 5432/tcp | sed 's/.*://')
pooled_port=$(docker port "$name-pool" 6432/tcp | sed 's/.*://')
export DATABASE_URL="postgres://postgres:test-password@127.0.0.1:$direct_port/postgres"
export DATABASE_POOL_URL="postgres://postgres:test-password@127.0.0.1:$pooled_port/postgres"
export DATABASE_POOL_CA_CERT
DATABASE_POOL_CA_CERT=$(cat "$fixture/server.crt")
export DATABASE_DIRECT_POOL_MAX=1 DATABASE_POOL_MAX=4
for attempt in $(seq 1 60); do
  if docker logs "$name-pool" 2>&1 | grep -q 'process up'; then break; fi
  sleep 1
done
node --test test/pg-pool-routing.test.ts
