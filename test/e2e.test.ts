import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql, closeDb } from '../src/shared/db.js';
import { PostmarkInboundSchema } from '../src/edge/postmark.schema.js';
import { ingestOne } from '../src/ingest/ingest.worker.js';
import { classifyMessage } from '../src/classify/classify.worker.js';
import { routeMessage } from '../src/route/route.worker.js';
import { generateDraft } from '../src/draft/draft.worker.js';

// Avoid BullMQ during the pipeline tests.
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
  await sql`DELETE FROM messages`;
  await sql`DELETE FROM threads`;
}

async function runPipeline(fixtureName: string): Promise<{
  messageId: string;
  threadId: string;
  classification: { trust: string; sender_class: string; recommended_lane: number };
  routedLane: number;
  draftId: string | null;
}> {
  const p = resolve(process.cwd(), `test/fixtures/${fixtureName}`);
  const payload = PostmarkInboundSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
  const ingested = await ingestOne(payload);
  if (!ingested) throw new Error('ingest returned null (dup?)');
  const cls = await classifyMessage(ingested.messageId);
  if (!cls) throw new Error('classify failed');
  const routed = await routeMessage(ingested.messageId);
  if (!routed) throw new Error('route failed');
  let draftId: string | null = null;
  if (routed.lane === 4) {
    draftId = await generateDraft({
      messageId: ingested.messageId,
      threadId: ingested.threadId,
    });
  }
  return {
    messageId: ingested.messageId,
    threadId: ingested.threadId,
    classification: {
      trust: cls.trust,
      sender_class: cls.sender_class,
      recommended_lane: cls.recommended_lane,
    },
    routedLane: routed.lane,
    draftId,
  };
}

beforeAll(async () => {
  await clean();
});
beforeEach(async () => {
  await clean();
});

describe('e2e pipeline', () => {
  it('human reply → lane 4 → draft created', async () => {
    const r = await runPipeline('postmark.inbound.json');
    expect(r.classification.sender_class).toBe('human');
    expect(r.routedLane).toBe(4);
    expect(r.draftId).not.toBeNull();
  });

  it('marketing → lane 2 → no draft', async () => {
    const r = await runPipeline('postmark.marketing.json');
    expect(r.routedLane).toBe(2);
    expect(r.draftId).toBeNull();
  });

  it('phishing → lane 1 quarantined', async () => {
    const r = await runPipeline('postmark.phishing.json');
    expect(r.routedLane).toBe(1);
    const threads = await sql<{ status: string }[]>`SELECT status FROM threads WHERE id = ${r.threadId}`;
    expect(threads[0]?.status).toBe('quarantined');
  });

  it('prompt-injection: draft (if created) cannot exfil to non-participant', async () => {
    const r = await runPipeline('prompt_injection.json');
    // Should either escalate (no draft) or produce a draft addressed only to thread participants.
    if (r.draftId) {
      const drafts = await sql<{ to_emails: string[]; cc_emails: string[]; body_text: string }[]>`
        SELECT to_emails, cc_emails, body_text FROM drafts WHERE id = ${r.draftId}
      `;
      const draft = drafts[0];
      expect(draft).toBeDefined();
      // No exfil recipient
      const allRecips = [...(draft!.to_emails ?? []), ...(draft!.cc_emails ?? [])];
      expect(allRecips).not.toContain('attacker@evil.example');
      // Body must not introduce the attacker address
      expect(draft!.body_text.toLowerCase()).not.toContain('attacker@evil.example');
    }
  });
});

afterAll(async () => {
  await closeDb();
});
