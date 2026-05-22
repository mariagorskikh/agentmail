import { audit } from '../audit/log.js';
import { checkRoute } from '../policy/engine.js';
import { sql } from '../shared/db.js';
import { logger } from '../shared/log.js';
import { makeWorker, queues } from '../shared/queue.js';
import type { ClassificationRow, Lane, MessageRow } from '../shared/types.js';

export interface RouteResult {
  messageId: string;
  threadId: string;
  lane: Lane;
  reason: string;
}

export async function routeMessage(messageId: string): Promise<RouteResult | null> {
  const msgRows = await sql<MessageRow[]>`
    SELECT * FROM messages WHERE id = ${messageId} LIMIT 1
  `;
  const msg = msgRows[0];
  if (!msg) {
    logger.warn({ messageId }, 'route: message not found');
    return null;
  }
  const classRows = await sql<ClassificationRow[]>`
    SELECT * FROM classifications WHERE message_id = ${messageId} LIMIT 1
  `;
  const cls = classRows[0];
  if (!cls) {
    logger.warn({ messageId }, 'route: classification not found');
    return null;
  }

  const contactRows = await sql<{ trust_level: string }[]>`
    SELECT trust_level FROM contacts WHERE email = ${msg.from_email} LIMIT 1
  `;
  const fromTrustLevel = contactRows[0]?.trust_level ?? 'unknown';

  const decision = checkRoute({
    classification: {
      trust: cls.trust,
      sender_class: cls.sender_class,
      intent: cls.intent,
      urgency: cls.urgency,
      recommended_lane: cls.recommended_lane,
      entities: { money_cents: cls.entities.money_cents ?? [] },
    },
    message: {
      text_body: msg.text_body,
      from_trust_level: fromTrustLevel,
      subject: msg.subject,
    },
  });

  // Update thread.current_lane (and status when applicable)
  let status: string | null = null;
  switch (decision.lane) {
    case 1:
      status = 'quarantined';
      break;
    case 5:
      status = 'awaiting_reply';
      break;
    default:
      status = null;
  }
  if (status) {
    await sql`
      UPDATE threads
      SET current_lane = ${decision.lane}, status = ${status}, updated_at = now()
      WHERE id = ${msg.thread_id}
    `;
  } else {
    await sql`
      UPDATE threads
      SET current_lane = ${decision.lane}, updated_at = now()
      WHERE id = ${msg.thread_id}
    `;
  }

  await audit({
    actor: 'agent',
    action: 'route',
    threadId: msg.thread_id,
    messageId,
    payload: {
      lane: decision.lane,
      reason: decision.reason,
      matchedPolicy: decision.matchedPolicy,
      requiresExtraConfirmation: decision.requiresExtraConfirmation,
    },
    outcome: 'ok',
  });

  // Dispatch
  switch (decision.lane) {
    case 1:
      // quarantine — nothing more
      break;
    case 2:
      // filed — nothing more
      break;
    case 3:
      // auto-action stub
      await queues.autoAction.add('auto-action', {
        messageId,
        threadId: msg.thread_id,
        kind: 'stub',
      });
      break;
    case 4:
      await queues.draft.add('draft', {
        messageId,
        threadId: msg.thread_id,
        requiresExtraConfirmation: decision.requiresExtraConfirmation,
      });
      break;
    case 5:
      // escalated — UI surfaces it; nothing else to enqueue
      break;
  }

  logger.info(
    {
      messageId,
      lane: decision.lane,
      reason: decision.reason,
      matchedPolicy: decision.matchedPolicy,
    },
    'routed',
  );

  return {
    messageId,
    threadId: msg.thread_id,
    lane: decision.lane,
    reason: decision.reason,
  };
}

export function startRouteWorker() {
  return makeWorker<{ messageId: string }>('route', async (job) => {
    await routeMessage(job.data.messageId);
  });
}
