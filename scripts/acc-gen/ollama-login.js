#!/usr/bin/env node

/**
 * Ollama.com Auto Login Script
 * 
 * Flow:
 * 1. Sign up page → Email input
 * 2. Password page → Password input
 * 3. Email verification → 6-digit code from email
 * 4. Phone verification → SMS via Hero-SMS (UK, "other" category)
 * 5. API Key generation → ollama.com/settings/keys
 * 
 * Usage:
 *   node ollama-login.js [account_index]
 * 
 * Environment variables:
 *   HERO_SMS_API_KEY, HERO_SMS_COUNTRIES, HERO_SMS_SERVICE, etc.
 *   CODEX_BROWSER_ENGINE, CODEX_SCREENSHOTS, etc.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Load accounts from accounts.json
const ACCOUNTS_FILE = process.env.OLLAMA_ACCOUNTS_FILE
    ? path.resolve(process.env.OLLAMA_ACCOUNTS_FILE)
    : path.join(__dirname, 'accounts.json');
let ACCOUNTS = [];

if (fs.existsSync(ACCOUNTS_FILE)) {
    ACCOUNTS = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    console.log(`Loaded ${ACCOUNTS.length} account(s) from ${ACCOUNTS_FILE}`);
} else {
    ACCOUNTS = [{
        email: 'test@example.com',
        password: 'TestPassword123!',
        name: 'Test User'
    }];
}

const ACCOUNT_INDEX = parseInt(process.argv[2]) || 0;
const ACCOUNT = ACCOUNTS[Math.min(ACCOUNT_INDEX, ACCOUNTS.length - 1)];

// SMS Configuration
const HERO_SMS_BASE_URL = process.env.HERO_SMS_BASE_URL || 'https://hero-sms.com/stubs/handler_api.php';
const HERO_SMS_SERVICE = (process.env.HERO_SMS_SERVICE || 'dr').trim(); // "dr" = другие/other
const HERO_SMS_COUNTRIES = String(process.env.HERO_SMS_COUNTRIES || '44') // UK
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const HERO_SMS_POLL_TIMEOUT_SEC = Math.max(60, parseInt(process.env.HERO_SMS_POLL_TIMEOUT_SEC || '300', 10) || 300); // 5 min for Ollama
const HERO_SMS_POLL_INTERVAL_MS = Math.max(2000, parseInt(process.env.HERO_SMS_POLL_INTERVAL_MS || '3000', 10) || 3000);
const HERO_SMS_MAX_COUNTRY_ATTEMPTS = Math.max(1, parseInt(process.env.HERO_SMS_MAX_COUNTRY_ATTEMPTS || '5', 10) || 5);
const HERO_SMS_API_KEY = String(process.env.HERO_SMS_API_KEY || '').trim();

// Browser Configuration
const SCREENSHOT_MODE = String(process.env.CODEX_SCREENSHOTS || 'off').trim().toLowerCase();
const ENABLE_SCREENSHOTS = SCREENSHOT_MODE === '1' || SCREENSHOT_MODE === 'true' || SCREENSHOT_MODE === 'all';
const BROWSER_ENGINE = normalizeBrowserEngine(process.env.OLLAMA_BROWSER_ENGINE || process.env.CODEX_BROWSER_ENGINE || 'auto');

// Timeouts
const EMAIL_INPUT_TIMEOUT_MS = Math.max(5000, parseInt(process.env.OLLAMA_EMAIL_INPUT_TIMEOUT_MS || '10000', 10) || 10000);
const PASSWORD_INPUT_TIMEOUT_MS = Math.max(5000, parseInt(process.env.OLLAMA_PASSWORD_INPUT_TIMEOUT_MS || '10000', 10) || 10000);
const EMAIL_CODE_INPUT_TIMEOUT_MS = Math.max(5000, parseInt(process.env.OLLAMA_EMAIL_CODE_TIMEOUT_MS || '15000', 10) || 15000);
const PHONE_INPUT_TIMEOUT_MS = Math.max(5000, parseInt(process.env.OLLAMA_PHONE_INPUT_TIMEOUT_MS || '15000', 10) || 15000);
const SMS_CODE_INPUT_TIMEOUT_MS = Math.max(10000, parseInt(process.env.OLLAMA_SMS_CODE_TIMEOUT_MS || '30000', 10) || 30000);
const API_KEY_PAGE_TIMEOUT_MS = Math.max(5000, parseInt(process.env.OLLAMA_API_KEY_PAGE_TIMEOUT_MS || '15000', 10) || 15000);
const NAVIGATION_TIMEOUT_MS = Math.max(10000, parseInt(process.env.OLLAMA_NAVIGATION_TIMEOUT_MS || '30000', 10) || 30000);
const OLLAMA_ROUTER_CONFIG_PATH = String(process.env.OLLAMA_ROUTER_CONFIG_PATH || '').trim();
const HUMAN_CHECK_TIMEOUT_SEC = Math.max(30, parseInt(process.env.OLLAMA_HUMAN_CHECK_TIMEOUT_SEC || '240', 10) || 240);
const STEP_WAIT_POLL_MS = Math.max(500, parseInt(process.env.OLLAMA_STEP_WAIT_POLL_MS || '1000', 10) || 1000);
const ALLOW_MANUAL_HUMAN_CHECK = ['1', 'true', 'yes', 'on'].includes(String(process.env.OLLAMA_ALLOW_MANUAL_HUMAN_CHECK || '').toLowerCase());

// Email IMAP configuration (for automatic 6-digit code retrieval)
const EMAIL_IMAP_HOST = String(process.env.OLLAMA_IMAP_HOST || 'imap.firstmail.ltd').trim();
const EMAIL_IMAP_PORT = Math.max(1, parseInt(process.env.OLLAMA_IMAP_PORT || '993', 10) || 993);
const EMAIL_CODE_WAIT_SEC = Math.max(20, parseInt(process.env.OLLAMA_EMAIL_CODE_WAIT_SEC || '90', 10) || 90);

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];

let activeBrowser = null;
let cleanupPromise = null;
let signalHandlersInstalled = false;

// ============================================================================
// Utility Functions
// ============================================================================

function normalizeBrowserEngine(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v || v === 'auto') return 'auto';
    if (v === 'playright') return 'playwright';
    if (v === 'playwright') return 'playwright';
    if (v === 'puppeteer') return 'puppeteer';
    return 'auto';
}

function browserEngineOrder(value) {
    if (value === 'playwright') return ['playwright', 'puppeteer'];
    if (value === 'puppeteer') return ['puppeteer', 'playwright'];
    return ['puppeteer', 'playwright'];
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellEscapeSingleQuotes(value) {
    return String(value || '').replace(/'/g, "'\\''");
}

async function promptEnter(message) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return;
    }
    await new Promise((resolve) => {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(message, () => {
            rl.close();
            resolve();
        });
    });
}

async function getVerificationCodeFromIMAP(email, password, waitSeconds = EMAIL_CODE_WAIT_SEC) {
    if (!email || !password) {
        return null;
    }

    const safeEmail = shellEscapeSingleQuotes(email);
    const safePassword = shellEscapeSingleQuotes(password);
    const safeHost = shellEscapeSingleQuotes(EMAIL_IMAP_HOST);
    const safePort = EMAIL_IMAP_PORT;
    const startTime = Date.now();

    while (Date.now() - startTime < waitSeconds * 1000) {
        try {
            const result = execSync(`python3 -c "
import imaplib
import email as email_lib
import re

imap = imaplib.IMAP4_SSL('${safeHost}', ${safePort})
imap.login('${safeEmail}', '${safePassword}')
imap.select('INBOX')
status, msgs = imap.search(None, 'ALL')
code = ''
if msgs[0]:
    msg_nums = msgs[0].split()[-5:]
    for num in reversed(msg_nums):
        status, data = imap.fetch(num, '(RFC822)')
        if not data or not data[0]:
            continue
        msg = email_lib.message_from_bytes(data[0][1])
        subject = msg.get('Subject', '')
        body = ''
        if msg.is_multipart():
            for part in msg.walk():
                ctype = part.get_content_type()
                if ctype in ('text/plain', 'text/html'):
                    payload = part.get_payload(decode=True)
                    if payload:
                        body = payload.decode('utf-8', errors='ignore')
                        break
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                body = payload.decode('utf-8', errors='ignore')

        text = subject + ' ' + body
        m = re.search(r'\\b(\\d{6})\\b', text)
        if m:
            code = m.group(1)
            break

imap.close()
imap.logout()
print(code)
"`, { encoding: 'utf8', timeout: 15000 });

            const code = String(result || '').trim();
            if (/^\d{6}$/.test(code)) {
                return code;
            }
        } catch (_) {
            // Retry until timeout.
        }

        await sleep(3000);
    }

    return null;
}

async function getPageText(page, engine) {
    if (engine === 'puppeteer') {
        return page.evaluate(() => (document.body && document.body.innerText) ? document.body.innerText : '').catch(() => '');
    }
    return page.evaluate(() => (document.body && document.body.innerText) ? document.body.innerText : '').catch(() => '');
}

async function waitForPasswordStep(page, engine, timeoutSec = HUMAN_CHECK_TIMEOUT_SEC) {
    const deadline = Date.now() + timeoutSec * 1000;
    let humanCheckLogged = false;
    let prompted = false;

    while (Date.now() < deadline) {
        const passwordSelectors = ['input[type="password"]', 'input[name="password"]', 'input[placeholder*="password" i]'];
        const passwordResult = await waitForAnySelector(page, passwordSelectors, 1000, engine);
        if (passwordResult) {
            return passwordResult;
        }

        const text = (await getPageText(page, engine)).toLowerCase();
        if (text.includes('be sure you are human') || text.includes('before continuing, we need to be sure you are human') || text.includes('verify you are human') || text.includes('captcha')) {
            if (!humanCheckLogged) {
                console.log(`[Step 2] Human check detected. Waiting up to ${timeoutSec}s for challenge to pass...`);
                humanCheckLogged = true;
            }
            if (ALLOW_MANUAL_HUMAN_CHECK && !prompted) {
                prompted = true;
                await promptEnter('[Manual] Solve human check in browser, then press Enter to continue... ');
            }
        }

        // If still at email step, try pressing Continue again.
        const emailInput = await waitForAnySelector(page, ['input[type="email"]', 'input[name="email"]'], 300, engine);
        if (emailInput) {
            await clickButtonByText(page, /continue|next|sign up|register/i, engine).catch(() => {});
        }

        await sleep(STEP_WAIT_POLL_MS);
    }

    return null;
}

async function takeScreenshot(page, label) {
    if (!ENABLE_SCREENSHOTS || !page) return;
    try {
        const timestamp = Date.now();
        const filename = path.join(__dirname, 'screenshots', `ollama-${label}-${timestamp}.png`);
        await fs.promises.mkdir(path.dirname(filename), { recursive: true });
        await page.screenshot({ path: filename, fullPage: false });
        console.log(`[Screenshot] ${filename}`);
    } catch (e) {
        console.log(`[Screenshot Error] ${label}: ${e.message}`);
    }
}

function appendApiKeyToRouterConfig(apiKey) {
    const configPath = OLLAMA_ROUTER_CONFIG_PATH;
    if (!configPath) {
        return { updated: false, reason: 'config_path_not_set' };
    }

    try {
        if (!fs.existsSync(configPath)) {
            return { updated: false, reason: `config_not_found:${configPath}` };
        }

        const source = fs.readFileSync(configPath, 'utf8');
        if (source.includes(apiKey)) {
            return { updated: false, reason: 'api_key_already_present' };
        }

        const lines = source.split(/\r?\n/);
        let ollamaIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (/^\s*-?\s*name:\s*Ollama\s*$/i.test(lines[i])) {
                ollamaIdx = i;
                break;
            }
        }

        if (ollamaIdx >= 0) {
            let blockEnd = lines.length;
            for (let i = ollamaIdx + 1; i < lines.length; i++) {
                if (/^\s*-\s*name:\s+/i.test(lines[i])) {
                    blockEnd = i;
                    break;
                }
            }

            let apiEntriesIdx = -1;
            for (let i = ollamaIdx; i < blockEnd; i++) {
                if (/^\s*api-key-entries:\s*$/i.test(lines[i])) {
                    apiEntriesIdx = i;
                    break;
                }
            }

            if (apiEntriesIdx >= 0) {
                const indent = (lines[apiEntriesIdx].match(/^\s*/) || [''])[0];
                lines.splice(apiEntriesIdx + 1, 0, `${indent}  - api-key: ${apiKey}`);
            } else {
                // Add api-key-entries section at end of Ollama block
                const nameIndent = (lines[ollamaIdx].match(/^\s*/) || [''])[0];
                const itemIndent = `${nameIndent}  `;
                lines.splice(blockEnd, 0,
                    `${itemIndent}api-key-entries:`,
                    `${itemIndent}  - api-key: ${apiKey}`
                );
            }
        } else {
            // Append new Ollama block
            lines.push('', '- name: Ollama', '  base-url: https://ollama.com/v1', '  api-key-entries:', `    - api-key: ${apiKey}`);
        }

        fs.writeFileSync(configPath, lines.join('\n'));
        return { updated: true, path: configPath };
    } catch (err) {
        return { updated: false, reason: String(err && err.message ? err.message : err) };
    }
}

