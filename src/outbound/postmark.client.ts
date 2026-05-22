import { ServerClient } from 'postmark';
import { env } from '../shared/env.js';
import { logger } from '../shared/log.js';

let client: ServerClient | null = null;
function isTestToken(): boolean {
  return !env.POSTMARK_SERVER_TOKEN || env.POSTMARK_SERVER_TOKEN === 'POSTMARK_API_TEST';
}
function getClient(): ServerClient | null {
  if (isTestToken()) return null;
  if (!client) client = new ServerClient(env.POSTMARK_SERVER_TOKEN);
  return client;
}

export interface SendInput {
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  subject: string;
  textBody: string;
  inReplyToHdr?: string | null;
  referencesHdr?: string[];
  messageStream?: string;
}

export interface SendResult {
  messageIdHdr: string;
  postmarkId?: string;
  delivered: boolean;
  test: boolean;
}

function genMessageIdHdr(domain: string): string {
  const r = Math.random().toString(36).slice(2, 12);
  return `${Date.now()}.${r}@${domain}`;
}

export async function sendViaPostmark(input: SendInput): Promise<SendResult> {
  const domain = input.from.split('@')[1] ?? 'localhost';
  const messageIdHdr = genMessageIdHdr(domain);
  const headers: { Name: string; Value: string }[] = [
    { Name: 'Message-ID', Value: `<${messageIdHdr}>` },
  ];
  if (input.inReplyToHdr) {
    headers.push({ Name: 'In-Reply-To', Value: `<${input.inReplyToHdr}>` });
  }
  if (input.referencesHdr && input.referencesHdr.length > 0) {
    headers.push({
      Name: 'References',
      Value: input.referencesHdr.map((r) => `<${r}>`).join(' '),
    });
  }

  const c = getClient();
  if (!c) {
    logger.warn(
      { to: input.to, subject: input.subject },
      'POSTMARK_SERVER_TOKEN missing or test — pretending to send',
    );
    return { messageIdHdr, delivered: false, test: true };
  }

  const fromAddr = input.fromName
    ? `${input.fromName} <${input.from}>`
    : input.from;

  const res = await c.sendEmail({
    From: fromAddr,
    To: input.to.join(', '),
    Cc: input.cc.length > 0 ? input.cc.join(', ') : undefined,
    Subject: input.subject,
    TextBody: input.textBody,
    MessageStream: input.messageStream ?? env.POSTMARK_OUTBOUND_STREAM,
    Headers: headers,
  });
  return {
    messageIdHdr,
    postmarkId: res.MessageID,
    delivered: true,
    test: false,
  };
}
