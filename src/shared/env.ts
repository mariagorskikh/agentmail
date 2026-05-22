import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// minimal .env loader — no extra deps
function loadDotenv() {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotenv();

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  WEB_PORT: z.coerce.number().default(3001),
  API_TOKEN: z.string().min(8),

  OWNER_EMAIL: z.string().email(),
  OWNER_NAME: z.string().min(1),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  POSTMARK_SERVER_TOKEN: z.string().default(''),
  POSTMARK_WEBHOOK_TOKEN: z.string().default(''),
  POSTMARK_INBOUND_EMAIL: z.string().default(''),
  POSTMARK_OUTBOUND_STREAM: z.string().default('outbound'),

  ANTHROPIC_API_KEY: z.string().default(''),
  CLAUDE_MODEL_CLASSIFIER: z.string().default('claude-haiku-4-5-20251001'),
  CLAUDE_MODEL_DRAFTER: z.string().default('claude-opus-4-7'),

  DELAYED_SEND_SECONDS: z.coerce.number().default(60),
  MAX_OUTBOUND_PER_HOUR: z.coerce.number().default(30),
  MAX_OUTBOUND_PER_DAY: z.coerce.number().default(200),
});

export type Env = z.infer<typeof EnvSchema>;

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Environment validation failed');
  }
  return parsed.data;
}

export const env = load();
