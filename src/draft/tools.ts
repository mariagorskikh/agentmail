import { sql } from '../shared/db.js';
import { env } from '../shared/env.js';
import type { MessageRow, ThreadRow } from '../shared/types.js';

export interface DraftCtx {
  threadId: string;
  inReplyToMessageId: string;
  threadParticipants: string[]; // lowercased, includes from + to + cc of recent inbound
  subject: string;
}

export const draftToolDefs = [
  {
    name: 'get_thread_history',
    description:
      'Returns up to the last 10 messages in the current thread (the only thread you may access). ' +
      'Use this to understand context before drafting.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_contact_summary',
    description:
      'Returns what we know about a participant in the current thread. ' +
      'You may NOT query arbitrary email addresses — only those already in this thread.',
    input_schema: {
      type: 'object' as const,
      properties: { email: { type: 'string' as const } },
      required: ['email'],
    },
  },
  {
    name: 'search_past_threads',
    description:
      "Search the user's prior conversations for context. Read-only.",
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string' as const, maxLength: 200 } },
      required: ['query'],
    },
  },
  {
    name: 'draft_reply',
    description:
      'Emit your final draft reply. This does NOT send the message — it queues it for the user\'s approval. ' +
      'You may only set to/cc to participants already in this thread.',
    input_schema: {
      type: 'object' as const,
      properties: {
        body_text: { type: 'string' as const, maxLength: 8000 },
        to_emails: { type: 'array' as const, items: { type: 'string' as const } },
        cc_emails: { type: 'array' as const, items: { type: 'string' as const } },
        reasoning: { type: 'string' as const, maxLength: 500 },
        confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
      },
      required: ['body_text', 'to_emails', 'reasoning', 'confidence'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'If you cannot or should not draft this reply (sensitive content, missing information, ambiguous intent), ' +
      'call this instead of draft_reply.',
    input_schema: {
      type: 'object' as const,
      properties: { reason: { type: 'string' as const, maxLength: 500 } },
      required: ['reason'],
    },
  },
];

export interface DraftEmission {
  type: 'draft_reply';
  body_text: string;
  to_emails: string[];
  cc_emails: string[];
  reasoning: string;
  confidence: number;
}

export interface EscalateEmission {
  type: 'escalate_to_human';
  reason: string;
}

export type ToolEmission = DraftEmission | EscalateEmission;

export interface ToolResult {
  result?: unknown;
  emission?: ToolEmission;
  error?: string;
}

function ensureInScope(emails: string[], ctx: DraftCtx): string | null {
  const allowed = new Set([...ctx.threadParticipants, env.OWNER_EMAIL].map((e) => e.toLowerCase()));
  for (const e of emails) {
    if (!allowed.has(e.toLowerCase())) return e;
  }
  return null;
}

export async function dispatchTool(
  name: string,
  input: unknown,
  ctx: DraftCtx,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_thread_history': {
        const rows = await sql<MessageRow[]>`
          SELECT * FROM messages
          WHERE thread_id = ${ctx.threadId}
          ORDER BY received_at DESC
          LIMIT 10
        `;
        const summarized = rows.map((r) => ({
          direction: r.direction,
          from: `${r.from_name ?? ''} <${r.from_email}>`,
          to: r.to_emails,
          subject: r.subject,
          received_at: r.received_at,
          text_excerpt: (r.text_body ?? '').slice(0, 2000),
        }));
        return { result: { messages: summarized.reverse() } };
      }
      case 'get_contact_summary': {
        const args = input as { email?: string };
        if (!args.email) return { error: 'email required' };
        if (!ctx.threadParticipants.map((e) => e.toLowerCase()).includes(args.email.toLowerCase())) {
          return { error: 'email not a thread participant' };
        }
        const rows = await sql<{
          email: string;
          display_name: string | null;
          trust_level: string;
          metadata: unknown;
          last_seen_at: Date;
        }[]>`
          SELECT email, display_name, trust_level, metadata, last_seen_at
          FROM contacts WHERE email = ${args.email} LIMIT 1
        `;
        if (rows.length === 0 || !rows[0]) return { result: { found: false } };
        return { result: { found: true, ...rows[0] } };
      }
      case 'search_past_threads': {
        const args = input as { query?: string };
        const q = (args.query ?? '').trim();
        if (!q) return { result: { matches: [] } };
        const rows = await sql<{ id: string; subject_norm: string; last_message_at: Date }[]>`
          SELECT t.id, t.subject_norm, t.last_message_at
          FROM threads t
          JOIN messages m ON m.thread_id = t.id
          WHERE m.text_body ILIKE ${'%' + q + '%'}
            AND t.id <> ${ctx.threadId}
          GROUP BY t.id
          ORDER BY t.last_message_at DESC
          LIMIT 5
        `;
        return { result: { matches: rows } };
      }
      case 'draft_reply': {
        const args = input as {
          body_text?: string;
          to_emails?: string[];
          cc_emails?: string[];
          reasoning?: string;
          confidence?: number;
        };
        const toEmails = args.to_emails ?? [];
        const ccEmails = args.cc_emails ?? [];
        const offending = ensureInScope([...toEmails, ...ccEmails], ctx);
        if (offending) {
          return { error: `recipient ${offending} not in thread participants — cannot draft to it` };
        }
        if (!args.body_text || args.body_text.length === 0) {
          return { error: 'body_text required' };
        }
        if (args.body_text.length > 8000) {
          return { error: 'body_text exceeds 8000 chars' };
        }
        return {
          emission: {
            type: 'draft_reply',
            body_text: args.body_text,
            to_emails: toEmails,
            cc_emails: ccEmails,
            reasoning: args.reasoning ?? '',
            confidence: typeof args.confidence === 'number' ? args.confidence : 0.5,
          },
          result: { ok: true, message: 'draft queued for user approval' },
        };
      }
      case 'escalate_to_human': {
        const args = input as { reason?: string };
        return {
          emission: {
            type: 'escalate_to_human',
            reason: args.reason ?? 'agent escalated without explicit reason',
          },
          result: { ok: true, message: 'escalation recorded' },
        };
      }
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function loadDraftCtx(messageId: string): Promise<DraftCtx | null> {
  const msgRows = await sql<MessageRow[]>`
    SELECT * FROM messages WHERE id = ${messageId} LIMIT 1
  `;
  const msg = msgRows[0];
  if (!msg) return null;
  const threadRows = await sql<ThreadRow[]>`
    SELECT * FROM threads WHERE id = ${msg.thread_id} LIMIT 1
  `;
  const thread = threadRows[0];
  if (!thread) return null;
  // participants for the reply: thread participants minus our own owner address
  const participants = thread.participants
    .map((p) => p.toLowerCase())
    .filter((p) => p !== env.OWNER_EMAIL.toLowerCase());
  return {
    threadId: thread.id,
    inReplyToMessageId: msg.id,
    threadParticipants: participants,
    subject: msg.subject,
  };
}
