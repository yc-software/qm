import pg, { type PoolClient } from "pg";
import type { EncryptedEnvelope, RelayRequest } from "../common/protocol.js";
import {
  digest,
  matchesDigest,
  pairingCode,
  secret,
  StoreError,
  type ClaimedPairing,
  type CreatedPairing,
  type PairingAdmission,
  type PairingRecord,
  type RelayStore,
  type RequestState,
} from "./store.js";
import { randomUUID } from "node:crypto";

interface PairingRow {
  id: string;
  code_hash: string;
  cli_token_hash: string;
  cli_public_key: string;
  expires_at: Date | string;
  device_id: string | null;
  device_name: string | null;
  edge_token_hash: string | null;
  edge_public_key: string | null;
}

interface RequestRow {
  pairing_id: string;
  request_id: string;
  request_envelope: EncryptedEnvelope;
  response_envelope: EncryptedEnvelope | null;
  expires_at: Date | string;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function pairingFromRow(row: PairingRow): PairingRecord {
  return {
    id: row.id,
    codeHash: row.code_hash,
    cliTokenHash: row.cli_token_hash,
    cliPublicKey: row.cli_public_key,
    expiresAt: iso(row.expires_at),
    ...(row.device_id ? { deviceId: row.device_id } : {}),
    ...(row.device_name ? { deviceName: row.device_name } : {}),
    ...(row.edge_token_hash ? { edgeTokenHash: row.edge_token_hash } : {}),
    ...(row.edge_public_key ? { edgePublicKey: row.edge_public_key } : {}),
  };
}

function requestState(row: RequestRow): RequestState {
  const expiresAt = iso(row.expires_at);
  if (row.response_envelope) {
    return {
      status: "responded",
      expiresAt,
      envelope: row.response_envelope,
    };
  }
  return Date.parse(expiresAt) <= Date.now() ? { status: "expired", expiresAt } : { status: "pending", expiresAt };
}

export class PostgresRelayStore implements RelayStore {
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly responseRetentionMs = 60 * 60_000,
  ) {
    this.pool = new pg.Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('inwise-relay-schema'))");
      await client.query(`
        CREATE TABLE IF NOT EXISTS inwise_pairings (
          id UUID PRIMARY KEY,
          code_hash TEXT NOT NULL UNIQUE,
          cli_token_hash TEXT NOT NULL,
          cli_public_key TEXT NOT NULL,
          source_key TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL,
          device_id UUID UNIQUE,
          device_name TEXT,
          edge_token_hash TEXT,
          edge_public_key TEXT
        );
        CREATE INDEX IF NOT EXISTS inwise_pairings_pending_idx
          ON inwise_pairings (expires_at) WHERE device_id IS NULL;
        CREATE TABLE IF NOT EXISTS inwise_pairing_rate_limits (
          source_key TEXT PRIMARY KEY,
          window_started_at TIMESTAMPTZ NOT NULL,
          count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inwise_relay_requests (
          request_id UUID PRIMARY KEY,
          pairing_id UUID NOT NULL REFERENCES inwise_pairings(id) ON DELETE CASCADE,
          device_id UUID NOT NULL,
          request_envelope JSONB NOT NULL,
          response_envelope JSONB,
          status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'responded', 'expired')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL,
          lease_until TIMESTAMPTZ,
          responded_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS inwise_relay_requests_poll_idx
          ON inwise_relay_requests (device_id, status, created_at);
      `);
      await client.query("COMMIT");
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
    await this.cleanup();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createPairing(cliPublicKey: string, ttlMs: number, admission: PairingAdmission): Promise<CreatedPairing> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('inwise-pairing-admission'))");
      await client.query("DELETE FROM inwise_pairings WHERE device_id IS NULL AND expires_at <= now()");
      await client.query(
        `DELETE FROM inwise_pairing_rate_limits
         WHERE window_started_at < now() - ($1::double precision * interval '1 millisecond')`,
        [admission.windowMs * 2],
      );
      const rate = await client.query<{ count: number; window_started_at: Date }>(
        `INSERT INTO inwise_pairing_rate_limits(source_key, window_started_at, count)
         VALUES ($1, now(), 1)
         ON CONFLICT (source_key) DO UPDATE SET
           count = CASE
             WHEN now() - inwise_pairing_rate_limits.window_started_at >=
               ($2::double precision * interval '1 millisecond') THEN 1
             ELSE inwise_pairing_rate_limits.count + 1
           END,
           window_started_at = CASE
             WHEN now() - inwise_pairing_rate_limits.window_started_at >=
               ($2::double precision * interval '1 millisecond') THEN now()
             ELSE inwise_pairing_rate_limits.window_started_at
           END
         RETURNING count, window_started_at`,
        [admission.sourceKey, admission.windowMs],
      );
      const rateRow = rate.rows[0];
      let rejection: StoreError | undefined;
      if (rateRow && rateRow.count > admission.maxPerWindow) {
        rejection = new StoreError(
          429,
          "Pairing creation rate limit exceeded",
          Math.max(0, admission.windowMs - (Date.now() - rateRow.window_started_at.getTime())),
        );
      }
      const counts = await client.query<{
        pending_source_count: string;
        pending_global_count: string;
        total_source_count: string;
        total_global_count: string;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE source_key = $1 AND device_id IS NULL AND expires_at > now()
           )::text AS pending_source_count,
           count(*) FILTER (
             WHERE device_id IS NULL AND expires_at > now()
           )::text AS pending_global_count,
           count(*) FILTER (WHERE source_key = $1)::text AS total_source_count,
           count(*)::text AS total_global_count
         FROM inwise_pairings`,
        [admission.sourceKey],
      );
      const count = counts.rows[0];
      if (
        !rejection &&
        count &&
        (Number(count.pending_source_count) >= admission.maxPendingPerSource ||
          Number(count.pending_global_count) >= admission.maxPendingGlobal ||
          Number(count.total_source_count) >= admission.maxTotalPerSource ||
          Number(count.total_global_count) >= admission.maxTotalGlobal)
      ) {
        rejection = new StoreError(429, "Pairing admission limit reached", admission.windowMs);
      }
      if (rejection) {
        await client.query("COMMIT");
        throw rejection;
      }

      const pairingId = randomUUID();
      const code = pairingCode();
      const cliToken = secret();
      const inserted = await client.query<{ expires_at: Date }>(
        `INSERT INTO inwise_pairings(
           id, code_hash, cli_token_hash, cli_public_key, source_key, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           now() + ($6::double precision * interval '1 millisecond')
         )
         RETURNING expires_at`,
        [pairingId, digest(code), digest(cliToken), cliPublicKey, admission.sourceKey, ttlMs],
      );
      await client.query("COMMIT");
      const expiresAt = inserted.rows[0]?.expires_at.toISOString();
      if (!expiresAt) throw new Error("Pairing insert did not return expiry");
      return { pairingId, code, cliToken, expiresAt };
    } catch (error) {
      if (!(error instanceof StoreError)) await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimPairing(code: string, edgePublicKey: string, deviceName: string): Promise<ClaimedPairing> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<PairingRow>(
        `SELECT * FROM inwise_pairings
         WHERE code_hash = $1 AND device_id IS NULL AND expires_at > now()
         FOR UPDATE`,
        [digest(code.toUpperCase())],
      );
      const row = result.rows[0];
      if (!row) throw new StoreError(400, "Pairing code is invalid or expired");
      const deviceId = randomUUID();
      const edgeToken = secret();
      await client.query(
        `UPDATE inwise_pairings SET
           device_id = $2, device_name = $3, edge_token_hash = $4, edge_public_key = $5
         WHERE id = $1`,
        [row.id, deviceId, deviceName, digest(edgeToken), edgePublicKey],
      );
      await client.query("COMMIT");
      return {
        pairingId: row.id,
        deviceId,
        edgeToken,
        cliPublicKey: row.cli_public_key,
      };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticateCli(pairingId: string, token: string): Promise<PairingRecord | undefined> {
    const result = await this.pool.query<PairingRow>(
      `SELECT * FROM inwise_pairings
       WHERE id = $1 AND (device_id IS NOT NULL OR expires_at > now())`,
      [pairingId],
    );
    const row = result.rows[0];
    return row && matchesDigest(token, row.cli_token_hash) ? pairingFromRow(row) : undefined;
  }

  async authenticateEdge(deviceId: string, token: string): Promise<PairingRecord | undefined> {
    const result = await this.pool.query<PairingRow>("SELECT * FROM inwise_pairings WHERE device_id = $1", [deviceId]);
    const row = result.rows[0];
    return row && matchesDigest(token, row.edge_token_hash ?? undefined) ? pairingFromRow(row) : undefined;
  }

  async enqueueRequest(deviceId: string, request: RelayRequest, ttlMs: number): Promise<RequestState> {
    await this.pool.query(
      `INSERT INTO inwise_relay_requests(
         request_id, pairing_id, device_id, request_envelope, status, expires_at
       ) VALUES ($1, $2, $3, $4::jsonb, 'queued',
         now() + ($5::double precision * interval '1 millisecond'))
       ON CONFLICT (request_id) DO NOTHING`,
      [request.requestId, request.pairingId, deviceId, JSON.stringify(request.envelope), ttlMs],
    );
    const result = await this.pool.query<RequestRow & { device_id: string }>(
      `SELECT pairing_id, request_id, device_id, request_envelope,
              response_envelope, expires_at
       FROM inwise_relay_requests WHERE request_id = $1`,
      [request.requestId],
    );
    const row = result.rows[0];
    if (!row || row.pairing_id !== request.pairingId || row.device_id !== deviceId) {
      throw new StoreError(409, "Request id is already in use");
    }
    return requestState(row);
  }

  async getRequest(pairingId: string, requestId: string): Promise<RequestState | undefined> {
    const result = await this.pool.query<RequestRow>(
      `SELECT pairing_id, request_id, request_envelope,
              response_envelope, expires_at
       FROM inwise_relay_requests
       WHERE request_id = $1 AND pairing_id = $2`,
      [requestId, pairingId],
    );
    return result.rows[0] ? requestState(result.rows[0]) : undefined;
  }

  async leaseRequest(deviceId: string, leaseMs: number): Promise<RelayRequest | undefined> {
    const result = await this.pool.query<RequestRow>(
      `WITH candidate AS (
         SELECT request_id
         FROM inwise_relay_requests
         WHERE device_id = $1
           AND response_envelope IS NULL
           AND expires_at > now()
           AND (status = 'queued' OR (status = 'leased' AND lease_until <= now()))
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE inwise_relay_requests request SET
         status = 'leased',
         lease_until = now() + ($2::double precision * interval '1 millisecond')
       FROM candidate
       WHERE request.request_id = candidate.request_id
       RETURNING request.pairing_id, request.request_id,
                 request.request_envelope, request.response_envelope,
                 request.expires_at`,
      [deviceId, leaseMs],
    );
    const row = result.rows[0];
    return row
      ? {
          pairingId: row.pairing_id,
          requestId: row.request_id,
          envelope: row.request_envelope,
        }
      : undefined;
  }

  async respond(deviceId: string, requestId: string, envelope: EncryptedEnvelope): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE inwise_relay_requests SET
         response_envelope = COALESCE(response_envelope, $3::jsonb),
         status = 'responded',
         responded_at = COALESCE(responded_at, now())
       WHERE request_id = $1 AND device_id = $2 AND expires_at > now()
       RETURNING request_id`,
      [requestId, deviceId, JSON.stringify(envelope)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async cleanup(): Promise<void> {
    await this.pool.query(
      `DELETE FROM inwise_pairings
       WHERE device_id IS NULL AND expires_at <= now()`,
    );
    await this.pool.query(
      `UPDATE inwise_relay_requests SET status = 'expired'
       WHERE response_envelope IS NULL AND expires_at <= now() AND status <> 'expired'`,
    );
    await this.pool.query(
      `DELETE FROM inwise_relay_requests
       WHERE expires_at < now() - ($1::double precision * interval '1 millisecond')`,
      [this.responseRetentionMs],
    );
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original transaction error is more useful than a rollback failure.
    }
  }
}
