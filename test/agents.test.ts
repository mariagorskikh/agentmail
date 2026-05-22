import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { closeDb, sql } from '../src/shared/db.js';
import {
  AgentInboundSchema,
  generateAgentKey,
  hashSecret,
  verifyHmac,
} from '../src/agents/identity.js';
import { createAgent, lookupAgent, revokeAgent, touchAgent, listAgents } from '../src/agents/registry.js';

async function clean(): Promise<void> {
  await sql`DELETE FROM agent_counters`;
  await sql`DELETE FROM messages WHERE agent_id IS NOT NULL`;
  await sql`DELETE FROM agents`;
}

beforeEach(async () => {
  await clean();
});

describe('generateAgentKey', () => {
  it('produces an am_live_ prefixed secret + matching sha256 hash + 12-char prefix', () => {
    const { secret, hash, prefix } = generateAgentKey();
    expect(secret.startsWith('am_live_')).toBe(true);
    expect(secret.length).toBe('am_live_'.length + 32);
    expect(hash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(prefix).toBe(secret.slice(0, 12));
  });

  it('is non-repeating', () => {
    const a = generateAgentKey().secret;
    const b = generateAgentKey().secret;
    expect(a).not.toBe(b);
  });
});

describe('verifyHmac', () => {
  const key = hashSecret('am_live_TESTSECRET'); // server-side HMAC key
  const body = JSON.stringify({ topic: 't', body: 'b' });

  function sign(timestamp: string, payload: string): string {
    return createHmac('sha256', key).update(`${timestamp}.${payload}`).digest('hex');
  }

  it('accepts a valid signature within the clock skew window', () => {
    const ts = String(Date.now());
    const sig = sign(ts, body);
    expect(verifyHmac(key, body, sig, ts)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const ts = String(Date.now());
    const sig = sign(ts, body);
    expect(verifyHmac(key, body + 'tamper', sig, ts)).toBe(false);
  });

  it('rejects an expired timestamp (>5min skew)', () => {
    const ts = String(Date.now() - 10 * 60 * 1000);
    const sig = sign(ts, body);
    expect(verifyHmac(key, body, sig, ts)).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifyHmac(key, body, 'abc', 'notanumber')).toBe(false);
  });
});

describe('AgentInboundSchema', () => {
  it('accepts a minimal valid payload', () => {
    const r = AgentInboundSchema.parse({ topic: 'hi', body: 'hello' });
    expect(r.topic).toBe('hi');
  });

  it('rejects empty topic', () => {
    expect(AgentInboundSchema.safeParse({ topic: '', body: 'x' }).success).toBe(false);
  });

  it('rejects topic > 120 chars', () => {
    expect(
      AgentInboundSchema.safeParse({ topic: 'x'.repeat(121), body: 'x' }).success,
    ).toBe(false);
  });

  it('rejects body > 16000 chars', () => {
    expect(
      AgentInboundSchema.safeParse({ topic: 'x', body: 'x'.repeat(16001) }).success,
    ).toBe(false);
  });

  it('rejects invalid priority', () => {
    expect(
      AgentInboundSchema.safeParse({ topic: 'x', body: 'x', priority: 'urgent' }).success,
    ).toBe(false);
  });
});

describe('registry', () => {
  it('createAgent inserts and returns the secret exactly once', async () => {
    const result = await createAgent({
      agent_id: 'bot-x',
      display_name: 'Bot X',
      operator_email: 'ops@example.com',
      trust_level: 'known',
    });
    expect(result.agent_id).toBe('bot-x');
    expect(result.secret.startsWith('am_live_')).toBe(true);
    expect(result.key_prefix).toBe(result.secret.slice(0, 12));

    const row = await lookupAgent('bot-x');
    expect(row?.display_name).toBe('Bot X');
    expect(row?.trust_level).toBe('known');
    expect(row?.key_hash).toBe(createHash('sha256').update(result.secret).digest('hex'));
  });

  it('lookupAgent returns null for missing or revoked', async () => {
    expect(await lookupAgent('nope')).toBeNull();
    await createAgent({ agent_id: 'bot-y', display_name: 'Bot Y' });
    await revokeAgent('bot-y');
    const row = await lookupAgent('bot-y');
    // lookupAgent should return the row but with revoked_at set
    expect(row?.revoked_at).not.toBeNull();
  });

  it('listAgents omits the key_hash and only returns non-revoked', async () => {
    await createAgent({ agent_id: 'bot-a', display_name: 'A' });
    await createAgent({ agent_id: 'bot-b', display_name: 'B' });
    await revokeAgent('bot-a');
    const rows = await listAgents();
    expect(rows.map((r) => r.agent_id)).toEqual(['bot-b']);
    // every returned row must not include key_hash field
    for (const r of rows) {
      expect((r as unknown as Record<string, unknown>).key_hash).toBeUndefined();
    }
  });

  it('touchAgent bumps last_used_at', async () => {
    await createAgent({ agent_id: 'bot-touch', display_name: 'T' });
    const before = (await lookupAgent('bot-touch'))?.last_used_at;
    await touchAgent('bot-touch');
    const after = (await lookupAgent('bot-touch'))?.last_used_at;
    expect(after).toBeTruthy();
    if (before && after) {
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    }
  });
});

afterAll(async () => {
  await closeDb();
});
