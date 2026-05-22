#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../src/shared/env.js';
import { logger } from '../src/shared/log.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: tsx scripts/inject.ts <fixture.json>');
    process.exit(2);
  }
  const path = resolve(process.cwd(), arg);
  const body = readFileSync(path, 'utf8');
  const basic = Buffer.from(env.POSTMARK_WEBHOOK_TOKEN).toString('base64');
  const url = `http://localhost:${env.PORT}/webhooks/postmark/inbound`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  const txt = await res.text();
  logger.info({ status: res.status, body: txt }, 'inject result');
  if (res.status !== 200) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, 'inject failed');
  process.exit(1);
});
