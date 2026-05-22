import type postgres from 'postgres';

type AnySql =
  | postgres.Sql<Record<string, unknown>>
  | postgres.TransactionSql<Record<string, unknown>>;

export async function isDuplicate(tx: AnySql, messageIdHdr: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM messages WHERE message_id_hdr = ${messageIdHdr} LIMIT 1
  `;
  return rows.length > 0;
}
