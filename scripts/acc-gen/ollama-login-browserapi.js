#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ACCOUNTS_FILE = process.env.OLLAMA_ACCOUNTS_FILE
  ? path.resolve(process.env.OLLAMA_ACCOUNTS_FILE)
  : path.join(__dirname, 'ollama-accounts.json');

const ACCOUNT_INDEX = parseInt(process.argv[2] || '0', 10) || 0;
const BROWSER_API_URL = String(process.env.BROWSER_API_URL || 'https://browser.ai-tools.su/api').trim();
const BROWSER_API_KEY = String(process.env.BROWSER_API_KEY || process.env.X_API_KEY || '7i2WotNB').trim();

const HERO_SMS_BASE_URL = process.env.HERO_SMS_BASE_URL || 'https://hero-sms.com/stubs/handler_api.php';
const HERO_SMS_SERVICE = (process.env.HERO_SMS_SERVICE || 'dr').trim();
const HERO_SMS_COUNTRIES = String(process.env.HERO_SMS_COUNTRIES || '44').split(',').map((x) => x.trim()).filter(Boolean);
const HERO_SMS_API_KEY = String(process.env.HERO_SMS_API_KEY || '').trim();
const HERO_SMS_POLL_TIMEOUT_SEC = Math.max(60, parseInt(process.env.HERO_SMS_POLL_TIMEOUT_SEC || '300', 10) || 300);
const HERO_SMS_POLL_INTERVAL_MS = Math.max(2000, parseInt(process.env.HERO_SMS_POLL_INTERVAL_MS || '3000', 10) || 3000);
const HERO_SMS_MAX_COUNTRY_ATTEMPTS = Math.max(1, parseInt(process.env.HERO_SMS_MAX_COUNTRY_ATTEMPTS || '5', 10) || 5);

const EMAIL_IMAP_HOST = String(process.env.OLLAMA_IMAP_HOST || 'imap.firstmail.ltd').trim();
const EMAIL_IMAP_PORT = Math.max(1, parseInt(process.env.OLLAMA_IMAP_PORT || '993', 10) || 993);
const EMAIL_CODE_WAIT_SEC = Math.max(20, parseInt(process.env.OLLAMA_EMAIL_CODE_WAIT_SEC || '90', 10) || 90);

const OLLAMA_ROUTER_CONFIG_PATH = String(process.env.OLLAMA_ROUTER_CONFIG_PATH || '').trim();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shellEscapeSingleQuotes(value) {
  return String(value || '').replace(/'/g, "'\\''");
}

function readAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    throw new Error(`Accounts file not found: ${ACCOUNTS_FILE}`);
  }
  const rows = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Accounts file is empty');
  }
  const idx = Math.min(Math.max(0, ACCOUNT_INDEX), rows.length - 1);
  return { account: rows[idx], idx, total: rows.length };
}

function postJSON(url, body, headers = {}, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body || {});
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: `${u.pathname}${u.search}`,
      port: u.port || 443,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      },
      timeout: timeoutMs
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c.toString(); });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${out}`));
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${out}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function browserCmd(payload) {
  const resp = await postJSON(BROWSER_API_URL, payload, { 'X-API-Key': BROWSER_API_KEY });
  if (resp && resp.error) throw new Error(`${payload.cmd || 'cmd'}: ${resp.error}: ${resp.message || ''}`.trim());
  return resp;
}

async function browserJS(expression) {
  const r = await browserCmd({ cmd: 'js', expression });
  return r && typeof r.result !== 'undefined' ? r.result : '';
}

async function waitForCondition(checkFn, timeoutSec = 60, pollMs = 1000, label = '') {
  const deadline = Date.now() + timeoutSec * 1000;
  let nextLogAt = Date.now();
  while (Date.now() < deadline) {
    const ok = await checkFn();
    if (ok) return true;

    if (label && Date.now() >= nextLogAt) {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      console.log(`[wait] ${label}: ${left}s left`);
      nextLogAt = Date.now() + 10000;
    }

    await sleep(pollMs);
  }
  return false;
}

async function getVerificationCodeFromIMAP(email, password, waitSeconds = EMAIL_CODE_WAIT_SEC) {
  if (!email || !password) return null;
  const safeEmail = shellEscapeSingleQuotes(email);
  const safePassword = shellEscapeSingleQuotes(password);
  const safeHost = shellEscapeSingleQuotes(EMAIL_IMAP_HOST);

  const start = Date.now();
  while (Date.now() - start < waitSeconds * 1000) {
    try {
      const result = execSync(`python3 -c "
