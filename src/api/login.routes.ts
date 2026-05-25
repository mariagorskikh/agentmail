import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../shared/env.js';
import { logger } from '../shared/log.js';

const LoginSchema = z.object({
  password: z.string().min(1),
});

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function registerLoginRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/login', async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.flatten() });
    }
    if (!env.OWNER_PASSWORD) {
      logger.warn('login attempted but OWNER_PASSWORD not set');
      return reply.code(503).send({ error: 'login not configured' });
    }
    if (!eq(parsed.data.password, env.OWNER_PASSWORD)) {
      return reply.code(401).send({ error: 'wrong password' });
    }
    return {
      token: env.API_TOKEN,
      owner: { name: env.OWNER_NAME, email: env.OWNER_EMAIL },
    };
  });

  app.get('/api/me', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const tok = auth.slice(7).trim();
    if (!eq(tok, env.API_TOKEN)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return {
      owner: { name: env.OWNER_NAME, email: env.OWNER_EMAIL },
    };
  });
}
