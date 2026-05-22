import { sql } from '../shared/db.js';

function hourBucket(agentId: string, d: Date = new Date()): string {
  return `agent:${agentId}:hour:${d.toISOString().slice(0, 13)}`;
}
function dayBucket(agentId: string, d: Date = new Date()): string {
  return `agent:${agentId}:day:${d.toISOString().slice(0, 10)}`;
}

export async function readAgentCounters(
  agentId: string,
): Promise<{ hour: number; day: number }> {
  const h = hourBucket(agentId);
  const d = dayBucket(agentId);
  const rows = await sql<{ bucket: string; count: number }[]>`
    SELECT bucket, count FROM agent_counters
    WHERE bucket IN (${h}, ${d})
  `;
  let hour = 0;
  let day = 0;
  for (const r of rows) {
    if (r.bucket === h) hour = r.count;
    if (r.bucket === d) day = r.count;
  }
  return { hour, day };
}

export async function incrementAgentCounters(agentId: string): Promise<void> {
  await sql`
    INSERT INTO agent_counters (bucket, count, updated_at)
    VALUES (${hourBucket(agentId)}, 1, now())
    ON CONFLICT (bucket)
    DO UPDATE SET count = agent_counters.count + 1, updated_at = now()
  `;
  await sql`
    INSERT INTO agent_counters (bucket, count, updated_at)
    VALUES (${dayBucket(agentId)}, 1, now())
    ON CONFLICT (bucket)
    DO UPDATE SET count = agent_counters.count + 1, updated_at = now()
  `;
}
