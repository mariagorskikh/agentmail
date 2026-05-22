import type postgres from 'postgres';
import { newId } from '../shared/ids.js';

type AnySql = postgres.Sql<Record<string, unknown>> | postgres.TransactionSql<Record<string, unknown>>;

const SUBJECT_PREFIX = /^\s*(re|fw|fwd|aw|sv|tr)\s*(\[\d+\])?\s*:\s*/i;
const LIST_PREFIX = /^\s*\[[^\]]+\]\s*/;
export function normalizeSubject(subject: string): string {
  let s = subject ?? '';
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(SUBJECT_PREFIX, '');
    s = s.replace(LIST_PREFIX, '');
  }
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface ThreadAttachInput {
  messageIdHdr: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  participants: string[]; // emails involved in this message (from + to + cc), lowercased
  receivedAt: Date;
}

export interface ThreadResult {
  threadId: string;
  created: boolean;
  matchedBy: 'in_reply_to' | 'references' | 'subject_participants' | 'new';
}

// Resolves or creates a thread. Caller is expected to be inside a transaction.
export async function resolveOrCreateThread(
  tx: AnySql,
  input: ThreadAttachInput,
): Promise<ThreadResult> {
  // 1) Strong match: in_reply_to
  if (input.inReplyTo) {
    const rows = await tx<{ thread_id: string }[]>`
      SELECT thread_id FROM messages WHERE message_id_hdr = ${input.inReplyTo} LIMIT 1
    `;
    if (rows.length > 0 && rows[0]) {
      const id = rows[0].thread_id;
      await updateThreadOnAttach(tx, id, input);
      return { threadId: id, created: false, matchedBy: 'in_reply_to' };
    }
  }
  // 2) References chain
  if (input.references.length > 0) {
    const rows = await tx<{ thread_id: string }[]>`
      SELECT thread_id FROM messages
      WHERE message_id_hdr = ANY(${input.references})
      ORDER BY received_at DESC
      LIMIT 1
    `;
    if (rows.length > 0 && rows[0]) {
      const id = rows[0].thread_id;
      await updateThreadOnAttach(tx, id, input);
      return { threadId: id, created: false, matchedBy: 'references' };
    }
  }
  // 3) Subject + participants within last 14 days
  const subjectNorm = normalizeSubject(input.subject);
  if (subjectNorm) {
    const rows = await tx<{ id: string; participants: string[] }[]>`
      SELECT id, participants FROM threads
      WHERE subject_norm = ${subjectNorm}
        AND last_message_at > now() - interval '14 days'
        AND participants && ${input.participants}::text[]
      ORDER BY last_message_at DESC
      LIMIT 1
    `;
    if (rows.length > 0 && rows[0]) {
      const id = rows[0].id;
      await updateThreadOnAttach(tx, id, input);
      return { threadId: id, created: false, matchedBy: 'subject_participants' };
    }
  }
  // 4) New thread
  const newThreadId = newId();
  const sortedParticipants = [...new Set(input.participants.map((p) => p.toLowerCase()))].sort();
  await tx`
    INSERT INTO threads (
      id, subject_norm, participants, status, message_count, last_message_at, created_at, updated_at
    ) VALUES (
      ${newThreadId},
      ${subjectNorm || '(no subject)'},
      ${sortedParticipants},
      'open',
      0,
      ${input.receivedAt},
      now(),
      now()
    )
  `;
  await updateThreadOnAttach(tx, newThreadId, input);
  return { threadId: newThreadId, created: true, matchedBy: 'new' };
}

async function updateThreadOnAttach(
  tx: AnySql,
  threadId: string,
  input: ThreadAttachInput,
): Promise<void> {
  // Increment message_count, last_message_at, union participants
  await tx`
    UPDATE threads
    SET
      message_count = message_count + 1,
      last_message_at = GREATEST(last_message_at, ${input.receivedAt}),
      participants = (
        SELECT ARRAY(SELECT DISTINCT unnest(participants || ${input.participants}::text[]) ORDER BY 1)
      ),
      updated_at = now()
    WHERE id = ${threadId}
  `;
}
