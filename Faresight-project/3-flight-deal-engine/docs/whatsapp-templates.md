# WhatsApp templates

WhatsApp lets a business send free text only within **24 hours** of the person's last message to it. Outside that
window only **message templates approved in Meta WhatsApp Manager** can be sent. Faresight does this automatically
(`src/notify/deliver.ts`, `src/notify/whatsapp.ts`):

- **Verification codes** always use the authentication template.
- **Alerts and digests** go as free text when the person wrote to us in the last 24 hours
  (`notification_channels.last_inbound_at`, set by the webhook below); otherwise as the matching template, filled
  from the deal as it is now.
- If Meta rejects a template (not approved, wrong parameters, paused, error 132xxx or 131047), the message is marked
  **failed** at once with the reason in `outbox.error` (admin outbox page). Rate limits and server errors are retried.

Create the five templates below in **WhatsApp Manager → Message templates → Create template**. Names and language
must match the env vars (defaults shown). Language: **English** (`en`), or set `WHATSAPP_TEMPLATE_LANG` to the code you
pick (e.g. `en_US`) – all templates must exist in that language.

Rules Meta applies to the variables (`{{1}}`, `{{2}}` …): they are filled in order, may not be empty and may not contain
newlines, tabs or more than 4 spaces in a row. Faresight cleans every value before sending.

## Unsubscribe

Every marketing and utility template has the footer **`Reply STOP to stop`**. When someone replies STOP,
UNSUBSCRIBE or BAND (any case), their WhatsApp channel is switched off and nothing more is sent to it (no reply is sent
either). START switches it back on. The free-text messages still carry the one-tap stop link.

## 1. Flight deal – `WHATSAPP_TEMPLATE_DEAL` (default `flight_deal_alert`)

- **Category:** Marketing
- **Header:** none (optional text header `Flight deal` is fine – it has no variables)
- **Body:**

  ```
  ✈️ {{1}} → {{2}}, return: {{3}} (normally {{4}}, {{5}} below).
  Travel: {{6}}.
  Prices change fast – check the dates before you book.
  ```

- **Footer:** `Reply STOP to stop`
- **Button:** Visit website → URL type **Dynamic** → `https://YOUR-DOMAIN/deal/{{1}}`, button text `See the deal`

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | from city | `Delhi` |
| `{{2}}` | to city | `Bangkok` |
| `{{3}}` | price | `₹13,000` |
| `{{4}}` | normal price | `₹20,000` |
| `{{5}}` | % below normal | `35%` |
| `{{6}}` | travel months | `Jan 2027 – Feb 2027` |
| button `{{1}}` | deal id | `123` |

## 2. Hotel deal – `WHATSAPP_TEMPLATE_HOTEL` (default `hotel_deal_alert`)

- **Category:** Marketing
- **Body:**

  ```
  🏨 {{1}} ({{2}}), {{3}}: {{4}} a night (normally {{5}}, {{6}} below).
  Check-in: {{7}}.
  Rates change fast – check the dates before you book.
  ```

- **Footer:** `Reply STOP to stop`
- **Button:** Visit website → Dynamic → `https://YOUR-DOMAIN/hotel-deal/{{1}}`, text `See the deal`

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | hotel name | `Sea View Resort` |
| `{{2}}` | stars | `4-star` (or `Unrated`) |
| `{{3}}` | city | `Goa` |
| `{{4}}` | price a night | `₹3,200` |
| `{{5}}` | normal price a night | `₹4,900` |
| `{{6}}` | % below normal | `35%` |
| `{{7}}` | check-in months | `Jan 2027` |
| button `{{1}}` | hotel deal id | `45` |

## 3. Deal ended – `WHATSAPP_TEMPLATE_ENDED` (default `deal_ended`)

- **Category:** Utility (it updates a deal the person asked about or saved)
- **Body:**

  ```
  Update on a deal you were following: the {{1}} has ended. {{2}}
  ```

