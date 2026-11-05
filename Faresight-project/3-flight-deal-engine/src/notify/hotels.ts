// Per-user hotel deal notifications (owned by the user-data module). Stubs until implemented.
import type { Db } from '../db.ts';
export async function onHotelDealLive(db: Db, hotelDealId: number): Promise<{ users: number; instant: number; daily: number }> { return { users: 0, instant: 0, daily: 0 }; }
export async function onHotelDealEnded(db: Db, hotelDealId: number): Promise<{ users: number; instant: number; daily: number }> { return { users: 0, instant: 0, daily: 0 }; }
