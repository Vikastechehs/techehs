import type { Handler } from "./http.ts";
// /admin/hotels (owned by the hotel website module). Called only after the admin login check.
export const handleAdminHotels: Handler = async () => false;
