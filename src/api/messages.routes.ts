import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../shared/db.js';

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/messages/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rows = await sql`SELECT * FROM messages WHERE id = ${id} LIMIT 1`;
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return { message: rows[0] };
  });

  app.get('/api/messages/:id/attachments/:attId', async (req, reply) => {
    const { id, attId } = z
      .object({ id: z.string(), attId: z.string() })
      .parse(req.params);
    const rows = await sql<{ filename: string; content_type: string; storage_path: string }[]>`
      SELECT filename, content_type, storage_path
      FROM attachments
      WHERE id = ${attId} AND message_id = ${id} LIMIT 1
    `;
    const att = rows[0];
    if (!att) return reply.code(404).send({ error: 'not found' });
    if (!existsSync(att.storage_path)) {
      return reply.code(410).send({ error: 'blob missing' });
    }
    reply
      .header('Content-Type', att.content_type)
      .header('Content-Disposition', `attachment; filename="${att.filename}"`);
    return reply.send(createReadStream(att.storage_path));
  });
}
