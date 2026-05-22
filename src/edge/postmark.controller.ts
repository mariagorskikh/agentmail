import type { FastifyInstance } from 'fastify';
import { env } from '../shared/env.js';
import { logger } from '../shared/log.js';
import { queues } from '../shared/queue.js';
import { PostmarkInboundSchema } from './postmark.schema.js';

function verifyBasicAuth(header: string | undefined, expected: string): boolean {
  if (!header || !header.toLowerCase().startsWith('basic ')) return false;
  const b64 = header.slice(6).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return false;
  }
  // expected is stored as "user:pass"
  return decoded === expected;
}

export async function registerPostmarkRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/postmark/inbound', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!verifyBasicAuth(auth, env.POSTMARK_WEBHOOK_TOKEN)) {
      logger.warn('postmark inbound: unauthorized');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = PostmarkInboundSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ err: parsed.error.flatten() }, 'postmark inbound: invalid payload');
      return reply.code(400).send({ error: 'invalid payload', detail: parsed.error.flatten() });
    }

    const payload = parsed.data;
    const safeId = `pm-${payload.MessageID.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    await queues.ingest.add('ingest', payload, {
      jobId: safeId, // queue-level dedup
      removeOnComplete: 1000,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });

    logger.info({ messageId: payload.MessageID, from: payload.From }, 'enqueued inbound');
    return { ok: true };
  });
}
