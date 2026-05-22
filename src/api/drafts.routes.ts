import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { sql } from '../shared/db.js';
import { env } from '../shared/env.js';
import { logger } from '../shared/log.js';
import { queues } from '../shared/queue.js';
import type { DraftRow } from '../shared/types.js';

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function registerDraftRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/drafts', async (req) => {
    const q = z
      .object({
        status: z.string().default('pending'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});
    const rows = await sql<DraftRow[]>`
      SELECT * FROM drafts WHERE status = ${q.status}
      ORDER BY created_at DESC
      LIMIT ${q.limit}
    `;
    return { drafts: rows };
  });

  app.get('/api/drafts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rows = await sql<DraftRow[]>`SELECT * FROM drafts WHERE id = ${id} LIMIT 1`;
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return { draft: rows[0] };
  });

  app.post('/api/drafts/:id/approve', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ edited_body: z.string().max(8000).optional() })
      .parse(req.body ?? {});

    const rows = await sql<DraftRow[]>`SELECT * FROM drafts WHERE id = ${id} LIMIT 1`;
    const draft = rows[0];
    if (!draft) return reply.code(404).send({ error: 'not found' });
    if (draft.status !== 'pending') {
      return reply.code(409).send({ error: `draft is ${draft.status}, not pending` });
    }

    const sendAt = new Date(Date.now() + env.DELAYED_SEND_SECONDS * 1000);
    const effectiveBody = body.edited_body ?? draft.body_text;

    // Enqueue delayed send
    const job = await queues.outbound.add(
      'send',
      { draftId: id, approvedBodyHash: hash(effectiveBody) },
      {
        delay: env.DELAYED_SEND_SECONDS * 1000,
        jobId: `send-${id}`,
      },
    );

    await sql`
      UPDATE drafts
      SET status = 'approved',
          decided_at = now(),
          decided_by = 'user',
          send_at = ${sendAt},
          edited_body = ${body.edited_body ?? null},
          outbound_job_id = ${job.id ?? null}
      WHERE id = ${id}
    `;

    await audit({
      actor: 'user',
      action: 'approve_draft',
      threadId: draft.thread_id,
      draftId: id,
      payload: { sendAt: sendAt.toISOString(), edited: !!body.edited_body },
      outcome: 'ok',
    });

    logger.info({ draftId: id, sendAt }, 'draft approved, send scheduled');
    return { ok: true, send_at: sendAt.toISOString(), undo_window_seconds: env.DELAYED_SEND_SECONDS };
  });

  app.post('/api/drafts/:id/reject', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    const rows = await sql<DraftRow[]>`SELECT * FROM drafts WHERE id = ${id} LIMIT 1`;
    const draft = rows[0];
    if (!draft) return reply.code(404).send({ error: 'not found' });
    if (draft.status !== 'pending') {
      return reply.code(409).send({ error: `draft is ${draft.status}, not pending` });
    }
    await sql`
      UPDATE drafts SET status = 'rejected', decided_at = now(), decided_by = 'user'
      WHERE id = ${id}
    `;
    await audit({
      actor: 'user',
      action: 'reject_draft',
      threadId: draft.thread_id,
      draftId: id,
      payload: { reason: body.reason ?? '' },
      outcome: 'ok',
    });
    return { ok: true };
  });

  app.post('/api/drafts/:id/undo', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rows = await sql<DraftRow[]>`SELECT * FROM drafts WHERE id = ${id} LIMIT 1`;
    const draft = rows[0];
    if (!draft) return reply.code(404).send({ error: 'not found' });
    if (draft.status !== 'approved') {
      return reply.code(409).send({ error: `draft is ${draft.status}, cannot undo` });
    }
    if (!draft.send_at || draft.send_at <= new Date()) {
      return reply.code(409).send({ error: 'undo window expired' });
    }
    // Try removing the job
    const jobId = `send-${id}`;
    try {
      const job = await queues.outbound.getJob(jobId);
      if (job) await job.remove();
    } catch (err) {
      logger.warn({ err }, 'undo: failed to remove queue job (continuing)');
    }
    await sql`
      UPDATE drafts SET status = 'superseded', decided_at = now() WHERE id = ${id}
    `;
    await audit({
      actor: 'user',
      action: 'undo_draft',
      threadId: draft.thread_id,
      draftId: id,
      payload: {},
      outcome: 'ok',
    });
    return { ok: true };
  });
}
