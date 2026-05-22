import { createHash } from 'node:crypto';
import { audit } from '../audit/log.js';
import { checkSend } from '../policy/engine.js';
import { incrementCounters, readCounters } from '../policy/ratelimit.js';
import { sql } from '../shared/db.js';
import { env } from '../shared/env.js';
import { newId } from '../shared/ids.js';
import { logger } from '../shared/log.js';
import { makeWorker } from '../shared/queue.js';
import type { DraftRow, MessageRow } from '../shared/types.js';
import { sendViaPostmark } from './postmark.client.js';

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface OutboundJobData {
  draftId: string;
  approvedBodyHash: string;
}

export async function sendDraft(data: OutboundJobData): Promise<void> {
  const draftRows = await sql<DraftRow[]>`
    SELECT * FROM drafts WHERE id = ${data.draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft) {
    logger.warn({ draftId: data.draftId }, 'outbound: draft not found');
    return;
  }
  if (draft.status !== 'approved') {
    logger.info({ draftId: data.draftId, status: draft.status }, 'outbound: draft not approved, aborting');
    return;
  }

  const effectiveBody = draft.edited_body ?? draft.body_text;
  const counters = await readCounters();
  const sendCheck = checkSend({
    draftId: draft.id,
    to_emails: draft.to_emails,
    cc_emails: draft.cc_emails,
    bodyHash: hash(effectiveBody),
    expectedBodyHash: data.approvedBodyHash,
    perHourCount: counters.hour,
    perDayCount: counters.day,
    perHourLimit: env.MAX_OUTBOUND_PER_HOUR,
    perDayLimit: env.MAX_OUTBOUND_PER_DAY,
  });

  if (!sendCheck.ok) {
    await audit({
      actor: 'system',
      action: 'send',
      threadId: draft.thread_id,
      draftId: draft.id,
      payload: { blocked: sendCheck.reason },
      outcome: 'blocked',
    });
    logger.warn({ draftId: draft.id, reason: sendCheck.reason }, 'outbound blocked');
    return;
  }

  // Find original message threading headers
  const origRows = await sql<MessageRow[]>`
    SELECT * FROM messages WHERE id = ${draft.in_reply_to_id} LIMIT 1
  `;
  const orig = origRows[0];
  const inReplyTo = orig?.message_id_hdr ?? null;
  const refs: string[] = orig ? [...(orig.references_hdr ?? []), orig.message_id_hdr] : [];

  const result = await sendViaPostmark({
    from: env.OWNER_EMAIL,
    fromName: env.OWNER_NAME,
    to: draft.to_emails,
    cc: draft.cc_emails,
    subject: draft.subject,
    textBody: effectiveBody,
    inReplyToHdr: inReplyTo,
    referencesHdr: refs,
  });

  await incrementCounters();

  // Persist as outbound message
  const messageId = newId();
  await sql`
    INSERT INTO messages (
      id, thread_id, direction, message_id_hdr, in_reply_to, references_hdr,
      from_email, from_name, to_emails, cc_emails, bcc_emails,
      subject, text_body, html_body, raw_headers, auth_results, received_at
    ) VALUES (
      ${messageId},
      ${draft.thread_id},
      'outbound',
      ${result.messageIdHdr},
      ${inReplyTo},
      ${refs},
      ${env.OWNER_EMAIL},
      ${env.OWNER_NAME},
      ${draft.to_emails},
      ${draft.cc_emails},
      ${'{}'},
      ${draft.subject},
      ${effectiveBody},
      ${null},
      ${sql.json({})},
      ${sql.json({ outbound: true, postmark_test: result.test })},
      ${new Date()}
    )
  `;
  await sql`
    UPDATE drafts SET status = 'sent', decided_at = now() WHERE id = ${draft.id}
  `;
  await sql`
    UPDATE threads
    SET status = 'open', last_message_at = now(), updated_at = now(), message_count = message_count + 1
    WHERE id = ${draft.thread_id}
  `;

  await audit({
    actor: 'system',
    action: 'send',
    threadId: draft.thread_id,
    messageId,
    draftId: draft.id,
    payload: { test: result.test, postmarkId: result.postmarkId, to: draft.to_emails },
    outcome: 'ok',
  });
  logger.info({ draftId: draft.id, messageId, test: result.test }, 'sent');
}

export function startOutboundWorker() {
  return makeWorker<OutboundJobData>('outbound', async (job) => {
    await sendDraft(job.data);
  });
}
