import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { audit } from '../audit/log.js';
import type { PostmarkInbound } from '../edge/postmark.schema.js';
import { sql } from '../shared/db.js';
import { newId } from '../shared/ids.js';
import { logger } from '../shared/log.js';
import { makeWorker, queues } from '../shared/queue.js';
import { isDuplicate } from './dedupe.js';
import { parseInbound } from './parse.js';
import { resolveOrCreateThread } from './threading.js';

const ATTACHMENT_DIR = resolve(process.cwd(), 'data/attachments');

function storeAttachment(content: string, contentType: string): {
  sha256: string;
  path: string;
  size: number;
} {
  const buf = Buffer.from(content, 'base64');
  const sha256 = createHash('sha256').update(buf).digest('hex');
  mkdirSync(ATTACHMENT_DIR, { recursive: true });
  const path = resolve(ATTACHMENT_DIR, sha256);
  writeFileSync(path, buf);
  void contentType;
  return { sha256, path, size: buf.length };
}

async function upsertContact(email: string, name: string | null): Promise<void> {
  if (!email) return;
  await sql`
    INSERT INTO contacts (id, email, display_name, first_seen_at, last_seen_at)
    VALUES (${newId()}, ${email}, ${name}, now(), now())
    ON CONFLICT (email) DO UPDATE
      SET last_seen_at = now(),
          display_name = COALESCE(contacts.display_name, EXCLUDED.display_name)
  `;
}

export async function ingestOne(payload: PostmarkInbound): Promise<{
  messageId: string;
  threadId: string;
  duplicate: boolean;
} | null> {
  const parsed = parseInbound(payload);

  // Dedup check (outside tx is fine; transaction will catch race via UNIQUE)
  if (await isDuplicate(sql, parsed.messageIdHdr)) {
    logger.info({ messageIdHdr: parsed.messageIdHdr }, 'duplicate inbound, skipping');
    return null;
  }

  // Upsert contacts (from + to + cc)
  await upsertContact(parsed.fromEmail, parsed.fromName);
  for (const e of parsed.toEmails) await upsertContact(e, null);
  for (const e of parsed.ccEmails) await upsertContact(e, null);

  const participants = [
    parsed.fromEmail.toLowerCase(),
    ...parsed.toEmails.map((e) => e.toLowerCase()),
    ...parsed.ccEmails.map((e) => e.toLowerCase()),
  ].filter(Boolean);

  // Threading + persistence in one transaction.
  const messageId = newId();
  let threadId = '';
  await sql.begin(async (tx) => {
    const thread = await resolveOrCreateThread(tx, {
      messageIdHdr: parsed.messageIdHdr,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      subject: parsed.subject,
      participants,
      receivedAt: parsed.receivedAt,
    });
    threadId = thread.threadId;

    await tx`
      INSERT INTO messages (
        id, thread_id, direction, message_id_hdr, in_reply_to, references_hdr,
        from_email, from_name, to_emails, cc_emails, bcc_emails,
        subject, text_body, html_body, raw_headers, auth_results, received_at
      ) VALUES (
        ${messageId},
        ${threadId},
        'inbound',
        ${parsed.messageIdHdr},
        ${parsed.inReplyTo},
        ${parsed.references},
        ${parsed.fromEmail},
        ${parsed.fromName},
        ${parsed.toEmails},
        ${parsed.ccEmails},
        ${parsed.bccEmails},
        ${parsed.subject},
        ${parsed.textBody},
        ${parsed.htmlBody},
        ${tx.json(parsed.rawHeaders)},
        ${tx.json(parsed.authResults)},
        ${parsed.receivedAt}
      )
    `;

    // Attachments
    for (const att of payload.Attachments) {
      const stored = storeAttachment(att.Content, att.ContentType);
      await tx`
        INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, storage_path, sha256)
        VALUES (
          ${newId()},
          ${messageId},
          ${att.Name},
          ${att.ContentType},
          ${stored.size},
          ${stored.path},
          ${stored.sha256}
        )
      `;
    }
  });

  await audit({
    actor: 'system',
    action: 'ingest',
    threadId,
    messageId,
    payload: {
      from: parsed.fromEmail,
      subject: parsed.subject,
      messageIdHdr: parsed.messageIdHdr,
    },
    outcome: 'ok',
  });

  // Enqueue classification
  await queues.classify.add('classify', { messageId });
  logger.info({ messageId, threadId, from: parsed.fromEmail }, 'ingested');

  return { messageId, threadId, duplicate: false };
}

export function startIngestWorker() {
  return makeWorker<PostmarkInbound>('ingest', async (job) => {
    await ingestOne(job.data);
  });
}
