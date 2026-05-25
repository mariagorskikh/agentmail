import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../shared/env.js';

export function requireBearer(req: FastifyRequest): boolean {
  const h = req.headers.authorization;
  if (!h || !h.toLowerCase().startsWith('bearer ')) return false;
  const token = h.slice(7).trim();
  return token === env.API_TOKEN;
}

export function registerBearerAuth(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    // Allow webhook + healthz + setup; everything else under /api needs Bearer
    // (except /api/v1/agent/* which authenticates via HMAC inside the plugin).
    const url = req.url.split('?')[0] ?? '';
    if (
      url.startsWith('/webhooks/') ||
      url === '/healthz' ||
      url === '/' ||
      url === '/api/login' ||
      url.startsWith('/api/v1/agent/') ||
      !url.startsWith('/api/')
    ) {
      return;
    }
    if (!requireBearer(req)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