async function closeBrowserHard(browser) {
    if (!browser) return;
    const browserProcess = typeof browser.process === 'function' ? browser.process() : null;
    await browser.close().catch(() => {});
    if (!browserProcess || !browserProcess.pid) return;
    try {
        process.kill(browserProcess.pid, 'SIGTERM');
        await sleep(400);
        process.kill(browserProcess.pid, 'SIGKILL');
    } catch (_) {}
}

async function cleanupActiveResources() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
        const browser = activeBrowser;
        activeBrowser = null;
        if (browser) await closeBrowserHard(browser).catch(() => {});
    })();
    try {
        await cleanupPromise;
    } finally {
        cleanupPromise = null;
    }
}

function installSignalHandlers() {
    if (signalHandlersInstalled) return;
    signalHandlersInstalled = true;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, () => cleanupActiveResources().finally(() => process.exit(0)));
    }
}

// ============================================================================
// Hero-SMS Functions
// ============================================================================

function heroSmsRequest(params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const url = new URL(HERO_SMS_BASE_URL);
        for (const [k, v] of Object.entries(params || {})) {
            if (v !== undefined && v !== null && String(v) !== '') {
                url.searchParams.set(k, String(v));
            }
        }
        url.searchParams.set('api_key', HERO_SMS_API_KEY);

        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`hero_sms_http_${res.statusCode}:${body.trim()}`));
                }
                resolve(String(body || '').trim());
            });
        });
        req.on('timeout', () => req.destroy(new Error('hero_sms_timeout')));
        req.on('error', (err) => reject(err));
    });
}

