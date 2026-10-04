# Pyramid Golds chat backend

A Cloudflare Worker behind the chat widget (`chat.js`) on pyramidgolds.in. It does three things:

1. **Chat**: answers customers with OpenAI (`gpt-4o-mini` by default) using the prompt in `src/prompt.js`.
2. **Leads**: the `log_lead` tool appends `Time | Name | Contact | Inquiry | Pending` to a Google Sheet.
3. **Owner ping**: the `notify_owner` tool sends the owner a WhatsApp template with three buttons
   (Here now / Back later / Busy). The widget polls `/ping/:id`; the owner's reply comes back through the
   WhatsApp webhook. After `PING_TIMEOUT_SEC` (180 s) with no answer, the customer is asked for their number.
   Pings only go out between `OPEN_HOUR` and `CLOSE_HOUR` (India time), once per chat and 3 per hour per visitor.

The site stays on GitHub Pages. `_config.yml` keeps this folder off the public site.

## One-time setup (all in the client's own accounts)

### 1. OpenAI
Create an API key at platform.openai.com → API keys. Add a small monthly budget limit under Billing → Limits.

### 2. Google Sheet
1. Create a Google Sheet with a tab named `Leads` and headers `Time | Name | Contact | Inquiry | Status` in row 1.
2. In Google Cloud Console: create a project, enable the **Google Sheets API**, create a **service account**, and add a JSON key.
3. Share the sheet with the service account's email (Editor). Don't share it with anyone else except the owner.
4. Note the sheet ID (the long part of the sheet URL between `/d/` and `/edit`).

### 3. WhatsApp (Meta Cloud API)
The business number +91 80825 56365 is already the shop's WhatsApp. To keep using it in the WhatsApp Business app
**and** send pings from it, onboard it to the Cloud API with Meta's **coexistence** option
("connect an existing WhatsApp Business app number") in WhatsApp Manager. Without coexistence the number would
have to leave the app.

1. In Meta Business Suite → WhatsApp Manager, add the number (coexistence) and note its **Phone number ID**.
2. Create a **System user** with a permanent access token that has `whatsapp_business_messaging`.
3. Create a message template:
   - Name: `owner_floor_check`, category **Utility**, language **English**
   - Body: `Website visitor: {{1}}. Are you on the store floor now?`
   - Buttons (Quick reply): `Here now`, `Back later`, `Busy`
4. Webhook (after the Worker is deployed, step 4): callback URL `https://<worker-url>/whatsapp/webhook`,
   verify token = the `WA_VERIFY_TOKEN` you choose, subscribe to the **messages** field.
5. Note the **App secret** (App settings → Basic). It is used to check that webhook calls really come from Meta.

The owner's number (+60 14-892 7013) receives the pings. It is set in `wrangler.toml` as `WA_OWNER_NUMBER`.

### 4. Deploy the Worker
```bash
cd backend
npx wrangler login
npx wrangler kv namespace create STATE        # paste the id into wrangler.toml
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put WA_TOKEN
npx wrangler secret put WA_PHONE_NUMBER_ID
npx wrangler secret put WA_VERIFY_TOKEN       # any long random string; reuse it in Meta's webhook setup
npx wrangler secret put WA_APP_SECRET
npx wrangler secret put GOOGLE_SA_EMAIL
npx wrangler secret put GOOGLE_SA_KEY         # the private_key value from the JSON key, including BEGIN/END lines
npx wrangler secret put SHEET_ID
npx wrangler deploy                           # prints the Worker URL
```

### 5. Switch on the widget
In `index.html`, set the Worker URL on the chat script tag and push:
```html
<script src="chat.js" data-api="https://pyramidgolds-chat.<account>.workers.dev" defer></script>
```
While `data-api` is empty, the widget stays hidden.

## Settings (`wrangler.toml` → `[vars]`)
| Name | Default | What it does |
| --- | --- | --- |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model |
| `OPEN_HOUR` / `CLOSE_HOUR` | `10` / `20` | Store hours in India time; no owner pings outside them |
| `PING_TIMEOUT_SEC` | `180` | How long the customer waits for the owner |
| `WA_OWNER_NUMBER` | `60148927013` | Owner's WhatsApp, digits only |
| `ALLOWED_ORIGINS` | pyramidgolds.in | Sites allowed to call the Worker |

## Tests
```bash
cd backend && node --test
```
They run the Worker against fake OpenAI, WhatsApp, Google and KV services.
