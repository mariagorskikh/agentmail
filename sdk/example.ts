/**
 * Runnable example: npx tsx sdk/example.ts
 *
 * Reads AM_BASE_URL, AM_AGENT_ID, AM_SECRET from env.
 * Sends one message, then polls status once.
 *
 * This will fail if the server isn't running or env isn't set — that's fine.
 * The point of this file is to be a copy-pasteable starting template.
 */

import { AgentMail } from './index.ts';

const baseUrl = process.env.AM_BASE_URL ?? 'http://localhost:3000';
const agentId = process.env.AM_AGENT_ID;
const secret = process.env.AM_SECRET;

async function main(): Promise<void> {
  if (!agentId || !secret) {
    console.error(
      'Missing env. Set AM_AGENT_ID and AM_SECRET (and optionally AM_BASE_URL).',
    );
    console.error('Get a key by registering at <baseUrl>/setup.');
    process.exit(1);
  }

  // 1) Discover the mailbox (unauthenticated).
  try {
    const card = await AgentMail.card(baseUrl);
    console.log('mailbox card:', JSON.stringify(card, null, 2));
  } catch (err) {
    console.warn('card fetch failed (server probably not running):', (err as Error).message);
  }

  const mail = new AgentMail({ baseUrl, agentId, secret });

  // 2) Send a demo message.
  const sent = await mail.send({
    topic: 'demo from @agentmail/sdk example',
    body: 'Hello from the example script. Please ignore — this is a test send.',
    priority: 'low',
    metadata: { source: 'sdk-example' },
  });
  console.log('sent:', sent);

  // 3) Poll status once after a short wait.
  await new Promise((r) => setTimeout(r, 2000));
  const st = await mail.status(sent.message_id_hdr);
  console.log('status:', st);

  if (st.reply_thread_id) {
    const msgs = await mail.threadMessages(st.reply_thread_id);
    console.log(`thread ${st.reply_thread_id}: ${msgs.length} message(s)`);
  }
}

main().catch((err) => {
  console.error('example failed:', err);
  process.exit(1);
});