function parseHeroActivation(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('ACCESS_NUMBER:')) return null;
    const parts = text.split(':');
    if (parts.length < 3) return null;
    return {
        id: String(parts[1] || '').trim(),
        phone: String(parts[2] || '').trim()
    };
}

function parseHeroStatusCode(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('STATUS_OK:')) return '';
    return text.slice('STATUS_OK:'.length).trim();
}

async function heroSmsAcquireActivation(country, service) {
    const raw = await heroSmsRequest({
        action: 'getNumber',
        service: service || HERO_SMS_SERVICE,
        country
    });
    const activation = parseHeroActivation(raw);
    if (!activation || !activation.id || !activation.phone) {
        throw new Error(`hero_sms_get_number_failed:country=${country},service=${service},response=${raw}`);
    }
    console.log(`Hero-SMS activation: id=${activation.id}, country=${country}, phone=${activation.phone}`);
    return { ...activation, country, service };
}

async function heroSmsWaitForCode(activationId) {
    const deadline = Date.now() + HERO_SMS_POLL_TIMEOUT_SEC * 1000;
    let lastStatus = 'STATUS_WAIT_CODE';

    while (Date.now() < deadline) {
        const raw = await heroSmsRequest({
            action: 'getStatus',
            id: activationId
        });
        const status = String(raw || '').trim();
        lastStatus = status;
        const code = parseHeroStatusCode(status);
        if (code) {
            console.log(`Hero-SMS code received: ${code}`);
            return code;
        }
        if (/STATUS_CANCEL|STATUS_WAIT_RETRY|BAD_STATUS|BAD_KEY/i.test(status)) {
            throw new Error(`hero_sms_status_failed:${status}`);
        }
        await sleep(HERO_SMS_POLL_INTERVAL_MS);
    }
    throw new Error(`hero_sms_code_timeout:${lastStatus}`);
}

