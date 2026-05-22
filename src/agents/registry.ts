import { sql } from '../shared/db.js';
import { newId } from '../shared/ids.js';
import { generateAgentKey } from './identity.js';

export type AgentTrustLevel = 'blocked' | 'unknown' | 'known' | 'trusted' | 'partner';

export interface AgentRow {
  id: string;
  agent_id: string;
  display_name: string;
  operator_email: string | null;
  key_hash: string;
  key_prefix: string;
  trust_level: AgentTrustLevel;
  scopes: string[];
  rate_per_hour: number;
  rate_per_day: number;
  metadata: Record<string, unknown>;
  revoked_at: Date | null;
  created_at: Date;
  last_used_at: Date | null;
}

export type AgentRowPublic = Omit<AgentRow, 'key_hash'>;

export interface CreateAgentInput {
  agent_id: string;
  display_name: string;
  operator_email?: string | null;
  trust_level?: AgentTrustLevel;
}

export interface CreatedAgent extends AgentRowPublic {
  secret: string;
}

export async function createAgent(input: CreateAgentInput): Promise<CreatedAgent> {
  const key = generateAgentKey();
  const id = newId();
  const trust = input.trust_level ?? 'unknown';
  const rows = await sql<AgentRow[]>`
    INSERT INTO agents (
      id, agent_id, display_name, operator_email, key_hash, key_prefix, trust_level
    ) VALUES (
      ${id},
      ${input.agent_id},
      ${input.display_name},
      ${input.operator_email ?? null},
      ${key.hash},
      ${key.prefix},
      ${trust}
    )
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('failed to insert agent');
  const { key_hash: _kh, ...publicRow } = row;
  return { ...publicRow, secret: key.secret };
}

export async function lookupAgent(agent_id: string): Promise<AgentRow | null> {
  const rows = await sql<AgentRow[]>`
    SELECT * FROM agents WHERE agent_id = ${agent_id} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function revokeAgent(agent_id: string): Promise<void> {
  await sql`
    UPDATE agents SET revoked_at = now() WHERE agent_id = ${agent_id} AND revoked_at IS NULL
  `;
}

export async function touchAgent(agent_id: string): Promise<void> {
  await sql`
    UPDATE agents SET last_used_at = now() WHERE agent_id = ${agent_id}
  `;
}

export async function listAgents(): Promise<AgentRowPublic[]> {
  const rows = await sql<AgentRowPublic[]>`
    SELECT id, agent_id, display_name, operator_email, key_prefix, trust_level,
           scopes, rate_per_hour, rate_per_day, metadata, revoked_at, created_at, last_used_at
    FROM agents
    WHERE revoked_at IS NULL
    ORDER BY created_at DESC
  `;
  return rows;
}
