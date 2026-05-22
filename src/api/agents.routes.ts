import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentInboundSchema, verifyHmac } from '../agents/identity.js';
import { incrementAgentCounters, readAgentCounters } from '../agents/ratelimit.js';
import {
  type AgentRow,
  createAgent,
  listAgents,
  lookupAgent,
  revokeAgent,
  touchAgent,
} from '../agents/registry.js';
import { audit } from '../audit/log.js';
import type { PostmarkInbound } from '../edge/postmark.schema.js';
import { sql } from '../shared/db.js';
import { env } from '../shared/env.js';
import { newId } from '../shared/ids.js';
import { logger } from '../shared/log.js';
import { queues } from '../shared/queue.js';

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AgentRow;
    rawJsonBody?: string;
  }
}

const CreateAgentSchema = z.object({
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/),
  display_name: z.string().min(1).max(120),
  operator_email: z.string().email().optional(),
  trust_level: z.enum(['blocked', 'unknown', 'known', 'trusted', 'partner']).optional(),
});

async function authenticateHmac(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const keyHeader = req.headers['x-agentmail-key'];
  const tsHeader = req.headers['x-agentmail-timestamp'];
  const sigHeader = req.headers['x-agentmail-signature'];
  const agentId = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
  const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
  const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

  if (!agentId || !timestamp || !signature) {
    return reply.code(401).send({ error: 'unauthorized', detail: 'missing auth headers' });
  }

  const agent = await lookupAgent(agentId);
  if (!agent || agent.revoked_at || agent.trust_level === 'blocked') {
    return reply.code(401).send({ error: 'unauthorized', detail: 'unknown or revoked agent' });
  }

  const rawBody = req.rawJsonBody ?? '';
  const valid = verifyHmac(agent.key_hash, rawBody, signature, timestamp);
  if (!valid) {
    return reply.code(401).send({ error: 'unauthorized', detail: 'bad signature' });
  }

  req.agent = agent;
}

