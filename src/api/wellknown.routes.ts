import type { FastifyInstance } from 'fastify';
import { env } from '../shared/env.js';

export async function registerWellKnownRoutes(app: FastifyInstance): Promise<void> {
  app.get('/.well-known/agentmail.json', async () => ({
    name: 'AgentMail',
    owner: { name: env.OWNER_NAME, email: env.OWNER_EMAIL },
    version: '1',
    endpoints: {
      inbound: '/api/v1/agent/messages',
      thread: '/api/v1/agent/threads/{id}',
      skill: '/SKILL.md',
    },
    auth: {
      scheme: 'HMAC-SHA256',
      headers: ['X-AgentMail-Key', 'X-AgentMail-Timestamp', 'X-AgentMail-Signature'],
    },
    limits: {
      max_body_bytes: 16000,
      max_topic_chars: 120,
      default_rate_per_hour: 30,
      default_rate_per_day: 200,
    },
    policies: {
      identity_required: true,
      humans_in_the_loop: true,
      undo_window_seconds: env.DELAYED_SEND_SECONDS,
    },
    supported_topics: ['demo_request', 'meeting_request', 'intro', 'support', 'fyi', 'other'],
  }));
}
