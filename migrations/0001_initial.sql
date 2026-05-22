-- Up Migration
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE contacts (
  id            TEXT PRIMARY KEY,
  email         CITEXT NOT NULL UNIQUE,
  display_name  TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  trust_level   TEXT NOT NULL DEFAULT 'unknown'
    CHECK (trust_level IN ('blocked','unknown','known','vip','self')),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX contacts_last_seen_idx ON contacts (last_seen_at DESC);

CREATE TABLE threads (
  id              TEXT PRIMARY KEY,
  subject_norm    TEXT NOT NULL,
  participants    TEXT[] NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','awaiting_reply','snoozed','resolved','archived','quarantined')),
  current_lane    SMALLINT,
  snoozed_until   TIMESTAMPTZ,
  message_count   INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX threads_last_message_idx ON threads (last_message_at DESC);
CREATE INDEX threads_status_idx ON threads (status) WHERE status != 'archived';
CREATE INDEX threads_participants_gin ON threads USING GIN (participants);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_id_hdr  TEXT NOT NULL,
  in_reply_to     TEXT,
  references_hdr  TEXT[],
  from_email      CITEXT NOT NULL,
  from_name       TEXT,
  to_emails       CITEXT[] NOT NULL,
  cc_emails       CITEXT[] NOT NULL DEFAULT '{}',
  bcc_emails      CITEXT[] NOT NULL DEFAULT '{}',
  subject         TEXT NOT NULL,
  text_body       TEXT,
  html_body       TEXT,
  raw_headers     JSONB NOT NULL,
  auth_results    JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id_hdr)
);
CREATE INDEX messages_thread_idx ON messages (thread_id, received_at);
CREATE INDEX messages_from_idx ON messages (from_email);

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_idx ON attachments (message_id);

CREATE TABLE classifications (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE UNIQUE,
  trust          TEXT NOT NULL CHECK (trust IN ('high','medium','low','hostile')),
  sender_class   TEXT NOT NULL CHECK (sender_class IN
                  ('transactional','marketing','cold_outreach','human','phishing','automated_other')),
  intent         TEXT NOT NULL CHECK (intent IN
                  ('fyi','response_needed','action_needed','decision_needed',
                   'scheduling','verification','social','unclear')),
  urgency        SMALLINT NOT NULL CHECK (urgency BETWEEN 0 AND 5),
  recommended_lane SMALLINT NOT NULL CHECK (recommended_lane BETWEEN 1 AND 5),
  entities       JSONB NOT NULL DEFAULT '{}'::jsonb,
  reasoning      TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE drafts (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  in_reply_to_id TEXT NOT NULL REFERENCES messages(id),
  to_emails      CITEXT[] NOT NULL,
  cc_emails      CITEXT[] NOT NULL DEFAULT '{}',
  subject        TEXT NOT NULL,
  body_text      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','sent','superseded','expired')),
  agent_reasoning TEXT NOT NULL,
  agent_confidence REAL NOT NULL CHECK (agent_confidence BETWEEN 0 AND 1),
  tool_calls     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ,
  decided_by     TEXT,
  send_at        TIMESTAMPTZ,
  edited_body    TEXT,
  outbound_job_id TEXT,
  requires_extra_confirmation BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX drafts_status_idx ON drafts (status, created_at DESC);
CREATE INDEX drafts_thread_idx ON drafts (thread_id);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  thread_id   TEXT REFERENCES threads(id),
  message_id  TEXT REFERENCES messages(id),
  draft_id    TEXT REFERENCES drafts(id),
  payload     JSONB NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok','blocked','error')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_thread_idx ON audit_log (thread_id, created_at DESC);
CREATE INDEX audit_action_idx ON audit_log (action, created_at DESC);

CREATE TABLE policies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  body        JSONB NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  loaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outbound_counters (
  bucket      TEXT PRIMARY KEY,
  count       INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