function buildSyntheticPostmark(args: {
  agent: AgentRow;
  topic: string;
  body: string;
  refs?: string[];
  messageIdHdr: string;
}): PostmarkInbound {
  const from = `${args.agent.agent_id}@agents.agentmail.local`;
  const headers: { Name: string; Value: string }[] = [
    { Name: 'Message-ID', Value: `<${args.messageIdHdr}>` },
    { Name: 'X-AgentMail-Agent-Id', Value: args.agent.agent_id },
    { Name: 'Authentication-Results', Value: 'spf=pass dkim=pass dmarc=pass' },
  ];
  if (args.refs && args.refs.length > 0) {
    headers.push({
      Name: 'References',
      Value: args.refs.map((r) => `<${r}>`).join(' '),
    });
    const last = args.refs[args.refs.length - 1];
    if (last) headers.push({ Name: 'In-Reply-To', Value: `<${last}>` });
  }
  return {
    FromName: args.agent.display_name,
    From: from,
    FromFull: { Email: from, Name: args.agent.display_name, MailboxHash: '' },
    To: env.OWNER_EMAIL,
    ToFull: [{ Email: env.OWNER_EMAIL, Name: env.OWNER_NAME, MailboxHash: '' }],
    Cc: '',
    CcFull: [],
    Bcc: '',
    BccFull: [],
    OriginalRecipient: env.OWNER_EMAIL,
    Subject: args.topic,
    MessageID: args.messageIdHdr,
    ReplyTo: '',
    MailboxHash: '',
    Date: new Date().toUTCString(),
    TextBody: args.body,
    HtmlBody: '',
    StrippedTextReply: '',
    Tag: 'agent-inbound',
    Headers: headers,
    Attachments: [],
  };
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof CreateAgentSchema> }>(
    '/api/v1/admin/agents',
    async (req, reply) => {
      const parsed = CreateAgentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', detail: parsed.error.flatten() });
      }
      try {
        const created = await createAgent(parsed.data);
        await audit({
          actor: 'user',
          action: 'create_agent',
          payload: { agent_id: created.agent_id, trust_level: created.trust_level },
          outcome: 'ok',
        });
        return reply.code(201).send({ agent: created });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('duplicate key')) {
          return reply.code(409).send({ error: 'agent_id already exists' });
        }
        throw err;
      }
    },
  );

  app.get('/api/v1/admin/agents', async () => {
    const agents = await listAgents();
    return { agents };
  });

  app.delete('/api/v1/admin/agents/:agent_id', async (req, reply) => {
    const { agent_id } = z.object({ agent_id: z.string() }).parse(req.params);
    const existing = await lookupAgent(agent_id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    await revokeAgent(agent_id);
    await audit({
      actor: 'user',
      action: 'revoke_agent',
      payload: { agent_id },
      outcome: 'ok',
    });
    return { ok: true };
  });

  await app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (req, body, done) => {
        const raw = typeof body === 'string' ? body : body.toString('utf8');
        req.rawJsonBody = raw;
        if (raw.length === 0) {
          done(null, {});
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    scoped.addHook('preHandler', authenticateHmac);

    scoped.post('/api/v1/agent/messages', async (req, reply) => {
      const agent = req.agent;
      if (!agent) return reply.code(401).send({ error: 'unauthorized' });

      const parsed = AgentInboundSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', detail: parsed.error.flatten() });
      }

      const hourLimit = agent.rate_per_hour || env.MAX_OUTBOUND_PER_HOUR;
      const dayLimit = agent.rate_per_day || env.MAX_OUTBOUND_PER_DAY;
      const counters = await readAgentCounters(agent.agent_id);
      if (counters.hour >= hourLimit || counters.day >= dayLimit) {
        await audit({
          actor: 'agent',
          action: 'agent_inbound',
          payload: {
            agent_id: agent.agent_id,
            reason: 'rate_limited',
            counters,
            limits: { hour: hourLimit, day: dayLimit },
          },
          outcome: 'blocked',
        });
        return reply.code(429).send({ error: 'rate limited', counters });
      }

      const ulid = newId();
      const messageIdHdr = `am-${ulid}@agents.agentmail.local`;
      const payload = buildSyntheticPostmark({
        agent,
        topic: parsed.data.topic,
        body: parsed.data.body,
        refs: parsed.data.refs,
        messageIdHdr,
      });
      (payload as unknown as { __agent_id: string }).__agent_id = agent.agent_id;

      await queues.ingest.add('ingest', payload, {
        jobId: `agent-${ulid}`,
      });

      await incrementAgentCounters(agent.agent_id);
      await touchAgent(agent.agent_id);

      await audit({
        actor: 'agent',
        action: 'agent_inbound',
        payload: {
          agent_id: agent.agent_id,
          topic: parsed.data.topic,
          priority: parsed.data.priority ?? 'normal',
          message_id_hdr: messageIdHdr,
        },
        outcome: 'ok',
      });

      logger.info(
        { agentId: agent.agent_id, messageIdHdr, topic: parsed.data.topic },
        'agent inbound accepted',
      );

      return reply.code(202).send({
        message_id_hdr: messageIdHdr,
        status: 'accepted',
        expected_eta_seconds: 30,
      });
    });

    scoped.get('/api/v1/agent/messages/:message_id_hdr', async (req, reply) => {
      const agent = req.agent;
      if (!agent) return reply.code(401).send({ error: 'unauthorized' });
      const { message_id_hdr } = z
        .object({ message_id_hdr: z.string() })
        .parse(req.params);
      const rows = await sql<
        {
          id: string;
          thread_id: string;
          message_id_hdr: string;
          subject: string;
          received_at: Date;
        }[]
      >`
        SELECT id, thread_id, message_id_hdr, subject, received_at
        FROM messages
        WHERE message_id_hdr = ${message_id_hdr} AND agent_id = ${agent.agent_id}
        LIMIT 1
      `;
      const msg = rows[0];
      if (!msg) return reply.code(404).send({ error: 'not found' });

      const drafts = await sql<
        { id: string; status: string; send_at: Date | null }[]
      >`
        SELECT id, status, send_at
        FROM drafts
        WHERE thread_id = ${msg.thread_id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const draft = drafts[0];

      let status: 'received' | 'drafted' | 'approved' | 'sent' | 'rejected' = 'received';
      if (draft) {
        if (draft.status === 'pending') status = 'drafted';
        else if (draft.status === 'approved') status = 'approved';
        else if (draft.status === 'sent') status = 'sent';
        else if (draft.status === 'rejected') status = 'rejected';
      }

      const replyThread = await sql<{ id: string }[]>`
        SELECT id FROM threads WHERE id = ${msg.thread_id} LIMIT 1
      `;

      return {
        message_id_hdr: msg.message_id_hdr,
        status,
        thread_id: replyThread[0]?.id ?? null,
        draft_send_at: draft?.send_at ?? null,
      };
    });

    scoped.get('/api/v1/agent/threads/:id', async (req, reply) => {
      const agent = req.agent;
      if (!agent) return reply.code(401).send({ error: 'unauthorized' });
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const since = z
        .object({ since: z.string().optional() })
        .parse(req.query ?? {}).since;

      const participatedRows = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM messages
        WHERE thread_id = ${id} AND agent_id = ${agent.agent_id}
      `;
      if (!participatedRows[0] || participatedRows[0].c === 0) {
        return reply.code(404).send({ error: 'not found' });
      }

      const sinceDate = since ? new Date(since) : null;
      const sinceClause =
        sinceDate && !Number.isNaN(sinceDate.getTime())
          ? sql`AND received_at > ${sinceDate}`
          : sql``;

      const messages = await sql<
        {
          from_email: string;
          from_name: string | null;
          text_body: string | null;
          received_at: Date;
          direction: 'inbound' | 'outbound';
        }[]
      >`
        SELECT from_email, from_name, text_body, received_at, direction
        FROM messages
        WHERE thread_id = ${id}
        ${sinceClause}
        ORDER BY received_at ASC
      `;

      return {
        thread_id: id,
        messages: messages.map((m) => ({
          from: m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email,
          body: m.text_body ?? '',
          ts: m.received_at,
          direction: m.direction,
        })),
      };
    });
  });
}
