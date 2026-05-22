-- Up Migration
-- Agent identity layer. Lets external agents send structured messages
-- into this mailbox without going through SMTP.

CREATE TABLE agents (
  id             TEXT PRIMARY KEY,             -- ULID
  agent_id       TEXT NOT NULL UNIQUE,         -- public slug, e.g. 'acme-scheduler'
  display_name   TEXT NOT NULL,
  operator_email CITEXT,                       -- owner of the agent (optional)
  key_hash       TEXT NOT NULL,                -- SHA-256(secret) — never store raw
  key_prefix     TEXT NOT NULL,                -- first 8 chars of secret for display
  trust_level    TEXT NOT NULL DEFAULT 'unknown'
    CHECK (trust_level IN ('blocked','unknown','known','trusted','partner')),
  scopes         TEXT[] NOT NULL DEFAULT '{messages:send}',
  rate_per_hour  INT NOT NULL DEFAULT 30,
  rate_per_day   INT NOT NULL DEFAULT 200,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);
CREATE INDEX agents_agent_id_idx ON agents (agent_id) WHERE revoked_at IS NULL;
CREATE INDEX agents_created_idx ON agents (created_at DESC);

-- Per-agent rate counters (sliding window).
CREATE TABLE agent_counters (
  bucket      TEXT PRIMARY KEY,                -- 'agent:<id>:hour:<iso>' or :day:
  count       INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tag messages with the originating agent_id (NULL for SMTP / human senders).
ALTER TABLE messages ADD COLUMN agent_id TEXT REFERENCES agents(agent_id);
CREATE INDEX messages_agent_idx ON messages (agent_id) WHERE agent_id IS NOT NULL;