async function heroSmsSetStatus(activationId, status) {
    if (!activationId) return '';
    try {
        const raw = await heroSmsRequest({
            action: 'setStatus',
            id: activationId,
            status
        });
        console.log(`Hero-SMS setStatus(${status}): ${raw}`);
        return raw;
    } catch (err) {
        console.log(`Hero-SMS setStatus(${status}) error: ${err.message}`);
        return `ERR:${err.message}`;
    }
}

// ============================================================================
// Browser Automation
// ============================================================================

async function launchBrowser(engine) {
    const order = browserEngineOrder(engine);
    let lastError = null;

    for (const eng of order) {
        try {
            if (eng === 'puppeteer') {
                const puppeteer = require('puppeteer');
                const browser = await puppeteer.launch({
                    headless: false,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--disable-gpu',
                        '--window-size=1366,768',
                        '--disable-blink-features=AutomationControlled'
                    ]
                });
                const page = await browser.newPage();
                await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
                await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                });
                activeBrowser = browser;
                console.log('Browser launched: puppeteer');
                return { browser, engine: 'puppeteer', page };
            }
            if (eng === 'playwright') {
                const { chromium } = require('playwright');
                const browser = await chromium.launch({
                    headless: false,
                    args: [
                        '--no-sandbox',
                        '--disable-dev-shm-usage'
                    ]
                });
                const context = await browser.newContext({
                    viewport: { width: 1366, height: 768 },
                    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                    locale: 'en-US',
                    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
                });
                const page = await context.newPage();
                activeBrowser = browser;
                console.log('Browser launched: playwright');
                return { browser, engine: 'playwright', page, context };
            }
        } catch (err) {
            lastError = err;
            console.log(`Failed to launch ${eng}: ${err.message}`);
        }
    }
    throw lastError || new Error('Failed to launch browser');
}

