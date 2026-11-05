import type { Handler } from "./http.ts";
// Incoming webhooks: /webhooks/whatsapp (owned by the WhatsApp module).
export const handleWebhooks: Handler = async () => false;
