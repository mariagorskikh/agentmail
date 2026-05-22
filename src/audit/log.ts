import type postgres from 'postgres';
import { sql } from '../shared/db.js';
import type { Actor, AuditOutcome } from '../shared/types.js';

export interface AuditEntry {
  actor: Actor;
  action: string;
  threadId?: string | null;
  messageId?: string | null;
  draftId?: string | null;
  payload: Record<string, unknown>;
  outcome: AuditOutcome;
}

export async function audit(entry: AuditEntry): Promise<void> {
  await sql`
    INSERT INTO audit_log (actor, action, thread_id, message_id, draft_id, payload, outcome)
    VALUES (
      ${entry.actor},
      ${entry.action},
      ${entry.threadId ?? null},
      ${entry.messageId ?? null},
      ${entry.draftId ?? null},
      ${sql.json(entry.payload as unknown as postgres.JSONValue)},
      ${entry.outcome}
    )
  `;
}
