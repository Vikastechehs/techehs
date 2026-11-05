// Outbox: every outgoing message is stored first, then delivered by the outbox worker. CONTRACT (owned by the notifications module).
import type { Db } from '../db.ts';

export type OutChannel = 'email' | 'telegram' | 'whatsapp' | 'push';
export interface OutMessage { channel: OutChannel; to: string; subject?: string; body: string; meta?: unknown }

/** Stores a message for delivery; returns the outbox id. Never throws for a missing provider. */
export async function enqueue(db: Db, m: OutMessage): Promise<number> {
  const [r] = await db.query(`INSERT INTO outbox (channel, to_address, subject, body, meta) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [m.channel, m.to, m.subject ?? null, m.body, m.meta == null ? null : JSON.stringify(m.meta)]);
  return Number(r.id);
}

/** Erases stored messages to these addresses (email, phone, Telegram chat id, push endpoint), whatever their status. Returns rows deleted. */
export async function forgetAddress(db: Db, addresses: string[]): Promise<number> {
  const list = addresses.filter(a => typeof a === 'string' && a.length > 0);
  if (!list.length) return 0;
  const rows = await db.query(`DELETE FROM outbox WHERE to_address = ANY($1::text[]) OR lower(to_address) = ANY($2::text[]) RETURNING id`,
    [list, list.map(a => a.toLowerCase())]);
  return rows.length;
}
