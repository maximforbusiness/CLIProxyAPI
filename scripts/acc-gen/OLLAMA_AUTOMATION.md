# Ollama automation scripts

## Files

- `ollama-login.js` — one account auth flow (local Puppeteer backend)
- `ollama-login-browserapi.js` — one account auth flow via remote Browser API (SeleniumBase UC)
- `ollama-auto.sh` — batch wrapper for multiple accounts
- `ollama-auto.env.example` — env template
- `OLLAMA_AUTH_FLOW.md` — documented step-by-step flow

## Quick start

```bash
cd /web/ai-tools.su/gpt-api/cliproxyapi-src/scripts/acc-gen
cp ollama-auto.env.example ollama-auto.env
# fill HERO_SMS_API_KEY, OLLAMA_ROUTER_CONFIG_PATH, etc.
```

Prepare accounts file (`ollama-accounts.json`):

```json
[
  {
    "email": "user@example.com",
    "password": "YourMailboxPassword",
    "name": "User Name"
  }
]
```

Run one account (local backend):

```bash
./ollama-auto.sh --index 0 --env-file ./ollama-auto.env --browser-backend local
```

Run one account (remote browser API backend):

```bash
./ollama-auto.sh --index 0 --env-file ./ollama-auto.env --browser-backend browserapi
```

Run all accounts:

```bash
./ollama-auto.sh --all --env-file ./ollama-auto.env
```

## Notes

- Email verification code is fetched via IMAP automatically:
  - `OLLAMA_IMAP_HOST` (default: `imap.firstmail.ltd`)
  - `OLLAMA_IMAP_PORT` (default: `993`)
- If needed, you can override email code manually:
  - `OLLAMA_EMAIL_CODE=123456`
- SMS is fetched via Hero-SMS (`HERO_SMS_API_KEY` required).
- For remote backend set `BROWSER_API_KEY`.
- UK country is default (`HERO_SMS_COUNTRIES=44`).
- If `OLLAMA_ROUTER_CONFIG_PATH` is set, script tries to inject generated API key into config automatically.
