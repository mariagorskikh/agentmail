#!/usr/bin/env tsx
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql, closeDb } from '../src/shared/db.js';
import { env } from '../src/shared/env.js';
import { logger } from '../src/shared/log.js';

async function inject(path: string): Promise<void> {
  const body = readFileSync(path, 'utf8');
  const basic = Buffer.from(env.POSTMARK_WEBHOOK_TOKEN).toString('base64');
  const url = `http://localhost:${env.PORT}/webhooks/postmark/inbound`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`inject ${path} failed: ${res.status} ${await res.text()}`);
  }
}

async function snapshot(): Promise<void> {
  const threads = await sql<{
    id: string;
    subject_norm: string;
    current_lane: number | null;
    status: string;
  }[]>`SELECT id, subject_norm, current_lane, status FROM threads ORDER BY created_at`;
  const drafts = await sql<{ id: string; thread_id: string; status: string; body_text: string }[]>`
    SELECT id, thread_id, status, body_text FROM drafts ORDER BY created_at
  `;
  console.log('\n=== THREADS ===');
  for (const t of threads) {
    console.log(`  [lane ${t.current_lane ?? '-'}] ${t.status.padEnd(15)} ${t.subject_norm}`);
  }
  console.log('\n=== DRAFTS ===');
  for (const d of drafts) {
    console.log(`  ${d.status.padEnd(10)} ${d.id} : ${d.body_text.slice(0, 100).replace(/\n/g, ' ')}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const dir = resolve(process.cwd(), 'test/fixtures');
  const fixtures = readdirSync(dir)
    .filter((f) => f.startsWith('postmark.') && f.endsWith('.json'))
    .sort();
  logger.info({ count: fixtures.length }, 'demo: injecting fixtures');
  for (const f of fixtures) {
    logger.info({ fixture: f }, 'injecting');
    await inject(resolve(dir, f));
  }
  // give workers time to process
  logger.info('waiting 8 seconds for pipeline to run');
  await new Promise((r) => setTimeout(r, 8000));
  await snapshot();
  await closeDb();
}

main().catch((err) => {
  logger.error({ err }, 'demo failed');
  closeDb().finally(() => process.exit(1));
});