async function waitForSelector(page, selector, timeoutMs, engine) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            if (engine === 'puppeteer') {
                const el = await page.$(selector);
                if (el) return el;
            } else {
                const el = await page.locator(selector).first();
                const count = await el.count().catch(() => 0);
                if (count > 0) return el;
            }
        } catch (_) {}
        await sleep(250);
    }
    return null;
}

async function waitForAnySelector(page, selectors, timeoutMs, engine) {
    for (const selector of selectors) {
        const el = await waitForSelector(page, selector, timeoutMs, engine);
        if (el) return { selector, element: el };
    }
    return null;
}

async function fillInput(page, element, value, engine) {
    if (engine === 'puppeteer') {
        await element.click({ clickCount: 3 }).catch(() => {});
        await element.type(value, { delay: 30 });
    } else {
        await element.fill(value);
    }
}

async function clickElement(page, element, engine) {
    if (engine === 'puppeteer') {
        await element.click().catch(() => {});
    } else {
        await element.click().catch(() => {});
    }
}

async function clickButtonByText(page, regex, engine) {
    if (engine === 'puppeteer') {
        const clicked = await page.evaluate((pattern) => {
            const re = new RegExp(pattern, 'i');
            const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"]'));
            for (const el of nodes) {
                const text = ((el.textContent || '') + ' ' + (el.value || '')).replace(/\s+/g, ' ').trim();
                if (text && re.test(text)) {
                    el.click();
                    return true;
                }
            }
            return false;
        }, regex.source);
        return clicked;
    } else {
        const locator = page.locator(`button, [role="button"], a, input[type="submit"]`)
            .filter({ hasText: regex });
        const count = await locator.count().catch(() => 0);
        if (count > 0) {
            await locator.first().click().catch(() => {});
            return true;
        }
        return false;
    }
}

async function getPageUrl(page, engine) {
    if (engine === 'puppeteer') {
        return page.url();
    }
    return page.url();
}

async function waitForNavigation(page, timeoutMs, engine) {
    if (engine === 'puppeteer') {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    } else {
        await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
    }
}

// ============================================================================
// Main Authentication Flow
// ============================================================================