- **Footer:** `Reply STOP to stop`
- **Button:** Visit website → Dynamic → `https://YOUR-DOMAIN/{{1}}`, text `View details`

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | what ended | `Delhi → Bangkok flight deal` / `Sea View Resort, Goa hotel deal` |
| `{{2}}` | reason | `Price rose to ₹15,500.` |
| button `{{1}}` | page path | `deal/123` / `hotel-deal/45` (the page shows the deal as ended) |

## 4. Daily digest – `WHATSAPP_TEMPLATE_DIGEST` (default `daily_deals`)

- **Category:** Marketing
- **Body:**

  ```
  {{1}}.
  Top picks: {{2}}
  ```

- **Footer:** `Reply STOP to stop`
- **Button:** Visit website → **Static** → `https://YOUR-DOMAIN/`, text `See all deals`

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | count line | `3 flight deals and 1 hotel deal for you today` |
| `{{2}}` | top 3 deals joined with ` \| ` (plus `+N more`) | `Delhi → Bangkok ₹13,000 (35% below) \| Mumbai → Dubai ₹14,500 (31% below) \| Sea View Resort, Goa ₹3,200/night (35% below) \| +1 more` |

## 5. Verification code – `WHATSAPP_TEMPLATE_CODE` (default `verify_code`)

- **Category:** Authentication
- **Code delivery:** **Copy code** (button text e.g. `Copy code`)
- **Content:** Meta's fixed text – `{{1}} is your verification code.`; tick "Add security recommendation"
  and set "Code expires in 10 minutes" if you like. Authentication templates cannot have a custom footer or
  STOP line (Meta does not allow it).
- Sample: `{{1}}` = `123456`.

Faresight sends the code as the body parameter and as the copy-code button parameter, as Meta requires:

```json
{ "type": "template", "template": { "name": "verify_code", "language": { "code": "en" }, "components": [
  { "type": "body", "parameters": [{ "type": "text", "text": "123456" }] },
  { "type": "button", "sub_type": "url", "index": "0", "parameters": [{ "type": "text", "text": "123456" }] } ] } }
```

## Env vars

| Key | Default | What |
|---|---|---|
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | – | Cloud API access (permanent system-user token) |
| `WHATSAPP_TEMPLATE_LANG` | `en` | Language code all templates are approved in |
| `WHATSAPP_TEMPLATE_DEAL` | `flight_deal_alert` | Template 1 |
| `WHATSAPP_TEMPLATE_HOTEL` | `hotel_deal_alert` | Template 2 |
| `WHATSAPP_TEMPLATE_ENDED` | `deal_ended` | Template 3 |
| `WHATSAPP_TEMPLATE_DIGEST` | `daily_deals` | Template 4 |
| `WHATSAPP_TEMPLATE_CODE` | `verify_code` | Template 5 |
| `WHATSAPP_VERIFY_TOKEN` | – | Any random string; typed into Meta when you set up the webhook |
| `WHATSAPP_APP_SECRET` | – | App secret (App settings → Basic); checks `X-Hub-Signature-256` on webhook calls. Set it in production |

## Webhook setup

The webhook tells Faresight when someone writes (opens the 24-hour window, STOP/START) and when a message failed.

1. Set `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` in `.env` and restart. The site must be reachable over HTTPS.
2. In the Meta app dashboard: **WhatsApp → Configuration → Webhook → Edit**.
   - **Callback URL:** `https://YOUR-DOMAIN/webhooks/whatsapp`
   - **Verify token:** the value of `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and save** (Meta calls `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`;
     Faresight answers with the challenge, or 403 if the token is wrong).
3. Under **Webhook fields**, **Subscribe** to `messages` (this carries both incoming messages and delivery statuses).
4. Send "hi" from your phone to the business number and check `notification_channels.last_inbound_at` for that number.

What the webhook does:

- Every incoming message: `last_inbound_at = now()` on WhatsApp channels whose number (digits only) equals the sender.
- `STOP` / `UNSUBSCRIBE` / `BAND`: those channels are switched off; `START`: switched back on.
- Status `failed`: the outbox row with that message id (`outbox.meta.wamid`) and its notifications are marked failed with Meta's error.
- Requests with a wrong signature get 401 (when `WHATSAPP_APP_SECRET` is set); everything else gets 200 straight away.
