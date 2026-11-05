import type { Handler } from "./http.ts";
// /admin/users pages (owned by the admin module). Called only after the admin login check.
export const handleAdminUsers: Handler = async () => false;
