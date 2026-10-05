# Pyramid Golds chat backend

A Cloudflare Worker behind the chat widget (`chat.js`) on pyramidgolds.in. It does three things:

1. **Chat**: answers customers with OpenAI (`gpt-4o-mini` by default) using the prompt in `src/prompt.js`.
2. **Leads**: the `log_lead` tool appends `Time | Name | Contact | Inquiry | Pending` to a Google Sheet through
   a small Apps Script on the sheet (`apps-script.gs`).
3. **Owner ping**: the `notify_owner` tool sends the owner a WhatsApp template with three buttons
   (Here now / Back later / Busy). The widget polls `/ping/:id`; the owner's reply comes back through the
   WhatsApp webhook. After `PING_TIMEOUT_SEC` (180 s) with no answer, the customer is asked for their number.
   Pings only go out between `OPEN_HOUR` and `CLOSE_HOUR` (India time), once per chat and 3 per hour per visitor.

The site stays on GitHub Pages. `_config.yml` keeps this folder off the public site.

## One-time setup (all in the client's own accounts)

### 1. OpenAI
Create an API key at platform.openai.com → API keys. Add a small monthly budget limit under Billing → Limits.

### 2. Google Sheet (free, no Google Cloud account needed)
1. Create a Google Sheet (the existing **Leads** sheet is fine). Leads go into a tab named `Leads`; the script adds
   the header row by itself.
2. Make up a long random password for the sheet, e.g. 30+ letters and numbers. This is `SHEET_WEBHOOK_SECRET`.
3. In the sheet: **Extensions → Apps Script**. Delete what's there, paste the contents of `backend/apps-script.gs`,
   and put your password in the `SECRET` line. Save.
4. **Deploy → New deployment →** gear icon **→ Web app**. Execute as: **Me**. Who has access: **Anyone**. Deploy,
   and allow the permissions Google asks for (Advanced → Go to project, if it warns you).
5. Copy the **Web app URL** (ends in `/exec`). This is `SHEET_WEBHOOK_URL`.

The URL alone can't write anything: every request must carry the password, and only the sheet's owner can see the
data. If you edit the script later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

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
4. Webhook (after the Worker is deployed in step 5): callback URL `https://<worker-url>/whatsapp/webhook`,
   verify token = the `WA_VERIFY_TOKEN` you choose, subscribe to the **messages** field.
5. Note the **App secret** (App settings → Basic). It is used to check that webhook calls really come from Meta.

The owner's number (+60 14-892 7013) receives the pings. It is set in `wrangler.toml` as `WA_OWNER_NUMBER`.

### 4. Cloudflare
1. Create a free Cloudflare account, open **Workers & Pages** once (this creates the `workers.dev` subdomain).
2. Note the **Account ID** (right-hand side of the Workers & Pages overview).
3. My Profile → API Tokens → Create Token → template **Edit Cloudflare Workers**. Make sure it also has
   **Account → Workers KV Storage → Edit**.

### 5. Add the keys to GitHub (deploys automatically)
In the repo: **Settings → Secrets and variables → Actions → New repository secret**, add each of these:

| Secret | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Step 4.3 |
| `CLOUDFLARE_ACCOUNT_ID` | Step 4.2 |
| `API_KEY_OPEN_AI` | Step 1 (the OpenAI key) |
| `SHEET_WEBHOOK_URL` | Step 2.5 |
| `SHEET_WEBHOOK_SECRET` | Step 2.2 |
| `WA_TOKEN` | Step 3.2 (permanent system-user token) |
| `WA_PHONE_NUMBER_ID` | Step 3.1 |
| `WA_APP_SECRET` | Step 3.5 |
| `WA_VERIFY_TOKEN` | Any long random string you make up; type the same value in Meta's webhook setup |

Then **Actions → Deploy chat backend → Run workflow**. It runs the tests, creates the KV store, deploys the
Worker, uploads the keys, and switches on the chat button on the site. The run summary shows the WhatsApp
webhook callback URL to paste into Meta (step 3.4). It also re-deploys on every change to `backend/`.

Manual alternative from a computer: `cd backend && npx wrangler login`, create the KV namespace and paste its id
into `wrangler.toml`, `npx wrangler secret put <NAME>` for each key above, `npx wrangler deploy`, then set
`data-api` on the `chat.js` script tag in `index.html` to the Worker URL. While `data-api` is empty, the chat
button stays hidden.

## Settings (`wrangler.toml` → `[vars]`)
| Name | Default | What it does |
| --- | --- | --- |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model |
| `OPEN_HOUR` / `CLOSE_HOUR` | `10` / `21` | Store hours in India time; no owner pings outside them |
| `PING_TIMEOUT_SEC` | `180` | How long the customer waits for the owner |
| `WA_OWNER_NUMBER` | `60148927013` | Owner's WhatsApp, digits only |
| `ALLOWED_ORIGINS` | pyramidgolds.in | Sites allowed to call the Worker |

## Tests
```bash
cd backend && node --test
```
They run the Worker against fake OpenAI, WhatsApp, Apps Script and KV services.