import imaplib
import email as email_lib
import re
imap = imaplib.IMAP4_SSL('${safeHost}', ${EMAIL_IMAP_PORT})
imap.login('${safeEmail}', '${safePassword}')
imap.select('INBOX')
status, msgs = imap.search(None, 'ALL')
code = ''
if msgs[0]:
    for num in reversed(msgs[0].split()[-5:]):
        status, data = imap.fetch(num, '(RFC822)')
        if not data or not data[0]:
            continue
        msg = email_lib.message_from_bytes(data[0][1])
        subject = msg.get('Subject', '')
        body = ''
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() in ('text/plain','text/html'):
                    payload = part.get_payload(decode=True)
                    if payload:
                        body = payload.decode('utf-8', errors='ignore')
                        break
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                body = payload.decode('utf-8', errors='ignore')
        m = re.search(r'\\b(\\d{6})\\b', subject + ' ' + body)
        if m:
            code = m.group(1)
            break
imap.close(); imap.logout(); print(code)
"`, { encoding: 'utf8', timeout: 15000 });
      const code = String(result || '').trim();
      if (/^\d{6}$/.test(code)) return code;
    } catch (_) {}
    await sleep(3000);
  }
  return null;
}

function heroSmsRequest(params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const url = new URL(HERO_SMS_BASE_URL);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v) !== '') url.searchParams.set(k, String(v));
    });
    url.searchParams.set('api_key', HERO_SMS_API_KEY);

    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`hero_sms_http_${res.statusCode}:${body}`));
        resolve(String(body || '').trim());
      });
    });
    req.on('timeout', () => req.destroy(new Error('hero_sms_timeout')));
    req.on('error', reject);
  });
}

function parseHeroActivation(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('ACCESS_NUMBER:')) return null;
  const p = text.split(':');
  if (p.length < 3) return null;
  return { id: String(p[1] || '').trim(), phone: String(p[2] || '').trim() };
}

function parseHeroStatusCode(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('STATUS_OK:')) return '';
  return text.slice('STATUS_OK:'.length).trim();
}

async function heroSmsAcquireActivation(country, service) {
  const raw = await heroSmsRequest({ action: 'getNumber', service, country });
  const activation = parseHeroActivation(raw);
  if (!activation || !activation.id || !activation.phone) throw new Error(`hero_sms_get_number_failed:${raw}`);
  return { ...activation, country, service };
}

async function heroSmsSetStatus(activationId, status) {
  if (!activationId) return '';
  try {
    return await heroSmsRequest({ action: 'setStatus', id: activationId, status });
  } catch (e) {
    return `ERR:${e.message}`;
  }
}

async function heroSmsWaitForCode(activationId) {
  const deadline = Date.now() + HERO_SMS_POLL_TIMEOUT_SEC * 1000;
  let last = 'STATUS_WAIT_CODE';
  while (Date.now() < deadline) {
    const raw = await heroSmsRequest({ action: 'getStatus', id: activationId });
    last = String(raw || '').trim();
    const code = parseHeroStatusCode(last);
    if (code) return code;
    if (/STATUS_CANCEL|STATUS_WAIT_RETRY|BAD_STATUS|BAD_KEY/i.test(last)) {
      throw new Error(`hero_sms_status_failed:${last}`);
    }
    await sleep(HERO_SMS_POLL_INTERVAL_MS);
  }
  throw new Error(`hero_sms_code_timeout:${last}`);
}

