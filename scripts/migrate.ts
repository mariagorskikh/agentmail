#!/usr/bin/env tsx
// Minimal forward-only migration runner.
// Reads ./migrations/*.sql in lexicographic order, runs any not yet recorded
// in the _migrations table inside a transaction.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql, closeDb } from '../src/shared/db.js';
import { logger } from '../src/shared/log.js';

async function ensureTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function applied(): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM _migrations`;
  return new Set(rows.map((r) => r.name));
}

async function main(): Promise<void> {
  const dir = resolve(process.cwd(), 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  await ensureTable();
  const done = await applied();

  for (const f of files) {
    if (done.has(f)) {
      logger.info({ migration: f }, 'skip (already applied)');
      continue;
    }
    const path = resolve(dir, f);
    const body = readFileSync(path, 'utf8');
    logger.info({ migration: f }, 'applying');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO _migrations (name) VALUES (${f})`;
    });
    logger.info({ migration: f }, 'applied');
  }

  await closeDb();
}

main().catch((err) => {
  logger.error({ err }, 'migration failed');
  closeDb().finally(() => process.exit(1));
});
