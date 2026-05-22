import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql, closeDb } from '../src/shared/db.js';
import { PostmarkInboundSchema } from '../src/edge/postmark.schema.js';
import { ingestOne } from '../src/ingest/ingest.worker.js';

// We don't want classify auto-enqueue in tests, but ingestOne calls queues.classify.
// We mock the queue module to make .add a no-op.
vi.mock('../src/shared/queue.js', async () => {
  const noop = () => Promise.resolve({ id: 'x' });
  return {
    queues: {
      ingest: { add: noop },
      classify: { add: noop },
      route: { add: noop },
      draft: { add: noop },
      outbound: { add: noop, getJob: () => Promise.resolve(null) },
      autoAction: { add: noop },
    },
    QUEUE_NAMES: { ingest: 'ingest', classify: 'classify', route: 'route', draft: 'draft', outbound: 'outbound', autoAction: 'auto-action' },
    getQueue: () => ({ add: noop }),
    makeWorker: () => ({ close: () => Promise.resolve(), on: () => {} }),
    closeAll: () => Promise.resolve(),
    connection: {},
  };
});

async function clean(): Promise<void> {
  await sql`DELETE FROM audit_log`;
  await sql`DELETE FROM drafts`;
  await sql`DELETE FROM classifications`;
  await sql`DELETE FROM attachments`;
  await sql`DELETE FROM messages`;
  await sql`DELETE FROM threads`;
}

function loadFixture(name: string): unknown {
  const p = resolve(process.cwd(), `test/fixtures/${name}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

beforeAll(async () => {
  await clean();
});

beforeEach(async () => {
  await clean();
});

describe('ingestOne', () => {
  it('persists a human reply and creates a thread', async () => {
    const payload = PostmarkInboundSchema.parse(loadFixture('postmark.inbound.json'));
    const r = await ingestOne(payload);
    expect(r).not.toBeNull();
    const msgs = await sql`SELECT * FROM messages`;
    expect(msgs.length).toBe(1);
    const threads = await sql`SELECT * FROM threads`;
    expect(threads.length).toBe(1);
  });

  it('dedupes by message_id_hdr', async () => {
    const payload = PostmarkInboundSchema.parse(loadFixture('postmark.inbound.json'));
    await ingestOne(payload);
    const second = await ingestOne(payload);
    expect(second).toBeNull();
    const msgs = await sql`SELECT * FROM messages`;
    expect(msgs.length).toBe(1);
  });

  it('upserts contacts for from + to', async () => {
    const payload = PostmarkInboundSchema.parse(loadFixture('postmark.inbound.json'));
    await ingestOne(payload);
    const c = await sql<{ email: string }[]>`SELECT email FROM contacts ORDER BY email`;
    const emails = c.map((r) => r.email.toLowerCase());
    expect(emails).toContain('sarah@example-company.com');
    expect(emails).toContain('maria.gorskikh1@gmail.com');
  });
});

afterAll(async () => {
  await closeDb();
});