async function ollamaAuthFlow() {
    console.log('='.repeat(60));
    console.log('Ollama Authentication Flow');
    console.log('='.repeat(60));
    console.log(`Email: ${ACCOUNT.email}`);
    console.log(`Account Index: ${ACCOUNT_INDEX}`);
    console.log('');

    installSignalHandlers();

    const { browser, engine, page } = await launchBrowser(BROWSER_ENGINE);
    
    try {
        // --------------------------------------------------------------------
        // Step 1: Email Input
        // --------------------------------------------------------------------
        console.log('[Step 1] Navigating to sign-up page...');
        await page.goto('https://signin.ollama.com/sign-up', { 
            waitUntil: 'domcontentloaded', 
            timeout: NAVIGATION_TIMEOUT_MS 
        });
        await sleep(2000);
        await takeScreenshot(page, '01-signup-page');

        console.log('[Step 1] Entering email...');
        const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]'];
        const emailResult = await waitForAnySelector(page, emailSelectors, EMAIL_INPUT_TIMEOUT_MS, engine);
        if (!emailResult) {
            throw new Error('Email input not found');
        }
        await fillInput(page, emailResult.element, ACCOUNT.email, engine);
        await sleep(500);

        console.log('[Step 1] Clicking Continue...');
        const continueClicked = await clickButtonByText(page, /continue|next|sign up|register/i, engine);
        if (!continueClicked) {
            const submitBtn = await waitForSelector(page, 'button[type="submit"], input[type="submit"]', 3000, engine);
            if (submitBtn) await clickElement(page, submitBtn, engine);
        }
        await sleep(2000);
        await waitForNavigation(page, NAVIGATION_TIMEOUT_MS, engine);
        await takeScreenshot(page, '02-after-email');

        // --------------------------------------------------------------------
        // Step 2: Password Input
        // --------------------------------------------------------------------
        console.log('[Step 2] Waiting for password step...');
        const passwordResult = await waitForPasswordStep(page, engine, HUMAN_CHECK_TIMEOUT_SEC);
        if (!passwordResult) {
            const currentText = (await getPageText(page, engine)).slice(0, 500);
            throw new Error(`Password input not found (human check may still be active). Page text: ${currentText}`);
        }
        console.log('[Step 2] Entering password...');
        await fillInput(page, passwordResult.element, ACCOUNT.password, engine);
        await sleep(500);

        console.log('[Step 2] Clicking Continue...');
        const continueClicked2 = await clickButtonByText(page, /continue|next|sign up|register/i, engine);
        if (!continueClicked2) {
            const submitBtn = await waitForSelector(page, 'button[type="submit"], input[type="submit"]', 3000, engine);
            if (submitBtn) await clickElement(page, submitBtn, engine);
        }
        await sleep(2000);
        await waitForNavigation(page, NAVIGATION_TIMEOUT_MS, engine);
        await takeScreenshot(page, '03-after-password');

        // --------------------------------------------------------------------
        // Step 3: Email Verification (6-digit code)
        // --------------------------------------------------------------------
        console.log('[Step 3] Waiting for email verification input...');
        await takeScreenshot(page, '04-email-verification-page');

        const emailCodeSelectors = [
            'input[autocomplete="one-time-code"]',
            'input[name*="code" i]',
            'input[placeholder*="code" i]',
            'input[inputmode="numeric"][maxlength="6"]',
            'input[maxlength="6"]'
        ];
        const emailCodeResult = await waitForAnySelector(page, emailCodeSelectors, EMAIL_CODE_INPUT_TIMEOUT_MS, engine);
        if (!emailCodeResult) {
            throw new Error('Email verification input not found');
        }

        let emailCode = String(process.env.OLLAMA_EMAIL_CODE || '').trim();
        if (!/^\d{6}$/.test(emailCode)) {
            console.log(`[Step 3] Fetching email verification code via IMAP (${EMAIL_IMAP_HOST}:${EMAIL_IMAP_PORT})...`);
            emailCode = await getVerificationCodeFromIMAP(ACCOUNT.email, ACCOUNT.password, EMAIL_CODE_WAIT_SEC);
        }
        if (!/^\d{6}$/.test(emailCode)) {
            throw new Error('Email verification code not found (IMAP timeout)');
        }

        console.log('[Step 3] Entering email verification code...');
        await fillInput(page, emailCodeResult.element, emailCode, engine);
        await sleep(500);

        const continueClicked3 = await clickButtonByText(page, /continue|next|verify|confirm|submit/i, engine);
        if (!continueClicked3) {
            const submitBtn = await waitForSelector(page, 'button[type="submit"], input[type="submit"]', 3000, engine);
            if (submitBtn) await clickElement(page, submitBtn, engine);
        }
        await sleep(2000);
        await waitForNavigation(page, NAVIGATION_TIMEOUT_MS, engine);
        await takeScreenshot(page, '05-after-email-code');

        // --------------------------------------------------------------------
        // Step 4: Phone Verification (SMS)
        // --------------------------------------------------------------------
        console.log('[Step 4] Phone verification required...');
        await takeScreenshot(page, '06-phone-verification-page');

        if (!HERO_SMS_API_KEY) {
            throw new Error('HERO_SMS_API_KEY is required for phone verification');
        }

        console.log('[Step 4] Ordering SMS number (UK, "other" category)...');
        let activation = null;
        let phoneVerified = false;
        let lastSmsError = 'no_attempts';

        for (let countryAttempt = 0; countryAttempt < HERO_SMS_MAX_COUNTRY_ATTEMPTS; countryAttempt++) {
            const country = HERO_SMS_COUNTRIES[countryAttempt % HERO_SMS_COUNTRIES.length];
            try {
                activation = await heroSmsAcquireActivation(country, HERO_SMS_SERVICE);
                await heroSmsSetStatus(activation.id, 1);

                console.log('[Step 4] Entering phone number...');
                const phoneSelectors = [
                    'input[type="tel"]',
                    'input[autocomplete="tel"]',
                    'input[name*="phone" i]',
                    'input[placeholder*="phone" i]',
                    'input[inputmode="tel"]'
                ];
                const phoneResult = await waitForAnySelector(page, phoneSelectors, PHONE_INPUT_TIMEOUT_MS, engine);
                if (!phoneResult) {
                    throw new Error('phone_input_not_found');
                }

                const phoneCandidates = [
                    `+${activation.phone}`,
                    activation.phone,
                    activation.phone.startsWith('44') ? `+${activation.phone}` : `+44${activation.phone.replace(/^0+/, '')}`
                ];

                let smsStepOpened = false;
                let selectedPhoneCandidate = phoneCandidates[0];

                for (const phoneCandidate of phoneCandidates) {
                    selectedPhoneCandidate = phoneCandidate;
                    console.log(`[Step 4] Trying phone: ${phoneCandidate}`);
                    await fillInput(page, phoneResult.element, phoneCandidate, engine);
                    await sleep(500);

                    const sendClicked = await clickButtonByText(page, /send|continue|next|get code|sms|verify/i, engine);
                    if (!sendClicked) {
                        const submitBtn = await waitForSelector(page, 'button[type="submit"], input[type="submit"]', 3000, engine);
                        if (submitBtn) await clickElement(page, submitBtn, engine);
                    }

                    const smsCodeSelectors = [
                        'input[inputmode="numeric"][maxlength="6"]',
                        'input[autocomplete="one-time-code"]',
                        'input[name*="code" i]',
                        'input[placeholder*="code" i]'
                    ];
                    const smsCodeResult = await waitForAnySelector(page, smsCodeSelectors, SMS_CODE_INPUT_TIMEOUT_MS, engine);
                    if (smsCodeResult) {
                        smsStepOpened = true;

                        console.log(`[Step 4] Waiting for SMS code (timeout=${HERO_SMS_POLL_TIMEOUT_SEC}s)...`);
                        const smsCode = await heroSmsWaitForCode(activation.id);

                        console.log('[Step 4] Entering SMS code...');
                        await fillInput(page, smsCodeResult.element, smsCode, engine);

                        const phoneConfirmResult = await waitForAnySelector(page, phoneSelectors, 2000, engine);
                        if (phoneConfirmResult && phoneConfirmResult.element) {
                            console.log('[Step 4] Filling right phone field (if required)...');
                            await fillInput(page, phoneConfirmResult.element, phoneCandidate, engine);
                        }

                        await sleep(500);
                        const verifyClicked = await clickButtonByText(page, /verify|continue|confirm|submit|done/i, engine);
                        if (!verifyClicked) {
                            const submitBtn = await waitForSelector(page, 'button[type="submit"], input[type="submit"]', 3000, engine);
                            if (submitBtn) await clickElement(page, submitBtn, engine);
                        }

                        await sleep(2500);
                        await waitForNavigation(page, NAVIGATION_TIMEOUT_MS, engine);
                        await takeScreenshot(page, '07-after-sms-verify');

                        const currentURL = (await getPageUrl(page, engine) || '').toLowerCase();
                        if (currentURL.includes('add-phone') || currentURL.includes('phone') || currentURL.includes('verify')) {
                            throw new Error('phone_verification_still_required');
                        }

                        await heroSmsSetStatus(activation.id, 6);
                        activation = null;
                        phoneVerified = true;
                        break;
                    }
                }

                if (!smsStepOpened) {
                    throw new Error('sms_code_input_not_found');
                }

                if (phoneVerified) {
                    break;
                }

                throw new Error('phone_verification_still_required');
            } catch (err) {
                lastSmsError = String(err && err.message ? err.message : err || 'unknown_sms_error');
                console.log(`[Step 4] Country attempt ${countryAttempt + 1} failed: ${lastSmsError}`);

                if (activation && activation.id) {
                    await heroSmsSetStatus(activation.id, 8);
                    activation = null;
                }

                if (countryAttempt < HERO_SMS_MAX_COUNTRY_ATTEMPTS - 1) {
                    await clickButtonByText(page, /(change|different|another|edit|other number|use another|back|друг|измен|назад|сменить)/i, engine).catch(() => {});
                    await sleep(1200);
                }
            }
        }

        if (!phoneVerified) {
            throw new Error(`Phone verification failed: ${lastSmsError}`);
        }

        console.log('[Step 4] Phone verification completed');
        await sleep(2500);

        // --------------------------------------------------------------------
        // Step 5: Get API Key
        // --------------------------------------------------------------------
        console.log('[Step 5] Navigating to API keys page...');
        await page.goto('https://ollama.com/settings/keys', {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT_MS
        });
        await sleep(2000);
        await takeScreenshot(page, '08-api-keys-page');

        console.log('[Step 5] Clicking Add API Key...');
        const addKeyClicked = await clickButtonByText(page, /add api key|new key|create key/i, engine);
        if (!addKeyClicked) {
            throw new Error('Add API Key button not found');
        }
        await sleep(1000);

        console.log('[Step 5] Clicking Generate API Key...');
        const generateClicked = await clickButtonByText(page, /generate|create|confirm/i, engine);
        if (!generateClicked) {
            throw new Error('Generate API Key button not found');
        }
        await sleep(3000);
        await takeScreenshot(page, '09-api-key-generated');

        // Extract API key
        console.log('[Step 5] Extracting API key...');
        const apiKeySelectors = [
            'code',
            '[data-testid="api-key"]',
            '.api-key-value',
            'input[value^="sk-"]',
            '[class*="api-key"]'
        ];
        const apiKeyResult = await waitForAnySelector(page, apiKeySelectors, API_KEY_PAGE_TIMEOUT_MS, engine);
        
        let apiKey = '';
        if (apiKeyResult) {
            if (engine === 'puppeteer') {
                apiKey = await page.evaluate((el) => el.value || el.textContent || '', apiKeyResult.element);
            } else {
                apiKey = await apiKeyResult.element.inputValue().catch(async () =>
                    apiKeyResult.element.textContent().catch(() => '')
                );
            }
            apiKey = String(apiKey || '').trim();
        }

        if (!apiKey) {
            // Try to get from page content
            apiKey = await page.evaluate(() => {
                const code = document.querySelector('code');
                if (code) return code.textContent.trim();
                const inputs = document.querySelectorAll('input');
                for (const input of inputs) {
                    const val = input.value || '';
                    if (val.startsWith('sk-') || val.length > 20) return val.trim();
                }
                return '';
            });
        }

        if (!apiKey) {
            throw new Error('Could not extract API key from page');
        }

        console.log('');
        console.log('='.repeat(60));
        console.log('Authentication Successful!');
        console.log('='.repeat(60));
        console.log(`Email: ${ACCOUNT.email}`);
        console.log(`API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
        console.log('');

        // Save result
        const result = {
            email: ACCOUNT.email,
            api_key: apiKey,
            auth_file: `ollama-${Date.now()}.json`,
            status: 'success',
            timestamp: new Date().toISOString()
        };

        // Save to file
        const outputFile = path.join(__dirname, 'ollama-results.json');
        const existingResults = fs.existsSync(outputFile) 
            ? JSON.parse(fs.readFileSync(outputFile, 'utf8')) 
            : [];
        existingResults.push(result);
        fs.writeFileSync(outputFile, JSON.stringify(existingResults, null, 2));
        console.log(`Result saved to: ${outputFile}`);

        const configUpdate = appendApiKeyToRouterConfig(apiKey);
        if (configUpdate.updated) {
            console.log(`Router config updated: ${configUpdate.path}`);
        } else {
            console.log(`Router config not updated: ${configUpdate.reason}`);
        }

        // Print config snippet
        console.log('');
        console.log('Add to config.yaml (if not auto-updated):');
        console.log('-'.repeat(60));
        console.log(`- name: Ollama`);
        console.log(`  base-url: https://ollama.com/v1`);
        console.log(`  api-key-entries:`);
        console.log(`    - api-key: ${apiKey}`);
        console.log('-'.repeat(60));

        return result;

    } catch (err) {
        console.error('');
        console.error('='.repeat(60));
        console.error('Authentication Failed!');
        console.error('='.repeat(60));
        console.error(`Error: ${err.message}`);
        try {
            const html = await page.content();
            const debugPath = path.join(__dirname, `ollama-debug-${Date.now()}.html`);
            fs.writeFileSync(debugPath, html);
            console.error(`Debug HTML saved: ${debugPath}`);
        } catch (_) {}
        await takeScreenshot(page, 'error');
        throw err;
    } finally {
        await cleanupActiveResources();
    }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    try {
        await ollamaAuthFlow();
        process.exit(0);
    } catch (err) {
        console.error(`Fatal error: ${err.message}`);
        process.exit(1);
    }
}

main();
