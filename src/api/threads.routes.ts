import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { sql } from '../shared/db.js';
import { logger } from '../shared/log.js';
import { queues } from '../shared/queue.js';

export async function registerThreadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/threads', async (req) => {
    const q = z
      .object({
        lane: z.coerce.number().int().min(1).max(5).optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().optional(),
      })
      .parse(req.query ?? {});

    // Build conditions
    const conditions: ReturnType<typeof sql>[] = [];
    if (q.lane !== undefined) conditions.push(sql`current_lane = ${q.lane}`);
    if (q.status) conditions.push(sql`status = ${q.status}`);
    if (q.before) conditions.push(sql`id < ${q.before}`);

    const whereClause =
      conditions.length > 0
        ? sql`WHERE ${conditions.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`))}`
        : sql``;

    const rows = await sql<{
      id: string;
      subject_norm: string;
      participants: string[];
      status: string;
      current_lane: number | null;
      message_count: number;
      last_message_at: Date;
      created_at: Date;
    }[]>`
      SELECT id, subject_norm, participants, status, current_lane, message_count,
             last_message_at, created_at
      FROM threads
      ${whereClause}
      ORDER BY last_message_at DESC
      LIMIT ${q.limit}
    `;
    return { threads: rows };
  });

  app.get('/api/threads/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const threads = await sql`SELECT * FROM threads WHERE id = ${id} LIMIT 1`;
    if (threads.length === 0) return reply.code(404).send({ error: 'not found' });
    const messages = await sql`
      SELECT m.*,
             c.trust, c.sender_class, c.intent, c.recommended_lane, c.urgency, c.reasoning AS class_reasoning
      FROM messages m
      LEFT JOIN classifications c ON c.message_id = m.id
      WHERE m.thread_id = ${id}
      ORDER BY m.received_at ASC
    `;
    const drafts = await sql`
      SELECT * FROM drafts WHERE thread_id = ${id} ORDER BY created_at DESC
    `;
    return { thread: threads[0], messages, drafts };
  });

  app.post('/api/threads/:id/snooze', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { until } = z.object({ until: z.string() }).parse(req.body);
    const d = new Date(until);
    if (Number.isNaN(d.getTime())) return reply.code(400).send({ error: 'invalid date' });
    await sql`
      UPDATE threads SET status = 'snoozed', snoozed_until = ${d}, updated_at = now()
      WHERE id = ${id}
    `;
    await audit({
      actor: 'user',
      action: 'snooze',
      threadId: id,
      payload: { until: d.toISOString() },
      outcome: 'ok',
    });
    return { ok: true };
  });

  app.post('/api/threads/:id/archive', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await sql`
      UPDATE threads SET status = 'archived', updated_at = now() WHERE id = ${id}
    `;
    await audit({ actor: 'user', action: 'archive', threadId: id, payload: {}, outcome: 'ok' });
    return { ok: true };
  });

  app.post('/api/threads/:id/reclassify', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const msgs = await sql<{ id: string }[]>`
      SELECT id FROM messages
      WHERE thread_id = ${id} AND direction = 'inbound'
      ORDER BY received_at DESC
      LIMIT 1
    `;
    const m = msgs[0];
    if (!m) return reply.code(404).send({ error: 'no inbound message in thread' });
    await queues.classify.add('classify', { messageId: m.id });
    logger.info({ threadId: id, messageId: m.id }, 'reclassify requested');
    return { ok: true };
  });
}
