import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32NoPad(buf: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      const idx = (value >>> (bits - 5)) & 0x1f;
      out += BASE32_ALPHABET[idx];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  while (out.length < length) {
    const idx = (value << (5 - bits)) & 0x1f;
    out += BASE32_ALPHABET[idx];
    bits = 0;
  }
  return out.slice(0, length);
}

export interface GeneratedAgentKey {
  secret: string;
  hash: string;
  prefix: string;
}

export function generateAgentKey(): GeneratedAgentKey {
  const random = randomBytes(20);
  const token = base32NoPad(random, 32);
  const secret = `am_live_${token}`;
  const hash = createHash('sha256').update(secret).digest('hex');
  const prefix = secret.slice(0, 12);
  return { secret, hash, prefix };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

const MAX_SKEW_MS = 5 * 60 * 1000;

export function verifyHmac(
  secret: string,
  body: string,
  signature: string,
  timestamp: string,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  if (Math.abs(Date.now() - tsMs) > MAX_SKEW_MS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

export const AgentInboundSchema = z.object({
  topic: z.string().min(1).max(120),
  body: z.string().min(1).max(16000),
  refs: z.array(z.string()).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type AgentInbound = z.infer<typeof AgentInboundSchema>;
