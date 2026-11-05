// Hotel deal lifecycle (owned by the hotel engine module). Stub signatures; replaced by the implementation.
import type { Db } from '../db.ts';
import type { HotelNotify } from './contract.ts';
/** Admin decision on a hotel deal in 'review'. Approve -> live (+ notify), reject -> rejected. */
export async function reviewHotelDeal(db: Db, hotelDealId: number, approve: boolean, notify: HotelNotify): Promise<void> {}
