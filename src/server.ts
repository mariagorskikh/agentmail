import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import Fastify from 'fastify';
import { registerAgentRoutes } from './api/agents.routes.js';
import { registerAuditRoutes } from './api/audit.routes.js';
import { registerBearerAuth } from './api/auth.js';
import { registerDraftRoutes } from './api/drafts.routes.js';
import { registerLoginRoutes } from './api/login.routes.js';
import { registerMessageRoutes } from './api/messages.routes.js';
import { registerThreadRoutes } from './api/threads.routes.js';
import { registerWellKnownRoutes } from './api/wellknown.routes.js';
import { registerPostmarkRoutes } from './edge/postmark.controller.js';
import { syncPoliciesToDb } from './policy/rules.js';
import { sql } from './shared/db.js';
import { env } from './shared/env.js';
import { logger } from './shared/log.js';

async function bootstrap(): Promise<void> {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    genReqId: () => Math.random().toString(36).slice(2, 12),
  });

  app.addHook('onRequest', async (req) => {
    logger.debug({ reqId: req.id, method: req.method, url: req.url }, 'request');
  });

  await app.register(cors, { origin: true });

  // Seed owner contact + policies on boot
  await sql`
    INSERT INTO contacts (id, email, display_name, trust_level)
    VALUES (gen_random_uuid()::text, ${env.OWNER_EMAIL}, ${env.OWNER_NAME}, 'self')
    ON CONFLICT (email) DO UPDATE SET
      trust_level = 'self',
      display_name = EXCLUDED.display_name
  `.catch(async () => {
    // Fallback if gen_random_uuid isn't enabled — use a literal ULID
    const { newId } = await import('./shared/ids.js');
    await sql`
      INSERT INTO contacts (id, email, display_name, trust_level)
      VALUES (${newId()}, ${env.OWNER_EMAIL}, ${env.OWNER_NAME}, 'self')
      ON CONFLICT (email) DO UPDATE SET trust_level = 'self', display_name = EXCLUDED.display_name
    `;
  });
  await syncPoliciesToDb();

  // Serve static SPA at /web/* and root.
  await app.register(staticPlugin, {
    root: resolve(process.cwd(), 'web'),
    prefix: '/web/',
  });

  registerBearerAuth(app);

  app.get('/healthz', async () => ({ ok: true, ts: Date.now() }));
  app.get('/', async (_req, reply) => reply.sendFile('landing.html'));
  app.get('/inbox', async (_req, reply) => reply.sendFile('inbox.html'));

  // Serve SKILL.md from the repo root so external agents can fetch it.
  app.get('/SKILL.md', async (_req, reply) => {
    const text = await readFile(resolve(process.cwd(), 'SKILL.md'), 'utf8');
    return reply.type('text/markdown; charset=utf-8').send(text);
  });

  await registerPostmarkRoutes(app);
  await registerLoginRoutes(app);
  await registerThreadRoutes(app);
  await registerDraftRoutes(app);
  await registerMessageRoutes(app);
  await registerAuditRoutes(app);
  await registerWellKnownRoutes(app);
  await registerAgentRoutes(app);

  await app.listen({ host: '0.0.0.0', port: env.PORT });
  logger.info({ port: env.PORT }, 'server ready');
}

bootstrap().catch((err) => {
  logger.error({ err }, 'server failed to boot');
  process.exit(1);
});
