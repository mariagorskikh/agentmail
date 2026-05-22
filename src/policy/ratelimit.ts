import { sql } from '../shared/db.js';

function hourBucket(d: Date = new Date()): string {
  return `global:hour:${d.toISOString().slice(0, 13)}`;
}
function dayBucket(d: Date = new Date()): string {
  return `global:day:${d.toISOString().slice(0, 10)}`;
}

export async function readCounters(): Promise<{ hour: number; day: number }> {
  const rows = await sql<{ bucket: string; count: number }[]>`
    SELECT bucket, count FROM outbound_counters
    WHERE bucket IN (${hourBucket()}, ${dayBucket()})
  `;
  let hour = 0;
  let day = 0;
  for (const r of rows) {
    if (r.bucket === hourBucket()) hour = r.count;
    if (r.bucket === dayBucket()) day = r.count;
  }
  return { hour, day };
}

export async function incrementCounters(): Promise<void> {
  await sql`
    INSERT INTO outbound_counters (bucket, count, updated_at)
    VALUES (${hourBucket()}, 1, now())
    ON CONFLICT (bucket)
    DO UPDATE SET count = outbound_counters.count + 1, updated_at = now()
  `;
  await sql`
    INSERT INTO outbound_counters (bucket, count, updated_at)
    VALUES (${dayBucket()}, 1, now())
    ON CONFLICT (bucket)
    DO UPDATE SET count = outbound_counters.count + 1, updated_at = now()
  `;
}
