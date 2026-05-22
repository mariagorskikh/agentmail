import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql, closeDb } from '../src/shared/db.js';
import { newId } from '../src/shared/ids.js';
import { normalizeSubject, resolveOrCreateThread } from '../src/ingest/threading.js';

async function clean(): Promise<void> {
  // Wipe in dep order
  await sql`DELETE FROM audit_log`;
  await sql`DELETE FROM drafts`;
  await sql`DELETE FROM classifications`;
  await sql`DELETE FROM attachments`;
  await sql`DELETE FROM messages`;
  await sql`DELETE FROM threads`;
}

async function insertMessage(opts: {
  threadId: string;
  messageIdHdr: string;
  inReplyTo?: string | null;
  references?: string[];
  subject: string;
  fromEmail: string;
  toEmails: string[];
  receivedAt: Date;
}): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO messages (
      id, thread_id, direction, message_id_hdr, in_reply_to, references_hdr,
      from_email, from_name, to_emails, cc_emails, bcc_emails,
      subject, text_body, html_body, raw_headers, auth_results, received_at
    ) VALUES (
      ${id}, ${opts.threadId}, 'inbound', ${opts.messageIdHdr},
      ${opts.inReplyTo ?? null}, ${opts.references ?? []},
      ${opts.fromEmail}, null, ${opts.toEmails}, ${'{}'}, ${'{}'},
      ${opts.subject}, null, null, ${sql.json({})}, ${sql.json({})}, ${opts.receivedAt}
    )
  `;
  return id;
}

describe('normalizeSubject', () => {
  it('strips Re:/Fwd:/Aw:', () => {
    expect(normalizeSubject('Re: hello')).toBe('hello');
    expect(normalizeSubject('Fwd: hello')).toBe('hello');
    expect(normalizeSubject('Aw: hello')).toBe('hello');
  });
  it('collapses repeated prefixes', () => {
    expect(normalizeSubject('Re: Re: Re: hello')).toBe('hello');
    expect(normalizeSubject('Fwd: Re: hello')).toBe('hello');
  });
  it('strips list prefixes', () => {
    expect(normalizeSubject('[list] Re: hello')).toBe('hello');
    expect(normalizeSubject('Re: [list] hello')).toBe('hello');
  });
  it('lowercases and collapses whitespace', () => {
    expect(normalizeSubject('  HELLO   World  ')).toBe('hello world');
  });
  it('returns empty for empty', () => {
    expect(normalizeSubject('')).toBe('');
  });
});

describe('resolveOrCreateThread', () => {
  beforeEach(async () => {
    await clean();
  });

  it('creates a new thread when no match', async () => {
    const r = await sql.begin(async (tx) =>
      resolveOrCreateThread(tx, {
        messageIdHdr: 'msg-1@x',
        inReplyTo: null,
        references: [],
        subject: 'hello',
        participants: ['a@x.com', 'b@x.com'],
        receivedAt: new Date(),
      }),
    );
    expect(r.created).toBe(true);
    expect(r.matchedBy).toBe('new');
  });

  it('strong-matches via in-reply-to', async () => {
    // create a thread with one message
    const tid = newId();
    await sql`
      INSERT INTO threads (id, subject_norm, participants, message_count, last_message_at)
      VALUES (${tid}, 'hello', ${['a@x.com', 'b@x.com']}, 1, now())
    `;
    await insertMessage({
      threadId: tid,
      messageIdHdr: 'msg-1@x',
      subject: 'hello',
      fromEmail: 'a@x.com',
      toEmails: ['b@x.com'],
      receivedAt: new Date(),
    });

    const r = await sql.begin(async (tx) =>
      resolveOrCreateThread(tx, {
        messageIdHdr: 'msg-2@x',
        inReplyTo: 'msg-1@x',
        references: ['msg-1@x'],
        subject: 'Re: changed subject',
        participants: ['a@x.com', 'b@x.com'],
        receivedAt: new Date(),
      }),
    );
    expect(r.threadId).toBe(tid);
    expect(r.matchedBy).toBe('in_reply_to');
  });

  it('matches via references chain when in-reply-to missing', async () => {
    const tid = newId();
    await sql`
      INSERT INTO threads (id, subject_norm, participants, message_count, last_message_at)
      VALUES (${tid}, 'hello', ${['a@x.com', 'b@x.com']}, 1, now())
    `;
    await insertMessage({
      threadId: tid,
      messageIdHdr: 'root@x',
      subject: 'hello',
      fromEmail: 'a@x.com',
      toEmails: ['b@x.com'],
      receivedAt: new Date(),
    });

    const r = await sql.begin(async (tx) =>
      resolveOrCreateThread(tx, {
        messageIdHdr: 'msg-new@x',
        inReplyTo: 'unknown@x',
        references: ['unknown@x', 'root@x'],
        subject: 'Re: hello',
        participants: ['a@x.com', 'b@x.com'],
        receivedAt: new Date(),
      }),
    );
    expect(r.threadId).toBe(tid);
    expect(r.matchedBy).toBe('references');
  });

  it('matches via subject + participants when refs absent', async () => {
    const tid = newId();
    await sql`
      INSERT INTO threads (id, subject_norm, participants, message_count, last_message_at)
      VALUES (${tid}, 'hello world', ${['a@x.com', 'b@x.com']}, 1, now() - interval '1 day')
    `;

    const r = await sql.begin(async (tx) =>
      resolveOrCreateThread(tx, {
        messageIdHdr: 'msg-z@x',
        inReplyTo: null,
        references: [],
        subject: 'Re: hello world',
        participants: ['a@x.com', 'b@x.com'],
        receivedAt: new Date(),
      }),
    );
    expect(r.threadId).toBe(tid);
    expect(r.matchedBy).toBe('subject_participants');
  });

  it('does NOT merge when same subject but participants disjoint', async () => {
    const tid = newId();
    await sql`
      INSERT INTO threads (id, subject_norm, participants, message_count, last_message_at)
      VALUES (${tid}, 'hello world', ${['a@x.com', 'b@x.com']}, 1, now())
    `;
    const r = await sql.begin(async (tx) =>
      resolveOrCreateThread(tx, {
        messageIdHdr: 'msg-z2@x',
        inReplyTo: null,
        references: [],
        subject: 'Re: hello world',
        participants: ['c@x.com', 'd@x.com'],
        receivedAt: new Date(),
      }),
    );
    expect(r.threadId).not.toBe(tid);
    expect(r.matchedBy).toBe('new');
  });

  it('does NOT merge subject match older than 14 days', async () => {
    const tid = newId();
    await sql`
      INSERT INTO threads (id, subject_norm, participants, message_count, last_message_at)
      VALUES (${tid}, 'hello', ${['a@x.com', 'b@x.com']}, 1, now() - interval '30 days')
    `;
    const r = await sql.begin(async (tx) =>
      resolveOrCreateThread(tx, {
        messageIdHdr: 'msg-old@x',
        inReplyTo: null,
        references: [],
        subject: 'Re: hello',
        participants: ['a@x.com', 'b@x.com'],
        receivedAt: new Date(),
      }),
    );
    expect(r.matchedBy).toBe('new');
  });

  it('updates message_count and participants on attach', async () => {
    const tid = newId();
    await sql`
      INSERT INTO threads (id, subject_norm, participants, message_count, last_message_at)
      VALUES (${tid}, 'hello', ${['a@x.com']}, 1, now())
    `;
    await insertMessage({
      threadId: tid,
      messageIdHdr: 'root@x',
      subject: 'hello',
      fromEmail: 'a@x.com',
      toEmails: ['b@x.com'],
      receivedAt: new Date(),
    });
    await sql.begin(async (tx) =>
      resolveOrCreateThread(tx, {
        messageIdHdr: 'reply@x',
        inReplyTo: 'root@x',
        references: ['root@x'],
        subject: 'Re: hello',
        participants: ['a@x.com', 'c@x.com'],
        receivedAt: new Date(),
      }),
    );
    const rows = await sql<{ message_count: number; participants: string[] }[]>`
      SELECT message_count, participants FROM threads WHERE id = ${tid}
    `;
    expect(rows[0]?.message_count).toBe(2);
    expect(rows[0]?.participants).toContain('c@x.com');
  });
});

afterAll(async () => {
  await closeDb();
});
