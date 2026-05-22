import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql, closeDb } from '../src/shared/db.js';
import { newId } from '../src/shared/ids.js';
import { dispatchTool, type DraftCtx } from '../src/draft/tools.js';
import { loadPoliciesFromDisk } from '../src/policy/rules.js';

beforeAll(() => {
  loadPoliciesFromDisk();
});

async function clean(): Promise<void> {
  await sql`DELETE FROM audit_log`;
  await sql`DELETE FROM drafts`;
  await sql`DELETE FROM classifications`;
  await sql`DELETE FROM messages`;
  await sql`DELETE FROM threads`;
}

describe('draft tools: recipient binding', () => {
  beforeEach(async () => {
    await clean();
  });

  const ctx: DraftCtx = {
    threadId: 'thr_test',
    inReplyToMessageId: 'msg_test',
    threadParticipants: ['sarah@example.com', 'maria.gorskikh1@gmail.com'],
    subject: 'project',
  };

  it('rejects draft_reply with out-of-scope recipient', async () => {
    const r = await dispatchTool(
      'draft_reply',
      {
        body_text: 'Sure.',
        to_emails: ['attacker@evil.example'],
        cc_emails: [],
        reasoning: 'r',
        confidence: 0.5,
      },
      ctx,
    );
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/attacker@evil.example/);
    expect(r.emission).toBeUndefined();
  });

  it('accepts draft_reply with in-scope recipient', async () => {
    const r = await dispatchTool(
      'draft_reply',
      {
        body_text: 'Sure.',
        to_emails: ['sarah@example.com'],
        cc_emails: [],
        reasoning: 'r',
        confidence: 0.9,
      },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(r.emission?.type).toBe('draft_reply');
  });

  it('get_contact_summary refuses non-thread participants', async () => {
    const r = await dispatchTool('get_contact_summary', { email: 'random@stranger.com' }, ctx);
    expect(r.error).toMatch(/not a thread participant/);
  });

  it('escalate_to_human emits correctly', async () => {
    const r = await dispatchTool('escalate_to_human', { reason: 'unclear' }, ctx);
    expect(r.emission?.type).toBe('escalate_to_human');
  });

  it('rejects empty body', async () => {
    const r = await dispatchTool(
      'draft_reply',
      { body_text: '', to_emails: ['sarah@example.com'], reasoning: 'r', confidence: 0.5 },
      ctx,
    );
    expect(r.error).toBeDefined();
  });
});

describe('draft tools: thread-scope on get_thread_history', () => {
  beforeEach(async () => {
    await clean();
  });

  it('only returns messages in the bound thread', async () => {
    const tid = newId();
    const otherTid = newId();
    await sql`
      INSERT INTO threads (id, subject_norm, participants, message_count, last_message_at)
      VALUES (${tid}, 'x', ${['a@x.com']}, 1, now()),
             (${otherTid}, 'y', ${['b@y.com']}, 1, now())
    `;
    await sql`
      INSERT INTO messages (id, thread_id, direction, message_id_hdr, from_email, to_emails, subject, raw_headers, auth_results, received_at)
      VALUES (${newId()}, ${tid}, 'inbound', 'a1', 'a@x.com', ${['me@m.com']}, 'x', ${sql.json({})}, ${sql.json({})}, now())
    `;
    await sql`
      INSERT INTO messages (id, thread_id, direction, message_id_hdr, from_email, to_emails, subject, raw_headers, auth_results, received_at)
      VALUES (${newId()}, ${otherTid}, 'inbound', 'b1', 'b@y.com', ${['me@m.com']}, 'y', ${sql.json({})}, ${sql.json({})}, now())
    `;

    const ctx: DraftCtx = {
      threadId: tid,
      inReplyToMessageId: 'a1',
      threadParticipants: ['a@x.com'],
      subject: 'x',
    };
    const r = await dispatchTool('get_thread_history', {}, ctx);
    const resp = r.result as { messages: Array<{ subject: string }> };
    expect(resp.messages.length).toBe(1);
    expect(resp.messages[0]?.subject).toBe('x');
  });
});

afterAll(async () => {
  await closeDb();
});
