import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../shared/db.js';

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audit', async (req) => {
    const q = z
      .object({
        thread_id: z.string().optional(),
        action: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query ?? {});

    const conds: ReturnType<typeof sql>[] = [];
    if (q.thread_id) conds.push(sql`thread_id = ${q.thread_id}`);
    if (q.action) conds.push(sql`action = ${q.action}`);
    const whereClause =
      conds.length > 0
        ? sql`WHERE ${conds.reduce((a, c, i) => (i === 0 ? c : sql`${a} AND ${c}`))}`
        : sql``;

    const rows = await sql`
      SELECT id, actor, action, thread_id, message_id, draft_id, payload, outcome, created_at
      FROM audit_log
      ${whereClause}
      ORDER BY id DESC
      LIMIT ${q.limit}
    `;
    return { entries: rows };
  });
}