function appendApiKeyToRouterConfig(apiKey) {
  if (!OLLAMA_ROUTER_CONFIG_PATH) return { updated: false, reason: 'config_path_not_set' };
  try {
    if (!fs.existsSync(OLLAMA_ROUTER_CONFIG_PATH)) return { updated: false, reason: `config_not_found:${OLLAMA_ROUTER_CONFIG_PATH}` };
    const source = fs.readFileSync(OLLAMA_ROUTER_CONFIG_PATH, 'utf8');
    if (source.includes(apiKey)) return { updated: false, reason: 'api_key_already_present' };

    const lines = source.split(/\r?\n/);
    let ollamaIdx = lines.findIndex((x) => /^\s*-?\s*name:\s*Ollama\s*$/i.test(x));
    if (ollamaIdx < 0) {
      lines.push('', '- name: Ollama', '  base-url: https://ollama.com/v1', '  api-key-entries:', `    - api-key: ${apiKey}`);
    } else {
      let blockEnd = lines.length;
      for (let i = ollamaIdx + 1; i < lines.length; i++) {
        if (/^\s*-\s*name:\s+/i.test(lines[i])) { blockEnd = i; break; }
      }
      let apiIdx = -1;
      for (let i = ollamaIdx; i < blockEnd; i++) {
        if (/^\s*api-key-entries:\s*$/i.test(lines[i])) { apiIdx = i; break; }
      }
      if (apiIdx >= 0) {
        const indent = (lines[apiIdx].match(/^\s*/) || [''])[0];
        lines.splice(apiIdx + 1, 0, `${indent}  - api-key: ${apiKey}`);
      } else {
        const indent = ((lines[ollamaIdx].match(/^\s*/) || [''])[0]) + '  ';
        lines.splice(blockEnd, 0, `${indent}api-key-entries:`, `${indent}  - api-key: ${apiKey}`);
      }
    }
    fs.writeFileSync(OLLAMA_ROUTER_CONFIG_PATH, lines.join('\n'));
    return { updated: true, path: OLLAMA_ROUTER_CONFIG_PATH };
  } catch (e) {
    return { updated: false, reason: e.message };
  }
}

