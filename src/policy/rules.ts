import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type postgres from 'postgres';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { sql } from '../shared/db.js';
import { newId } from '../shared/ids.js';
import { logger } from '../shared/log.js';

const PolicyWhenSchema = z.object({
  from_trust_level: z.string().optional(),
  body_contains_any: z.array(z.string()).optional(),
  sender_class: z.string().optional(),
  trust: z.string().optional(),
  intent: z.string().optional(),
  user_status: z.string().optional(),
  money_amount_gte_cents: z.number().optional(),
});

const PolicyThenSchema = z.object({
  force_lane: z.number().int().min(1).max(5).optional(),
  reason: z.string().optional(),
  auto_action: z.string().optional(),
});

const PolicySchema = z.object({
  name: z.string(),
  when: PolicyWhenSchema,
  then: PolicyThenSchema,
});

const LimitsSchema = z.object({
  max_recipients_per_send: z.number().int().positive(),
  max_send_to_new_recipient_per_day: z.number().int().nonnegative(),
  forbidden_recipients: z.array(z.string()).default([]),
  required_human_review_if: z
    .array(
      z.object({
        body_contains_any: z.array(z.string()).optional(),
        money_amount_gte_cents: z.number().optional(),
      }),
    )
    .default([]),
});

const PolicyFileSchema = z.object({
  policies: z.array(PolicySchema),
  limits: LimitsSchema,
});

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyWhen = z.infer<typeof PolicyWhenSchema>;
export type PolicyThen = z.infer<typeof PolicyThenSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type PolicyConfig = z.infer<typeof PolicyFileSchema>;

let cached: PolicyConfig | null = null;

export function loadPoliciesFromDisk(path?: string): PolicyConfig {
  const p = path ?? resolve(process.cwd(), 'config/policies.yaml');
  const text = readFileSync(p, 'utf8');
  const raw = parseYaml(text);
  const parsed = PolicyFileSchema.parse(raw);
  cached = parsed;
  return parsed;
}

export function getPolicies(): PolicyConfig {
  if (!cached) {
    return loadPoliciesFromDisk();
  }
  return cached;
}

export async function syncPoliciesToDb(): Promise<void> {
  const cfg = loadPoliciesFromDisk();
  for (const p of cfg.policies) {
    const id = newId();
    await sql`
      INSERT INTO policies (id, name, body, active, loaded_at)
      VALUES (${id}, ${p.name}, ${sql.json(p as unknown as postgres.JSONValue)}, true, now())
      ON CONFLICT (name)
      DO UPDATE SET body = EXCLUDED.body, active = true, loaded_at = now()
    `;
  }
  // store limits too
  await sql`
    INSERT INTO policies (id, name, body, active, loaded_at)
    VALUES (${newId()}, '__limits__', ${sql.json(cfg.limits as unknown as postgres.JSONValue)}, true, now())
    ON CONFLICT (name)
    DO UPDATE SET body = EXCLUDED.body, active = true, loaded_at = now()
  `;
  logger.info({ count: cfg.policies.length }, 'policies synced to db');
}