async function main() {
  const { account, idx, total } = readAccounts();
  if (!account || !account.email || !account.password) throw new Error('Account must include email and password');

  console.log(`Browser API mode | account ${idx + 1}/${total} | ${account.email}`);

  const status = await browserCmd({ cmd: 'status' });
  console.log(`Browser API alive=${!!status.alive}, uc_mode=${!!status.seleniumbase_uc_mode}`);

  await browserCmd({ cmd: 'navigate', url: 'https://signin.ollama.com/sign-up' });
  await browserCmd({ cmd: 'type', selector: 'input[name="email"]', text: account.email });
  await browserCmd({ cmd: 'click', selector: 'button[type="submit"]' });

  const hasPassword = await waitForCondition(async () => {
    const raw = await browserJS('return JSON.stringify({p:!!document.querySelector("input[type=password]")})');
    try { return JSON.parse(raw).p; } catch { return false; }
  }, Number(process.env.OLLAMA_PASSWORD_STEP_TIMEOUT_SEC || 90), 1500, 'password step');

  if (!hasPassword) {
    const info = await browserCmd({ cmd: 'page_info' });
    const txtRaw = await browserJS('return (document.body && document.body.innerText) ? document.body.innerText.slice(0,260) : ""').catch(() => '');
    const txt = String(txtRaw || '').toLowerCase();
    const hint = txt.includes('be sure you are human') || txt.includes('verify you are human') || txt.includes('captcha')
      ? ' (human-check still active)'
      : '';
    throw new Error(`Password step not reached${hint}. url=${info.url || ''} title=${info.title || ''}`);
  }

  await browserCmd({ cmd: 'type', selector: 'input[type="password"]', text: account.password });
  await browserCmd({ cmd: 'click', selector: 'button[type="submit"]' });

  const hasEmailCodeInput = await waitForCondition(async () => {
    const raw = await browserJS('return JSON.stringify({c:!!document.querySelector("input[autocomplete=\\"one-time-code\\"],input[name*=\\"code\\"],input[maxlength=\\"6\\"]")})');
    try { return JSON.parse(raw).c; } catch { return false; }
  }, Number(process.env.OLLAMA_EMAIL_CODE_STEP_TIMEOUT_SEC || 120), 1500, 'email-code step');

  if (hasEmailCodeInput) {
    let emailCode = String(process.env.OLLAMA_EMAIL_CODE || '').trim();
    if (!/^\d{6}$/.test(emailCode)) {
      emailCode = await getVerificationCodeFromIMAP(account.email, account.password, EMAIL_CODE_WAIT_SEC);
    }
    if (!/^\d{6}$/.test(emailCode)) throw new Error('Email verification code not found');

    await browserCmd({ cmd: 'type', selector: 'input[autocomplete="one-time-code"],input[name*="code"],input[maxlength="6"]', text: emailCode });
    await browserCmd({ cmd: 'click', selector: 'button[type="submit"]' });
  }

  if (!HERO_SMS_API_KEY) throw new Error('HERO_SMS_API_KEY is required for phone verification');

  let phoneVerified = false;
  let lastSmsErr = 'no_attempts';
  for (let i = 0; i < HERO_SMS_MAX_COUNTRY_ATTEMPTS && !phoneVerified; i++) {
    const country = HERO_SMS_COUNTRIES[i % HERO_SMS_COUNTRIES.length];
    let activation = null;
    try {
      activation = await heroSmsAcquireActivation(country, HERO_SMS_SERVICE);
      await heroSmsSetStatus(activation.id, 1);

      const phoneCandidate = activation.phone.startsWith('+') ? activation.phone : `+${activation.phone}`;
      await browserCmd({ cmd: 'type', selector: 'input[type="tel"],input[name*="phone"],input[inputmode="tel"]', text: phoneCandidate });
      await browserCmd({ cmd: 'click', selector: 'button[type="submit"],button' });

      const smsCode = await heroSmsWaitForCode(activation.id);

      await browserCmd({ cmd: 'type', selector: 'input[autocomplete="one-time-code"],input[name*="code"],input[maxlength="6"]', text: smsCode });
      await browserCmd({ cmd: 'type', selector: 'input[type="tel"],input[name*="phone"],input[inputmode="tel"]', text: phoneCandidate });
      await browserCmd({ cmd: 'click', selector: 'button[type="submit"],button' });

      await sleep(3000);
      const info = await browserCmd({ cmd: 'page_info' });
      const u = String((info && info.url) || '').toLowerCase();
      if (u.includes('phone') || u.includes('verify')) throw new Error('phone_verification_still_required');

      await heroSmsSetStatus(activation.id, 6);
      phoneVerified = true;
    } catch (e) {
      lastSmsErr = e.message;
      if (activation && activation.id) await heroSmsSetStatus(activation.id, 8);
    }
  }

  if (!phoneVerified) throw new Error(`Phone verification failed: ${lastSmsErr}`);

  await browserCmd({ cmd: 'navigate', url: 'https://ollama.com/settings/keys' });
  await sleep(2000);

  await browserCmd({ cmd: 'click', selector: 'button' }).catch(() => {});
  await browserCmd({ cmd: 'js', expression: `
    (function(){
      const nodes=[...document.querySelectorAll('button,[role="button"],a')];
      const first = nodes.find(n => /add api key|new key|create key/i.test((n.innerText||'').trim()));
      if(first){first.click(); return 'add_clicked';}
      return 'add_not_found';
    })();
  `}).catch(() => {});

  await sleep(1000);
  await browserCmd({ cmd: 'js', expression: `
    (function(){
      const nodes=[...document.querySelectorAll('button,[role="button"],a')];
      const first = nodes.find(n => /generate|create|confirm/i.test((n.innerText||'').trim()));
      if(first){first.click(); return 'gen_clicked';}
      return 'gen_not_found';
    })();
  `}).catch(() => {});

  await sleep(2500);

  const keyRaw = await browserJS(`
    return (function(){
      const candidates = [];
      const codeNodes = [...document.querySelectorAll('code, pre, input, [data-testid*="key" i], [class*="key" i]')];
      for (const n of codeNodes) {
        const val = (n.value || n.innerText || n.textContent || '').trim();
        if (!val || /\s/.test(val)) continue;
        if (val.length >= 20) candidates.push(val);
      }
      const body = (document.body && document.body.innerText) ? document.body.innerText : '';
      const m = body.match(/(sk-[A-Za-z0-9_-]{20,})/);
      if (m) candidates.unshift(m[1]);
      return JSON.stringify(candidates.slice(0, 10));
    })();
  `);

  let apiKey = '';
  try {
    const arr = JSON.parse(String(keyRaw || '[]'));
    apiKey = (arr && arr[0]) ? String(arr[0]).trim() : '';
  } catch (_) {}
  if (!apiKey) throw new Error('Could not extract API key from page');

  const result = {
    email: account.email,
    api_key: apiKey,
    status: 'success',
    timestamp: new Date().toISOString(),
    mode: 'browser_api'
  };

  const outPath = path.join(__dirname, 'ollama-results.json');
  const prev = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : [];
  prev.push(result);
  fs.writeFileSync(outPath, JSON.stringify(prev, null, 2));

  const cfg = appendApiKeyToRouterConfig(apiKey);

  console.log('SUCCESS');
  console.log(`Email: ${account.email}`);
  console.log(`API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log(`Result file: ${outPath}`);
  console.log(`Config update: ${cfg.updated ? 'updated' : `not updated (${cfg.reason})`}`);

  try { await browserCmd({ cmd: 'close' }); } catch (_) {}
}

main().catch(async (e) => {
  console.error(`ERROR: ${e.message}`);
  try { await browserCmd({ cmd: 'screenshot' }); } catch (_) {}
  process.exit(1);
});
