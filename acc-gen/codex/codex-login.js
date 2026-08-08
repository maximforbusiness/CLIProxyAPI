const speakeasy = require('speakeasy');
const proxyChain = require('proxy-chain');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Stealth plugin for Puppeteer — hides automation indicators
// that cause OpenAI to serve a degraded add-phone page without SMS selector
let stealthPlugin = null;
try {
    stealthPlugin = require('puppeteer-extra-plugin-stealth')();
} catch (_) {
    // stealth plugin not available, will use manual patches
}
const { execSync, spawn } = require('child_process');

// Load accounts from accounts.json (or override via CODEX_ACCOUNTS_FILE)
const ACCOUNTS_FILE = process.env.CODEX_ACCOUNTS_FILE
    ? path.resolve(process.env.CODEX_ACCOUNTS_FILE)
    : path.join(__dirname, 'accounts.json');
let ACCOUNTS = [];

if (fs.existsSync(ACCOUNTS_FILE)) {
    ACCOUNTS = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    console.log(`Loaded ${ACCOUNTS.length} account(s) from ${ACCOUNTS_FILE}`);
} else {
    // Fallback to single account
    ACCOUNTS = [{
        email: 'edwards23322@belettersmail.com',
        password: 'ALi562Djs1Hnf',
        totpSecret: 'FXEFIAESL73TWLTJGDXSFS6YBGMDXM34',
        name: 'Edward',
        birthYear: 2000,
        birthMonth: 1,
        birthDay: 15
    }];
}

// Current account index (can be passed via command line)
const ACCOUNT_INDEX = parseInt(process.argv[3]) || 0;
const ACCOUNT = ACCOUNTS[Math.min(ACCOUNT_INDEX, ACCOUNTS.length - 1)];
const USER_AGENTS = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
];
const VIEWPORTS = [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1600, height: 900 },
    { width: 1920, height: 1080 }
];

const BROWSER_ENGINE = normalizeBrowserEngine(process.env.CODEX_BROWSER_ENGINE || 'auto');
const CODEX_LEAN_REQUESTS = String(process.env.CODEX_LEAN_REQUESTS || '1').trim().toLowerCase();
const HERO_SMS_BASE_URL = process.env.HERO_SMS_BASE_URL || 'https://hero-sms.com/stubs/handler_api.php';
const HERO_SMS_SERVICE = (process.env.HERO_SMS_SERVICE || 'dr').trim();
const HERO_SMS_SERVICES = String(process.env.HERO_SMS_SERVICES || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const HERO_SMS_SERVICE_PREFIX = String(process.env.HERO_SMS_SERVICE_PREFIX || '').trim().toLowerCase();
const HERO_SMS_SERVICE_QUERY = String(process.env.HERO_SMS_SERVICE_QUERY || 'open').trim().toLowerCase();
const HERO_SMS_PRICE_RANKING = String(process.env.HERO_SMS_PRICE_RANKING || 'off').trim().toLowerCase();
const HERO_SMS_COUNTRIES = String(process.env.HERO_SMS_COUNTRIES || '73')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const HERO_SMS_POLL_TIMEOUT_SEC = Math.max(30, parseInt(process.env.HERO_SMS_POLL_TIMEOUT_SEC || '30', 10) || 30);
const HERO_SMS_POLL_INTERVAL_MS = Math.max(2000, parseInt(process.env.HERO_SMS_POLL_INTERVAL_MS || '3000', 10) || 3000);
const HERO_SMS_MAX_COUNTRY_ATTEMPTS = Math.max(1, parseInt(process.env.HERO_SMS_MAX_COUNTRY_ATTEMPTS || '5', 10) || 5);
const HERO_SMS_CANCEL_RETRY_DELAY_SEC = Math.max(30, parseInt(process.env.HERO_SMS_CANCEL_RETRY_DELAY_SEC || '180', 10) || 180);
const HERO_SMS_API_KEY = String(process.env.HERO_SMS_API_KEY || '').trim();
const HERO_SMS_MAX_PRICE = String(process.env.HERO_SMS_MAX_PRICE || '').trim();
const SCREENSHOT_MODE = String(process.env.CODEX_SCREENSHOTS || 'off').trim().toLowerCase();
const ENABLE_SCREENSHOTS = SCREENSHOT_MODE === '1' || SCREENSHOT_MODE === 'true' || SCREENSHOT_MODE === 'all';
const AUTH_PAGE_NAV_TIMEOUT_MS = Math.max(15000, parseInt(process.env.CODEX_AUTH_PAGE_NAV_TIMEOUT_MS || '35000', 10) || 35000);
const AUTH_PAGE_NAV_RETRIES = Math.max(1, parseInt(process.env.CODEX_AUTH_PAGE_NAV_RETRIES || '2', 10) || 2);
const EMAIL_INPUT_TIMEOUT_MS = Math.max(4000, parseInt(process.env.CODEX_EMAIL_INPUT_TIMEOUT_MS || '7000', 10) || 7000);
const BLANK_PAGE_SETTLE_MS = Math.max(1000, parseInt(process.env.CODEX_BLANK_PAGE_SETTLE_MS || '2000', 10) || 2000);
const PUPPETEER_CHROME_CANDIDATES = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    process.env.CHROMIUM_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
].filter(Boolean);
let heroSmsServiceCandidatesCache = null;
const heroSmsPricesByCountryCache = new Map();
let activeBrowser = null;
let activeAnonymizedProxyUrl = null;
let cleanupPromise = null;
let signalHandlersInstalled = false;

function optionalRequire(modName) {
    try {
        return require(modName);
    } catch (_) {
        return null;
    }
}

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

function resolveChromeExecutable() {
    for (const candidate of PUPPETEER_CHROME_CANDIDATES) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return '';
}

function buildBrowserProfile() {
    return {
        userAgent: pickRandom(USER_AGENTS),
        viewport: pickRandom(VIEWPORTS),
        acceptLanguage: 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    };
}

function toTitleCase(word) {
    const clean = String(word || '').toLowerCase();
    if (!clean) return '';
    return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function buildValidFullName(rawName, email) {
    const localPart = String(email || '').split('@')[0] || '';
    const source = `${rawName || ''} ${localPart}`.trim();
    const tokens = source
        .replace(/[^a-zA-Z\s]/g, ' ')
        .split(/\s+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 2)
        .map(toTitleCase);

    if (tokens.length >= 2) {
        return `${tokens[0]} ${tokens[1]}`;
    }
    if (tokens.length === 1) {
        return `${tokens[0]} Stone`;
    }
    return 'Alex Stone';
}

function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function getTOTPCode(secret) {
    return speakeasy.totp({
        secret: secret,
        encoding: 'base32',
        window: 1
    });
}

function isCodexCallbackUrl(url) {
    if (!url || !url.includes('localhost:1455')) {
        return false;
    }

    try {
        const parsed = new URL(url);
        return parsed.hostname === 'localhost' &&
               parsed.port === '1455' &&
               parsed.pathname === '/auth/callback' &&
               parsed.searchParams.has('code');
    } catch (e) {
        return false;
    }
}

function stripTerminalArtifacts(value) {
    const raw = String(value || '').replace(/\r/g, '').trim();
    const match = raw.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^ \t\r\n"'<>]+/i);
    const candidate = match ? match[0] : raw;
    return candidate
        .replace(/(Waiting.*|Paste the Codex callback URL.*)$/i, '')
        .trim();
}

function normalizeAuthUrl(rawUrl) {
    const cleaned = stripTerminalArtifacts(rawUrl);
    try {
        const parsed = new URL(cleaned);
        // The simplified flow flag started returning unstable route errors in some buckets.
        if (parsed.searchParams.has('codex_cli_simplified_flow')) {
            parsed.searchParams.delete('codex_cli_simplified_flow');
        }
        return parsed.toString();
    } catch {
        return cleaned;
    }
}

function normalizeProxyScheme(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return 'http';
    if (value === 'socs5') return 'socks5';
    if (value === 'socks5h') return 'socks5';
    if (['http', 'https', 'socks4', 'socks5'].includes(value)) return value;
    return 'http';
}

function parseProxyEntry(entry, fallbackScheme = 'http') {
    const raw = String(entry || '').trim();
    if (!raw) return null;

    let rest = raw;
    let parsedScheme = null;
    const schemeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
    if (schemeMatch) {
        parsedScheme = normalizeProxyScheme(schemeMatch[1]);
        rest = rest.slice(schemeMatch[0].length);
    }

    const scheme = parsedScheme || normalizeProxyScheme(fallbackScheme);
    let hostPort = rest;
    let username = '';
    let password = '';

    if (rest.includes('@')) {
        const atIndex = rest.indexOf('@');
        const left = rest.slice(0, atIndex);
        const right = rest.slice(atIndex + 1);
        const leftLooksHostPort = /^.+:\d+$/.test(left);
        const rightLooksHostPort = /^.+:\d+$/.test(right);

        if (leftLooksHostPort && !rightLooksHostPort) {
            hostPort = left;
            [username, password = ''] = right.split(':');
        } else {
            hostPort = right;
            [username, password = ''] = left.split(':');
        }
    }

    const hostPortMatch = hostPort.match(/^([^:]+):(\d+)$/);
    if (!hostPortMatch) {
        throw new Error(`Invalid proxy format: ${raw}`);
    }

    const host = hostPortMatch[1].trim();
    const port = hostPortMatch[2].trim();
    if (!host || !port) {
        throw new Error(`Invalid proxy host/port in: ${raw}`);
    }

    return {
        raw,
        scheme,
        server: `${scheme}://${host}:${port}`,
        upstreamUrl: username ? `${scheme}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}` : `${scheme}://${host}:${port}`,
        username,
        password
    };
}

async function firstXPath(page, xpath) {
    if (!page) return null;
    if (typeof page.$x === 'function') {
        const matches = await page.$x(xpath);
        return matches[0] || null;
    }

    if (typeof page.locator === 'function') {
        const baseLocator = page.locator(`xpath=${xpath}`);
        const locator = (baseLocator && typeof baseLocator.first === 'function')
            ? baseLocator.first()
            : baseLocator;

        if (!locator) return null;

        if (typeof locator.count === 'function') {
            const count = await locator.count().catch(() => 0);
            if (!count) return null;
        }

        if (typeof locator.elementHandle === 'function') {
            return locator.elementHandle().catch(() => null);
        }

        if (typeof locator.waitHandle === 'function') {
            return locator.waitHandle({ timeout: 1000 }).catch(() => null);
        }
    }

    return null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function heroSmsNeedsDelayedCancel(responseText) {
    const text = String(responseText || '').trim();
    return /EARLY_CANCEL_DENIED|cannot be cancelled at this time|hero_sms_http_409/i.test(text);
}

function scheduleHeroSmsCancelRetry(activationId) {
    const id = String(activationId || "").trim();
    if (!id || !HERO_SMS_API_KEY) {
        return;
    }

    const safeDelay = HERO_SMS_CANCEL_RETRY_DELAY_SEC;
    const safeBase = JSON.stringify(HERO_SMS_BASE_URL);
    const safeApiKey = JSON.stringify(HERO_SMS_API_KEY);
    const safeID = JSON.stringify(id);
    const helperSource = [
        "const https = require(\"https\");",
        "const fs = require(\"fs\");",
        `const base = ${safeBase};`,
        `const apiKey = ${safeApiKey};`,
        `const id = ${safeID};`,
        "const u = new URL(base);",
        "u.searchParams.set(\"action\", \"setStatus\");",
        "u.searchParams.set(\"api_key\", apiKey);",
        "u.searchParams.set(\"id\", id);",
        "u.searchParams.set(\"status\", \"8\");",
        "const logFile = \"/tmp/hero-sms-cancel.log\";",
        "https.get(u, (res) => {",
        "  let body = \"\";",
        "  res.on(\"data\", (c) => { body += c.toString(); });",
        "  res.on(\"end\", () => {",
        "    const msg = `${new Date().toISOString()} | [Hero-SMS delayed cancel] id=${id} status=${res.statusCode} body=${body.trim()}\\n`;",
        "    fs.appendFileSync(logFile, msg);",
        "  });",
        "}).on(\"error\", (e) => {",
        "  const msg = `${new Date().toISOString()} | [Hero-SMS delayed cancel] id=${id} error=${e.message}\\n`;",
        "  fs.appendFileSync(logFile, msg);",
        "});"
    ].join("\n");

    const nodeScript = `setTimeout(() => { ${helperSource} }, ${safeDelay * 1000});`;

    const child = spawn("node", ["-e", nodeScript], {
        detached: true,
        stdio: "ignore"
    });
    child.unref();
    console.log(`Hero-SMS delayed cancel scheduled: id=${id}, delay=${safeDelay}s (running direct node)`);
}

function shouldBlockRequest(resourceType, url) {
    const type = String(resourceType || '').toLowerCase();
    const rawUrl = String(url || '');

    if (!rawUrl || rawUrl.includes('localhost:1455')) {
        return false;
    }

    if (type === 'image' || type === 'media' || type === 'font') {
        return true;
    }

    return /google-analytics|googletagmanager|doubleclick|segment\.io|sentry|intercom|hotjar/i.test(rawUrl);
}

async function enableLeanPageRequests(page, engine) {
    if (!page) {
        return;
    }

    if (engine === 'puppeteer' && typeof page.setRequestInterception === 'function') {
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (shouldBlockRequest(request.resourceType(), request.url())) {
                request.abort().catch(() => {});
                return;
            }
            request.continue().catch(() => {});
        });
        return;
    }

    if (typeof page.route === 'function') {
        await page.route('**/*', async (route) => {
            const request = route.request();
            if (shouldBlockRequest(request.resourceType(), request.url())) {
                await route.abort().catch(() => {});
                return;
            }
            await route.continue().catch(() => {});
        });
    }
}

async function collectPageSnapshot(page) {
    try {
        return await page.evaluate(() => {
            const body = document.body;
            const text = body && typeof body.innerText === 'string' ? body.innerText.trim() : '';
            return {
                title: document.title || '',
                readyState: document.readyState || '',
                url: location.href || '',
                htmlLength: document.documentElement ? document.documentElement.outerHTML.length : 0,
                textLength: text.length,
                nodeCount: body ? body.querySelectorAll('*').length : 0,
                emailInputs: document.querySelectorAll('input[type="email"], input[name="email"]').length
            };
        });
    } catch (error) {
        return {
            title: '',
            readyState: '',
            url: '',
            htmlLength: 0,
            textLength: 0,
            nodeCount: 0,
            emailInputs: 0,
            error: String((error && error.message) || error || 'snapshot_failed')
        };
    }
}

function isProbablyBlankLoginPage(snapshot) {
    if (!snapshot) {
        return false;
    }

    if ((snapshot.emailInputs || 0) > 0) {
        return false;
    }

    return (snapshot.textLength || 0) === 0 && (snapshot.nodeCount || 0) < 3 && (snapshot.htmlLength || 0) < 1200;
}

async function closeBrowserHard(browser) {
    if (!browser) {
        return;
    }

    const browserProcess = typeof browser.process === 'function' ? browser.process() : null;
    await browser.close().catch(() => {});

    if (!browserProcess || !browserProcess.pid) {
        return;
    }

    try {
        process.kill(browserProcess.pid, 0);
    } catch (_) {
        return;
    }

    try {
        process.kill(browserProcess.pid, 'SIGTERM');
    } catch (_) {
        return;
    }

    await sleep(400);
    try {
        process.kill(browserProcess.pid, 0);
        process.kill(browserProcess.pid, 'SIGKILL');
    } catch (_) {
        // Browser already exited.
    }
}

async function cleanupActiveResources() {
    if (cleanupPromise) {
        return cleanupPromise;
    }

    cleanupPromise = (async () => {
        const browser = activeBrowser;
        const proxyUrl = activeAnonymizedProxyUrl;
        activeBrowser = null;
        activeAnonymizedProxyUrl = null;

        if (browser) {
            await closeBrowserHard(browser).catch(() => {});
        }
        if (proxyUrl) {
            await proxyChain.closeAnonymizedProxy(proxyUrl, true).catch(() => {});
        }
    })();

    try {
        await cleanupPromise;
    } finally {
        cleanupPromise = null;
    }
}

function installSignalHandlers() {
    if (signalHandlersInstalled) {
        return;
    }

    signalHandlersInstalled = true;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, () => {
            cleanupActiveResources()
                .finally(() => process.exit(0));
        });
    }
}

function heroSmsErrorText(raw) {
    const text = String(raw || '').trim();
    if (!text) return 'empty_response';
    if (text.startsWith('{')) {
        try {
            const parsed = JSON.parse(text);
            if (parsed.title && parsed.details) {
                return `${parsed.title}:${parsed.details}`;
            }
            return JSON.stringify(parsed);
        } catch (_) {
            return text;
        }
    }
    return text;
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

function parseHeroServicesCatalog(raw) {
    const text = String(raw || '').trim();
    if (!text || !text.startsWith('{')) return [];

    try {
        const parsed = JSON.parse(text);
        const rows = Array.isArray(parsed && parsed.services) ? parsed.services : [];
        const out = [];
        for (const row of rows) {
            const code = String((row && row.code) || '').trim().toLowerCase();
            const name = String((row && row.name) || '').trim();
            if (!/^[a-z0-9_]{2,32}$/i.test(code)) continue;
            out.push({
                code,
                name,
                nameLower: name.toLowerCase()
            });
        }
        return out;
    } catch (_) {
        return [];
    }
}

function parseHeroPricesByCountry(raw, country) {
    const text = String(raw || '').trim();
    if (!text || !text.startsWith('{')) return {};

    try {
        const parsed = JSON.parse(text);
        const countryKey = String(country || '').trim();
        const rows = parsed && parsed[countryKey] && typeof parsed[countryKey] === 'object'
            ? parsed[countryKey]
            : {};
        const out = {};
        for (const [serviceRaw, info] of Object.entries(rows)) {
            const service = String(serviceRaw || '').trim().toLowerCase();
            if (!service) continue;
            const cost = Number(info && info.cost);
            const count = Number(info && info.count);
            const physicalCount = Number(info && info.physicalCount);
            out[service] = {
                cost: Number.isFinite(cost) ? cost : Infinity,
                count: Number.isFinite(count) ? count : 0,
                physicalCount: Number.isFinite(physicalCount) ? physicalCount : 0,
                hasPrice: Number.isFinite(cost)
            };
        }
        return out;
    } catch (_) {
        return {};
    }
}

async function heroSmsFetchServiceCatalog() {
    const raw = await heroSmsRequest({
        action: 'getServicesList'
    });
    const services = parseHeroServicesCatalog(raw);
    if (services.length === 0) {
        throw new Error(`hero_sms_service_catalog_empty:${heroSmsErrorText(raw)}`);
    }
    return services;
}

async function heroSmsFetchPricesByCountry(country) {
    const key = String(country || '').trim();
    if (!key) return {};
    if (heroSmsPricesByCountryCache.has(key)) {
        return heroSmsPricesByCountryCache.get(key);
    }

    const raw = await heroSmsRequest({
        action: 'getPrices',
        country: key
    });
    const parsed = parseHeroPricesByCountry(raw, key);
    heroSmsPricesByCountryCache.set(key, parsed);
    return parsed;
}

function uniqLower(values) {
    return Array.from(new Set(
        (values || [])
            .map((x) => String(x || '').trim().toLowerCase())
            .filter(Boolean)
    ));
}

async function heroSmsResolveServiceCandidates() {
    if (Array.isArray(heroSmsServiceCandidatesCache) && heroSmsServiceCandidatesCache.length > 0) {
        return heroSmsServiceCandidatesCache;
    }

    const explicit = uniqLower(HERO_SMS_SERVICES.filter((x) => !x.endsWith('*')));

    const wildcardPrefixes = uniqLower([
        ...HERO_SMS_SERVICES.filter((x) => x.endsWith('*')).map((x) => x.slice(0, -1)),
        HERO_SMS_SERVICE.endsWith('*') ? HERO_SMS_SERVICE.slice(0, -1) : '',
        HERO_SMS_SERVICE_PREFIX
    ]);

    const resolved = [...explicit];
    if (wildcardPrefixes.length > 0 || HERO_SMS_SERVICE_QUERY) {
        try {
            const catalog = await heroSmsFetchServiceCatalog();
            const catalogCodes = uniqLower(catalog.map((x) => x.code));
            for (const prefix of wildcardPrefixes) {
                const matches = catalogCodes.filter((code) => code.startsWith(prefix));
                if (matches.length > 0) {
                    resolved.push(...matches);
                } else {
                    const containsMatches = catalogCodes.filter((code) => code.includes(prefix));
                    if (containsMatches.length > 0) {
                        console.log(`Hero-SMS service prefix "${prefix}" returned 0 exact matches. Using contains matches: ${containsMatches.join(', ')}`);
                        resolved.push(...containsMatches);
                    } else {
                        console.log(`Hero-SMS service prefix "${prefix}" returned 0 matches.`);
                    }
                }
            }

            if (HERO_SMS_SERVICE_QUERY) {
                const queryMatches = catalog
                    .filter((row) => row.code.includes(HERO_SMS_SERVICE_QUERY) || row.nameLower.includes(HERO_SMS_SERVICE_QUERY))
                    .map((row) => row.code);
                if (queryMatches.length > 0) {
                    console.log(`Hero-SMS service query "${HERO_SMS_SERVICE_QUERY}" matched: ${uniqLower(queryMatches).join(', ')}`);
                    resolved.push(...queryMatches);
                } else {
                    console.log(`Hero-SMS service query "${HERO_SMS_SERVICE_QUERY}" returned 0 matches.`);
                }
            }
        } catch (err) {
            console.log(`Hero-SMS service catalog unavailable: ${err.message}`);
        }
    }

    const uniqueResolved = uniqLower(resolved);
    if (uniqueResolved.length > 0) {
        heroSmsServiceCandidatesCache = uniqueResolved;
        console.log(`Hero-SMS service candidates: ${heroSmsServiceCandidatesCache.join(', ')}`);
        return heroSmsServiceCandidatesCache;
    }

    heroSmsServiceCandidatesCache = [String(HERO_SMS_SERVICE || 'dr').trim().toLowerCase()].filter(Boolean);
    console.log(`Hero-SMS fallback service: ${heroSmsServiceCandidatesCache.join(', ')}`);
    return heroSmsServiceCandidatesCache;
}

function shouldRankByPrice() {
    if (!HERO_SMS_PRICE_RANKING) return true;
    return !['0', 'false', 'off', 'none', 'disabled'].includes(HERO_SMS_PRICE_RANKING);
}

function crossProductAcquirePlan(countries, services) {
    const plan = [];
    for (const country of countries) {
        for (const service of services) {
            plan.push({
                country,
                service,
                hasPrice: false,
                cost: Infinity,
                count: 0,
                physicalCount: 0
            });
        }
    }
    return plan;
}

async function heroSmsBuildAcquirePlan(countries, services) {
    const basePlan = crossProductAcquirePlan(countries, services);
    if (!shouldRankByPrice()) {
        console.log('Hero-SMS ranking: disabled, using country/service order as configured.');
        return basePlan;
    }

    const countryOrder = new Map(countries.map((country, idx) => [country, idx]));
    const serviceOrder = new Map(services.map((service, idx) => [service, idx]));
    const pricesByCountry = {};

    for (const country of countries) {
        try {
            pricesByCountry[country] = await heroSmsFetchPricesByCountry(country);
        } catch (err) {
            pricesByCountry[country] = {};
            console.log(`Hero-SMS getPrices country=${country} failed: ${err.message}`);
        }
    }

    const withPrice = basePlan.map((item) => {
        const info = pricesByCountry[item.country] && pricesByCountry[item.country][item.service]
            ? pricesByCountry[item.country][item.service]
            : null;
        if (!info) return item;
        return {
            ...item,
            hasPrice: !!info.hasPrice,
            cost: info.cost,
            count: info.count,
            physicalCount: info.physicalCount
        };
    });

    withPrice.sort((a, b) => {
        if (a.hasPrice !== b.hasPrice) return a.hasPrice ? -1 : 1;
        if (a.hasPrice && b.hasPrice && a.cost !== b.cost) return a.cost - b.cost;
        if (a.count !== b.count) return b.count - a.count;
        if (a.physicalCount !== b.physicalCount) return b.physicalCount - a.physicalCount;
        const countryCmp = (countryOrder.get(a.country) ?? 0) - (countryOrder.get(b.country) ?? 0);
        if (countryCmp !== 0) return countryCmp;
        return (serviceOrder.get(a.service) ?? 0) - (serviceOrder.get(b.service) ?? 0);
    });

    const preview = withPrice.slice(0, 12).map((x) => (
        `${x.country}/${x.service}:${x.hasPrice ? x.cost : 'n/a'}`
    ));
    console.log(`Hero-SMS ranking: price_asc. First candidates: ${preview.join(', ')}`);
    return withPrice;
}

function heroSmsBuildCountryRetryPlan(acquirePlan) {
    const seen = new Set();
    const plan = [];
    for (const candidate of acquirePlan || []) {
        const country = String(candidate && candidate.country || '').trim();
        if (!country || seen.has(country)) continue;
        seen.add(country);
        plan.push(candidate);
    }
    return plan;
}

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
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`hero_sms_http_${res.statusCode}:${heroSmsErrorText(body)}`));
                }
                resolve(String(body || '').trim());
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('hero_sms_timeout'));
        });
        req.on('error', (err) => reject(err));
    });
}

async function heroSmsSetStatus(activationId, status) {
    if (!activationId) return '';
    try {
        return await heroSmsRequest({
            action: 'setStatus',
            id: activationId,
            status
        });
    } catch (err) {
        return `ERR:${err.message}`;
    }
}

async function heroSmsAcquireActivationFromPlan(acquirePlan) {
    let lastReason = 'no_attempts';
    const perCandidateRetries = Math.max(1, parseInt(process.env.HERO_SMS_GETNUMBER_RETRIES || '5', 10) || 5);
    const retryDelayMs = Math.max(500, parseInt(process.env.HERO_SMS_GETNUMBER_RETRY_DELAY_MS || '1200', 10) || 1200);

    for (const candidate of (acquirePlan || [])) {
        const country = candidate.country;
        const service = candidate.service;

        for (let attempt = 1; attempt <= perCandidateRetries; attempt++) {
            const params = {
                action: 'getNumber',
                service,
                country
            };

            // Apply maxPrice: explicit env override wins, otherwise derive from candidate price with margin
            const envMaxPrice = parseFloat(HERO_SMS_MAX_PRICE);
            if (Number.isFinite(envMaxPrice) && envMaxPrice > 0) {
                params.maxPrice = envMaxPrice;
            } else if (candidate.hasPrice && candidate.cost > 0) {
                // Add 15% margin over the listed price to cover dynamic pricing drift
                params.maxPrice = Math.round(candidate.cost * 1.15 * 1000) / 1000;
            } else {
                // No price info available (ranking off) — use a conservative default maxPrice
                // that covers most OpenAI activations without overpaying
                params.maxPrice = 0.1;
            }

            const raw = await heroSmsRequest(params);

            const activation = parseHeroActivation(raw);
            if (activation && activation.id && activation.phone) {
                console.log(`Hero-SMS activation acquired: id=${activation.id}, country=${country}, service=${service}, price=${candidate.hasPrice ? candidate.cost : 'n/a'}, phone=${activation.phone}`);
                return { ...activation, country, service, cost: candidate.hasPrice ? candidate.cost : null };
            }

            const reason = heroSmsErrorText(raw);
            lastReason = `country=${country},service=${service},reason=${reason}`;
            console.log(`Hero-SMS getNumber country=${country} service=${service} try=${attempt}/${perCandidateRetries} price=${candidate.hasPrice ? candidate.cost : 'n/a'}: ${reason}`);

            const retriableNoNumbers = /NO_NUMBERS/i.test(reason);
            const terminal = /SERVICE_NOT_AVAILABLE|BAD_SERVICE|BAD_COUNTRY|NO_BALANCE/i.test(reason);

            if (terminal) {
                break;
            }
            if (retriableNoNumbers && attempt < perCandidateRetries) {
                await sleep(retryDelayMs);
                continue;
            }
            if (!retriableNoNumbers) {
                break;
            }
        }
    }

    throw new Error(`hero_sms_get_number_failed:${lastReason}`);
}

async function heroSmsAcquireActivation() {
    if (!HERO_SMS_API_KEY) {
        throw new Error('hero_sms_api_key_missing');
    }
    const serviceCandidates = await heroSmsResolveServiceCandidates();
    const acquirePlan = await heroSmsBuildAcquirePlan(HERO_SMS_COUNTRIES, serviceCandidates);
    return heroSmsAcquireActivationFromPlan(acquirePlan);
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
            return code;
        }
        if (/STATUS_CANCEL|STATUS_WAIT_RETRY|BAD_STATUS|BAD_KEY/i.test(status)) {
            throw new Error(`hero_sms_status_failed:${status}`);
        }
        await sleep(HERO_SMS_POLL_INTERVAL_MS);
    }

    throw new Error(`hero_sms_code_timeout:${lastStatus}`);
}

async function clickButtonByText(page, regex) {
    const clicked = await page.evaluate((pattern) => {
        const re = new RegExp(pattern, 'i');
        const isVisible = (el) => {
            const st = window.getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden';
        };
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"]'));
        for (const el of nodes) {
            if (!el || !isVisible(el)) continue;
            if ('disabled' in el && el.disabled) continue;
            const text = ((el.textContent || '') + ' ' + (el.value || '')).replace(/\s+/g, ' ').trim();
            if (!text) continue;
            if (re.test(text)) {
                el.click();
                return true;
            }
        }
        return false;
    }, regex.source || String(regex));
    return !!clicked;
}

async function waitForAnySelector(page, selectors, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        for (const selector of selectors) {
            const handle = await page.$(selector).catch(() => null);
            if (handle) return { selector, handle };
        }
        await sleep(250);
    }
    return null;
}

async function fillInputValue(page, input, value) {
    await input.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await input.click().catch(() => {});
    for (const ch of String(value || '')) {
        await page.keyboard.type(ch, { delay: 35 });
    }
}

async function setCountryAndPhoneInput(page, rawPhone) {
    console.log('Filling phone step: Mexico (+52) + 10-digit number + SMS...');
    try {
        // 1. Switch country button to Mexico (+52) if needed
        const buttons = await page.$$('button');
        for (const b of buttons) {
            const txt = await page.evaluate(el => (el.textContent || '').replace(/\s+/g, ' ').trim(), b);
            if (/\(\+\d+\)/.test(txt) && !txt.includes('+52')) {
                await b.click().catch(() => {});
                await sleep(400);
                await page.keyboard.type('Mexico', { delay: 40 }).catch(() => {});
                await sleep(400);
                await page.keyboard.press('Enter').catch(() => {});
                await sleep(800);
                break;
            }
        }

        // 2. Select SMS ("Text Message") option
        await selectSmsDeliveryMethod(page);
        await sleep(400);

        // 3. Enter 10-digit national number
        let nationalDigits = String(rawPhone || '').replace(/\D/g, '');
        if (nationalDigits.startsWith('52') && nationalDigits.length === 12) {
            nationalDigits = nationalDigits.slice(2);
        }
        console.log(`Entering 10-digit national number: ${nationalDigits}`);

        const telInput = await page.$('input[type="tel"], input[name*="phone" i]');
        if (telInput) {
            await telInput.click({ clickCount: 3 }).catch(() => {});
            await page.keyboard.press('Backspace').catch(() => {});
            await telInput.click().catch(() => {});
            await page.keyboard.type(nationalDigits, { delay: 40 }).catch(() => {});
            await sleep(500);
        }

        // 4. Submit form via Enter key and submit button click
        console.log('Submitting phone verification form...');
        await page.keyboard.press('Enter').catch(() => {});
        await page.evaluate(() => {
            const submit = document.querySelector('button[type="submit"], input[type="submit"]');
            if (submit) submit.click();
        }).catch(() => {});

        await sleep(2000);
        return true;
    } catch (e) {
        console.log(`setCountryAndPhoneInput error: ${e.message}`);
        return false;
    }
}

async function selectSmsDeliveryMethod(page) {
    console.log('Ensuring SMS delivery method ("Text Message") is selected in UI...');
    try {
        for (let attempt = 0; attempt < 5; attempt++) {
            const res = await page.evaluate(() => {
                // 1. Look for radio input with value="sms"
                const smsInput = document.querySelector('input[type="radio"][value="sms"]');
                if (smsInput) {
                    const label = smsInput.closest('label') || smsInput.parentElement;
                    if (label) {
                        label.click();
                    }
                    smsInput.click();
                    smsInput.checked = true;
                    smsInput.dispatchEvent(new Event('change', { bubbles: true }));
                    smsInput.dispatchEvent(new Event('input', { bubbles: true }));
                    return { ok: true, method: 'radio_sms', checked: smsInput.checked };
                }

                // 2. Search for any clickable element with text "Text Message" or "SMS"
                const candidates = Array.from(document.querySelectorAll('label, button, a, div[role="button"], div[role="radio"], span'));
                for (const el of candidates) {
                    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (/^text message$/i.test(txt) || /^sms$/i.test(txt) || /send code via sms/i.test(txt) || /text message \(/i.test(txt)) {
                        el.click();
                        return { ok: true, method: 'text_node', text: txt };
                    }
                }

                return { ok: false };
            });

            if (res && res.ok) {
                console.log(`Successfully selected SMS delivery option in UI (method=${res.method})`);
                await sleep(500);
                return;
            }
            await sleep(600);
        }
        console.log('No explicit SMS/WhatsApp toggle found (SMS is likely default for this country)');
    } catch (e) {
        console.log(`selectSmsDeliveryMethod error: ${e.message}`);
    }
}

async function completePhoneVerificationWithHeroSMS(page) {
    if (!HERO_SMS_API_KEY) {
        return { success: false, reason: 'phone_required_hero_sms_api_key_missing' };
    }

    const serviceCandidates = await heroSmsResolveServiceCandidates();
    const acquirePlan = await heroSmsBuildAcquirePlan(HERO_SMS_COUNTRIES, serviceCandidates);
    const countryRetryPlan = heroSmsBuildCountryRetryPlan(acquirePlan).slice(0, HERO_SMS_MAX_COUNTRY_ATTEMPTS);
    if (countryRetryPlan.length === 0) {
        return { success: false, reason: 'phone_required:hero_sms_no_country_plan' };
    }
    console.log(`Hero-SMS country attempts: ${countryRetryPlan.map((x) => x.country).join(', ')} (max=${HERO_SMS_MAX_COUNTRY_ATTEMPTS})`);

    await takeScreenshot(page, '08d-phone-required');
    let lastReason = 'hero_sms_no_attempts';
    const phoneInputSelectors = [
        'input[type="tel"]',
        'input[autocomplete="tel"]',
        'input[name*="phone" i]',
        'input[aria-label*="phone" i]',
        'input[inputmode="tel"]'
    ];
    const codeInputSelectors = [
        'input[autocomplete="one-time-code"]',
        'input[name*="code" i]',
        'input[placeholder*="code" i]',
        'input[inputmode="numeric"][maxlength="6"]',
        'input[maxlength="6"]'
    ];

    async function ensurePhoneInputVisible() {
        let phoneInputResult = await waitForAnySelector(page, phoneInputSelectors, 6000);
        if (phoneInputResult && phoneInputResult.handle) return phoneInputResult;

        const codeInputResult = await waitForAnySelector(page, codeInputSelectors, 2000);
        if (codeInputResult && codeInputResult.handle) {
            // When we're stuck on "enter code", force-switch back to "enter phone".
            await clickButtonByText(page, /(change|different|another|edit|other number|use another|back|друг|измен|назад|сменить)/i).catch(() => {});
            await sleep(1200);
        }

        for (let i = 0; i < 3; i++) {
            phoneInputResult = await waitForAnySelector(page, phoneInputSelectors, 3000);
            if (phoneInputResult && phoneInputResult.handle) return phoneInputResult;

            await clickButtonByText(page, /(change|different|another|edit|other number|use another|back|друг|измен|назад|сменить)/i).catch(() => {});
            await sleep(1000);
        }

        // Last resort: open phone step directly.
        await page.goto('https://auth.openai.com/add-phone', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(1200);
        return await waitForAnySelector(page, phoneInputSelectors, 6000);
    }

    async function ensureSmsReadyBeforeAcquire() {
        // HARD GATE: do not request paid phone numbers until SMS path is confirmed in UI.
        const smsState = await page.evaluate(() => {
            const radioGroup = document.querySelector('div[role="radiogroup"][aria-label="Send code via"], div[role="radiogroup"]');
            const smsRadio = radioGroup ? radioGroup.querySelector('input[type="radio"][value="sms"]') : null;
            const waRadio = radioGroup ? radioGroup.querySelector('input[type="radio"][value="whatsapp"]') : null;
            const channelInput = document.querySelector('input[name="channel"]');
            return {
                hasRadioGroup: !!radioGroup,
                hasSmsRadio: !!smsRadio,
                smsChecked: !!(smsRadio && smsRadio.checked),
                whatsappChecked: !!(waRadio && waRadio.checked),
                hasChannelInput: !!channelInput,
                channelValue: channelInput ? String(channelInput.value || '').toLowerCase() : '',
                preview: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 500)
            };
        }).catch(() => null);

        if (!smsState) return { ok: false, reason: 'sms_gate_dom_eval_failed' };

        // Debug dump for investigating missing SMS toggle
        try {
            const fullDump = await page.evaluate(() => ({
                url: location.href,
                title: document.title,
                text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 8000),
                html: (document.body && document.body.innerHTML ? document.body.innerHTML : '').slice(0, 120000),
                interactives: Array.from(document.querySelectorAll('input, button, label, [role], [data-testid], [aria-label]')).map(el => ({
                    tag: el.tagName,
                    type: el.type || '',
                    name: el.name || '',
                    value: el.value || '',
                    role: el.getAttribute('role') || '',
                    ariaLabel: el.getAttribute('aria-label') || '',
                    dataTestId: el.getAttribute('data-testid') || '',
                    dataState: el.getAttribute('data-state') || '',
                    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                    checked: !!el.checked,
                }))
            }));
            require('fs').writeFileSync('/tmp/add-phone-sms-gate-debug.json', JSON.stringify(fullDump, null, 2));
            console.log('SMS gate debug dump saved: /tmp/add-phone-sms-gate-debug.json');
        } catch (e) {
            console.log(`SMS gate debug dump failed: ${e.message}`);
        }

        const smsStateAfter = smsState; // Skip post-check here, we'll select SMS after entering the phone number

        if (!smsStateAfter) return { ok: false, reason: 'sms_gate_postcheck_failed' };

        const smsExplicit = smsStateAfter.hasRadioGroup && smsStateAfter.hasSmsRadio && smsStateAfter.smsChecked && !smsStateAfter.whatsappChecked;
        const smsViaHiddenChannel = smsStateAfter.hasChannelInput && smsStateAfter.channelValue === 'sms';
        const smsByDefault = !smsStateAfter.hasRadioGroup && !smsStateAfter.hasChannelInput;

        if (smsExplicit || smsViaHiddenChannel || smsByDefault) {
            console.log(`SMS gate passed: explicit=${smsExplicit}, hiddenChannelSms=${smsViaHiddenChannel}, defaultSmsOnly=${smsByDefault}`);
            return { ok: true };
        }

        console.log(`SMS gate failed: hasRadioGroup=${smsStateAfter.hasRadioGroup}, hasSmsRadio=${smsStateAfter.hasSmsRadio}, smsChecked=${smsStateAfter.smsChecked}, whatsappChecked=${smsStateAfter.whatsappChecked}, channel=${smsStateAfter.channelValue}`);
        return { ok: false, reason: 'sms_gate_not_confirmed' };
    }

    // HARD GATE before any paid activation request
    const smsGate = await ensureSmsReadyBeforeAcquire();
    if (!smsGate.ok) {
        return { success: false, reason: smsGate.reason || 'sms_gate_failed' };
    }

    if (process.env.CODEX_DRY_RUN_PHONE === '1') {
        console.log('[DRY-RUN] Testing Mexico country selection and SMS delivery method without buying phone number...');
        await setCountryAndPhoneInput(page, '526641234567');
        const dryRunState = await page.evaluate(() => ({
            url: location.href,
            bodyText: (document.body.innerText || '').slice(0, 500).replace(/\s+/g, ' '),
            countryBtn: Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(t => /\(\+\d+\)/.test(t)),
            radios: Array.from(document.querySelectorAll('input[type="radio"]')).map(r => ({ value: r.value, checked: r.checked }))
        }));
        console.log(`[DRY-RUN RESULT] State:\n${JSON.stringify(dryRunState, null, 2)}`);
        return { success: false, reason: 'dry_run_completed' };
    }

    if (process.env.CODEX_DRY_RUN_PHONE === '1') {
        console.log('[DRY-RUN] Testing Mexico country selection and SMS delivery method without buying phone number...');
        await setCountryAndPhoneInput(page, '526641234567');
        const dryRunState = await page.evaluate(() => ({
            url: location.href,
            bodyText: (document.body.innerText || '').slice(0, 500).replace(/\s+/g, ' '),
            countryBtn: Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(t => /\(\+\d+\)/.test(t)),
            radios: Array.from(document.querySelectorAll('input[type="radio"]')).map(r => ({ value: r.value, checked: r.checked }))
        }));
        console.log(`[DRY-RUN RESULT] State:\n${JSON.stringify(dryRunState, null, 2)}`);
        return { success: false, reason: 'dry_run_completed' };
    }

    for (let countryAttempt = 0; countryAttempt < countryRetryPlan.length; countryAttempt++) {
        const countryCandidate = countryRetryPlan[countryAttempt];
        const country = countryCandidate.country;
        const countryPlan = acquirePlan.filter((x) => x.country === country);
        let activation = null;

        try {
            console.log(`Hero-SMS country attempt ${countryAttempt + 1}/${countryRetryPlan.length}: country=${country}, best_price=${countryCandidate.hasPrice ? countryCandidate.cost : 'n/a'}`);
            activation = await heroSmsAcquireActivationFromPlan(countryPlan);
            if (activation && activation.id) {
                const statusResp = await heroSmsSetStatus(activation.id, 1);
                console.log(`Hero-SMS setStatus(1): ${statusResp}`);
            }

            const phoneInputResult = await ensurePhoneInputVisible();
            if (!phoneInputResult || !phoneInputResult.handle) {
                throw new Error('phone_input_not_found');
            }

            // SMS delivery method selection is done OUTSIDE this function,
            // immediately when the add-phone page first appears (before HeroSMS acquire).
            // This is critical because the radiogroup disappears after React re-renders.

            // Build phone candidates: enter the full international number with + prefix.
            // OpenAI's phone input auto-detects the country from the number.
            const rawPhone = String(activation.phone || '');
            console.log(`Using phone number: ${rawPhone}`);
            let codeInputResult = null;
            let deliveryMode = 'unknown';

            const detectDeliveryMode = async () => {
                const snap = await page.evaluate(() => {
                    const txt = (document.body && document.body.innerText) ? document.body.innerText : '';
                    return txt;
                }).catch(() => '');
                const text = String(snap || '').toLowerCase();
                if (/unable to send a verification code to this phone number|please try again later|use a different number|could not send code|number is not supported/i.test(text)) {
                    return { mode: 'rejected', text: snap };
                }
                if (/whatsapp|what\s*app/.test(text)) return { mode: 'whatsapp', text: snap };
                if (/sms|text message|verification code|enter code|one[- ]time code|otp|resend text message/.test(text)) return { mode: 'sms', text: snap };
                return { mode: 'unknown', text: snap };
            };

            await setCountryAndPhoneInput(page, rawPhone);
            await sleep(2500);

                // Fast UI decision: do NOT wait 120s if target clearly requests WhatsApp or rejects number.
                await sleep(2500);
                const modeInfo = await detectDeliveryMode();
                deliveryMode = modeInfo.mode;
                console.log(`Phone step UI mode: ${deliveryMode}`);
                if (modeInfo.text) {
                    console.log(`Phone step UI text preview: ${modeInfo.text.replace(/\s+/g, ' ').slice(0, 300)}`);
                }

                // Do not fail on WhatsApp mention in text — SMS code is always sent by OpenAI
                if (deliveryMode === 'rejected') {
                    console.log('OpenAI rejected this phone number. Will cancel and try another number.');
                    break;
                }

                codeInputResult = await waitForAnySelector(page, codeInputSelectors, 3500);

            if (!codeInputResult || !codeInputResult.handle) {
                if (deliveryMode === 'whatsapp') throw new Error('phone_requires_whatsapp');
                if (deliveryMode === 'rejected') throw new Error('phone_rejected_by_openai');
                throw new Error('sms_code_input_not_found');
            }

            console.log(`Waiting for Hero-SMS code (timeout=${HERO_SMS_POLL_TIMEOUT_SEC}s)...`);
            const smsCode = await heroSmsWaitForCode(activation.id);
            console.log(`Hero-SMS code received: ${smsCode}`);

            const codeBoxes = await page.$$('input[inputmode="numeric"][maxlength="1"], input[maxlength="1"]').catch(() => []);
            if (codeBoxes && codeBoxes.length >= 4 && smsCode.length >= 4) {
                const digits = smsCode.split('');
                for (let i = 0; i < codeBoxes.length && i < digits.length; i++) {
                    await fillInputValue(page, codeBoxes[i], digits[i]);
                }
            } else {
                await fillInputValue(page, codeInputResult.handle, smsCode);
            }

            await clickButtonByText(page, /(verify|continue|next|confirm|submit|готов|подтверд)/i);
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await sleep(2500);
            await takeScreenshot(page, '08f-phone-verified');

            const url = page.url();
            if (url.includes('add-phone')) {
                throw new Error('phone_verification_still_required');
            }

            if (activation && activation.id) {
                const doneResp = await heroSmsSetStatus(activation.id, 6);
                console.log(`Hero-SMS setStatus(6): ${doneResp}`);
            }
            return { success: true };
        } catch (err) {
            lastReason = String(err && err.message ? err.message : err || 'unknown_error');
            if (activation && activation.id) {
                try {
                    const cancelResp = await heroSmsSetStatus(activation.id, 8);
                    console.log(`Hero-SMS setStatus(8): ${cancelResp}`);
                    if (heroSmsNeedsDelayedCancel(cancelResp)) {
                        console.log(`[MONEY-SAVER] Early cancel denied for id=${activation.id}. Scheduling background cancel retry in 185s...`);
                        const actIdToCancel = activation.id;
                        setTimeout(async () => {
                            try {
                                const retryCancelResp = await heroSmsSetStatus(actIdToCancel, 8);
                                console.log(`[MONEY-SAVER] Hero-SMS background cancel retry result for id=${actIdToCancel}: ${retryCancelResp}`);
                            } catch (e2) {
                                console.log(`[MONEY-SAVER] Failed background cancel for id=${actIdToCancel}: ${e2.message}`);
                            }
                        }, 185 * 1000);
                    }
                } catch (cancelErr) {
                    console.log(`Hero-SMS setStatus(8) error: ${String(cancelErr && cancelErr.message ? cancelErr.message : cancelErr)}`);
                    console.log(`[MONEY-SAVER] Waiting 185s to retry cancel after error...`);
                    await sleep(185 * 1000);
                    try {
                        const retryCancelResp = await heroSmsSetStatus(activation.id, 8);
                        console.log(`[MONEY-SAVER] Hero-SMS delayed cancel retry after error result: ${retryCancelResp}`);
                    } catch (e2) {
                        console.log(`[MONEY-SAVER] Failed final cancel: ${e2.message}`);
                    }
                }
            }
            console.log(`Hero-SMS country attempt failed: country=${country}, reason=${lastReason}`);

            const canTryNextCountry = /hero_sms_code_timeout|STATUS_WAIT_CODE|sms_code_input_not_found|hero_sms_get_number_failed|phone_input_not_found|phone_verification_still_required|phone_requires_whatsapp|phone_rejected_by_openai/i.test(lastReason);
            if (!canTryNextCountry) {
                return { success: false, reason: `phone_required:${lastReason}` };
            }

            if (countryAttempt < countryRetryPlan.length - 1) {
                await clickButtonByText(page, /(change|different|another|edit|use another|other number|back|друг|измен|назад)/i).catch(() => {});
                await sleep(1000);
            }
        }
    }

    return { success: false, reason: `phone_required:${lastReason}` };
}

async function applySteadyBrowserProfile(page, profile, engine) {
    // Stealth: hide Puppeteer automation indicators so OpenAI serves the full
    // add-phone page (with SMS/WhatsApp channel selector) instead of a degraded
    // version that blocks SMS verification.
    if (engine === 'puppeteer') {
        await page.evaluateOnNewDocument(() => {
            // The main detection vector is navigator.webdriver being true
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        });
        await page.setUserAgent(profile.userAgent);
        await page.setViewport(profile.viewport);
        await page.setExtraHTTPHeaders({
            'Accept-Language': profile.acceptLanguage
        });
        return;
    }

    // Playwright
    if (typeof page.evaluateOnNewDocument === 'function') {
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        });
    }
    if (typeof page.setViewportSize === 'function') {
        await page.setViewportSize(profile.viewport).catch(() => {});
    }
    if (typeof page.context === 'function') {
        const context = page.context();
        if (context && typeof context.setExtraHTTPHeaders === 'function') {
            await context.setExtraHTTPHeaders({
                'Accept-Language': profile.acceptLanguage
            }).catch(() => {});
        }
    }
}

async function launchBrowserPage({
    launchArgs,
    proxyConfig,
    proxyServerArg,
    shouldUseProxyChain,
    browserProfile
}) {
    const engines = browserEngineOrder(BROWSER_ENGINE);
    const launchErrors = [];

    for (const engine of engines) {
        try {
            if (engine === 'puppeteer') {
                // Try puppeteer-extra with stealth plugin first (hides bot indicators)
                let useStealth = false;
                let puppeteerExtra = null;
                try {
                    puppeteerExtra = require('puppeteer-extra');
                    if (stealthPlugin) {
                        puppeteerExtra.use(stealthPlugin);
                        useStealth = true;
                    }
                } catch (_) {
                    // puppeteer-extra not available, fallback to regular puppeteer
                }

                const puppeteer = useStealth ? puppeteerExtra : (optionalRequire('puppeteer') || optionalRequire('puppeteer-core'));
                if (!puppeteer) {
                    throw new Error('puppeteer module is not installed');
                }

                const launchOptions = {
                    headless: false,
                    args: launchArgs
                };

                const chromeExecutable = resolveChromeExecutable();
                if (chromeExecutable) {
                    launchOptions.executablePath = chromeExecutable;
                } else {
                    const playwright = optionalRequire('playwright');
                    const playwrightExecutable = playwright && playwright.chromium && typeof playwright.chromium.executablePath === 'function'
                        ? playwright.chromium.executablePath()
                        : '';
                    if (playwrightExecutable && fs.existsSync(playwrightExecutable)) {
                        launchOptions.executablePath = playwrightExecutable;
                        console.log(`Using Playwright Chromium executable for Puppeteer: ${playwrightExecutable}`);
                    }
                }

                const browser = await puppeteer.launch(launchOptions);
                const page = await browser.newPage();

                if (proxyConfig && proxyConfig.username && !shouldUseProxyChain && typeof page.authenticate === 'function') {
                    await page.authenticate({
                        username: proxyConfig.username,
                        password: proxyConfig.password
                    });
                }

                return { engine, browser, page };
            }

            const playwright = optionalRequire('playwright');
            if (!playwright || !playwright.chromium) {
                throw new Error('playwright module is not installed');
            }

            const playwrightArgs = launchArgs.filter((arg) => !arg.startsWith('--proxy-server='));
            const launchOptions = {
                headless: true,
                args: playwrightArgs
            };

            if (proxyServerArg) {
                launchOptions.proxy = { server: proxyServerArg };
            } else if (proxyConfig) {
                const proxyOpts = { server: proxyConfig.server };
                if (proxyConfig.username) {
                    proxyOpts.username = proxyConfig.username;
                    proxyOpts.password = proxyConfig.password || '';
                }
                launchOptions.proxy = proxyOpts;
            }

            const browser = await playwright.chromium.launch(launchOptions);
            const context = await browser.newContext({
                userAgent: browserProfile.userAgent,
                viewport: browserProfile.viewport,
                locale: 'en-US'
            });
            await context.setExtraHTTPHeaders({
                'Accept-Language': browserProfile.acceptLanguage
            }).catch(() => {});
            const page = await context.newPage();

            return { engine, browser, page };
        } catch (error) {
            const reason = String((error && error.message) || error || 'unknown_error');
            launchErrors.push(`${engine}:${reason}`);
            console.log(`Browser launch failed on ${engine}: ${reason}`);
        }
    }

    throw new Error(`browser_launch_failed:${launchErrors.join(' | ')}`);
}

// Get verification code from Gmail IMAP (app password).
// waitForNewEmail=true makes it wait for message count growth before reading code.
async function getVerificationCodeFromIMAP(email, password, waitSeconds = 60, waitForNewEmail = false) {
    console.log(`Waiting for verification email at ${email}...`);

    const isGmail = email.toLowerCase().endsWith('@gmail.com');
    const IMAP_HOST = isGmail ? 'imap.gmail.com' : 'imap.firstmail.ltd';
    const IMAP_PORT = 993;
    const effectiveAppPassword = ACCOUNT.appPassword || ACCOUNT.imapPassword || process.env.CODEX_GMAIL_APP_PASSWORD || password || '';
    const appPassword = String(effectiveAppPassword).replace(/\s+/g, '');

    console.log(`IMAP Server selected: ${IMAP_HOST}:${IMAP_PORT} (isGmail=${isGmail})`);

    const startTime = Date.now();
    let initialCount = 0;

    if (waitForNewEmail) {
        try {
            const initialResult = execSync(`python3 -c "
import imaplib
imap = imaplib.IMAP4_SSL('${IMAP_HOST}', ${IMAP_PORT})
imap.login('${email.replace(/'/g, "'\\''")}', '${appPassword.replace(/'/g, "'\\''")}')
imap.select('INBOX')
status, msgs = imap.search(None, 'ALL')
count = len(msgs[0].split()) if msgs[0] else 0
imap.close()
imap.logout()
print(count)
"`, { encoding: 'utf8', timeout: 10000 });
            initialCount = parseInt(initialResult.trim(), 10) || 0;
            console.log(`Initial inbox count: ${initialCount}`);
        } catch {
            initialCount = 0;
        }
    }

    while (Date.now() - startTime < waitSeconds * 1000) {
        try {
            if (waitForNewEmail) {
                const countResult = execSync(`python3 -c "
import imaplib
imap = imaplib.IMAP4_SSL('${IMAP_HOST}', ${IMAP_PORT})
imap.login('${email.replace(/'/g, "'\\''")}', '${appPassword.replace(/'/g, "'\\''")}')
imap.select('INBOX')
status, msgs = imap.search(None, 'ALL')
count = len(msgs[0].split()) if msgs[0] else 0
imap.close()
imap.logout()
print(count)
"`, { encoding: 'utf8', timeout: 10000 });
                const currentCount = parseInt(countResult.trim(), 10) || 0;
                if (currentCount <= initialCount) {
                    await new Promise(r => setTimeout(r, 2500));
                    continue;
                }
                console.log(`New email detected! Count: ${initialCount} -> ${currentCount}`);
                initialCount = currentCount;
            }

            const codeResult = execSync(`python3 -c "
import imaplib
import email as email_lib
import re

imap = imaplib.IMAP4_SSL('${IMAP_HOST}', ${IMAP_PORT})
imap.login('${email.replace(/'/g, "'\\''")}', '${appPassword.replace(/'/g, "'\\''")}')
imap.select('INBOX')

status, msgs = imap.search(None, 'ALL')
if msgs[0]:
    nums = msgs[0].split()
    if nums:
        num = nums[-1]
        status, data = imap.fetch(num, '(RFC822)')
        if data[0]:
            msg = email_lib.message_from_bytes(data[0][1])
            plain = ''
            html = ''
            if msg.is_multipart():
                for part in msg.walk():
                    ctype = part.get_content_type()
                    payload = part.get_payload(decode=True)
                    if not payload:
                        continue
                    text = payload.decode('utf-8', errors='ignore')
                    if ctype == 'text/plain' and not plain:
                        plain = text
                    elif ctype == 'text/html' and not html:
                        html = text
            else:
                payload = msg.get_payload(decode=True)
                if payload:
                    plain = payload.decode('utf-8', errors='ignore')

            search_text = plain if plain.strip() else html
            matches = re.findall(r'\\b\\d{6}\\b', search_text)
            if matches:
                print(matches[-1])

imap.close()
imap.logout()
"`, { encoding: 'utf8', timeout: 10000 });

            const code = codeResult.trim();
            if (/^\d{6}$/.test(code)) {
                console.log(`✓ Verification code: ${code}`);
                return code;
            }
        } catch (error) {
            console.log(`IMAP check error: ${error.message}`);
        }

        await new Promise(r => setTimeout(r, 2500));
    }

    console.log('✗ Timeout waiting for verification code');
    return null;
}

async function takeScreenshot(page, name, options = {}) {
    if (!ENABLE_SCREENSHOTS && options.force !== true) {
        return;
    }
    try {
        await page.screenshot({ path: `/tmp/codex-login-${name}.png`, fullPage: false });
        console.log(`Screenshot saved: /tmp/codex-login-${name}.png`);
    } catch (e) {
        console.log(`Failed to take screenshot: ${e.message}`);
    }
}

async function detectKnownRouteError(page) {
    const text = await page.evaluate(() => (document.body && document.body.innerText) ? document.body.innerText : '');
    if (/oops,\s*an error occurred!/i.test(text) && /invalid content type/i.test(text)) {
        return 'route_error_invalid_content_type';
    }
    if (/oops,\s*an error occurred!/i.test(text) && /not valid json/i.test(text)) {
        return 'route_error_invalid_json';
    }
    if (/route error/i.test(text) && /(400|401|403|429|5\d\d)/.test(text)) {
        return 'route_error_http';
    }
    return null;
}

async function tryRecoverFromRouteError(page, maxRetries = 2) {
    for (let i = 1; i <= maxRetries; i++) {
        const currentError = await detectKnownRouteError(page);
        if (!currentError) {
            return true;
        }

        console.log(`Attempting route-error recovery (${i}/${maxRetries})...`);
        const waitNav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
        const clicked = await page.evaluate(() => {
            const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
            const btn = nodes.find((el) => /try again|retry/i.test((el.textContent || '').trim()));
            if (!btn) return false;
            btn.click();
            return true;
        });
        if (!clicked) {
            return false;
        }

        await waitNav;
        await new Promise(r => setTimeout(r, 2500));
        await takeScreenshot(page, `03r-route-recovery-${i}`);

        const stillError = await detectKnownRouteError(page);
        if (!stillError) {
            console.log('Route-error recovery succeeded.');
            return true;
        }
    }
    return false;
}

async function waitForPasswordOrKnownError(page, timeoutMs = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const passwordInput = await page.$('input[type="password"]');
        if (passwordInput) {
            return { state: 'password', input: passwordInput };
        }

        const knownError = await detectKnownRouteError(page);
        if (knownError) {
            return { state: 'error', reason: knownError };
        }

        await new Promise(r => setTimeout(r, 400));
    }
    return { state: 'timeout', reason: 'password_input_timeout' };
}

async function switchToSignInFlow(page, account, authUrl) {
    console.log('Navigating back to OAuth authUrl for Sign In flow...');
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: AUTH_PAGE_NAV_TIMEOUT_MS });
    await takeScreenshot(page, '06c-login-page');
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: EMAIL_INPUT_TIMEOUT_MS });

    // Enter email for Sign In
    console.log('Entering email for Sign In...');
    const signInEmail = await page.$('input[type="email"]');
    if (signInEmail) {
        await signInEmail.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await signInEmail.click();
        for (const char of account.email) {
            await page.keyboard.type(char, { delay: 50 });
        }
    }

    const signInContinue = await page.$('button[type="submit"]');
    if (signInContinue) {
        await signInContinue.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    await takeScreenshot(page, '06d-signin-email');

    // Wait a bit for the page to transition to password field
    await new Promise(r => setTimeout(r, 3000));

    // Check if password field is visible, if not click Continue again
    const pwdFieldVisible = await page.$('input[type="password"]');
    if (!pwdFieldVisible) {
        console.log('Password field not visible, clicking Continue...');
        const continueAfterEmail = await page.$('button[type="submit"]');
        if (continueAfterEmail) {
            await continueAfterEmail.click();
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    // Now wait for password field and enter password
    console.log('Waiting for password field...');
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });

    console.log('Entering password for Sign In...');
    const signInPwd = await page.$('input[type="password"]');
    if (signInPwd) {
        await signInPwd.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await signInPwd.click();
        for (const char of account.password) {
            await page.keyboard.type(char, { delay: 50 });
        }
    }

    const signInSubmit = await page.$('button[type="submit"]');
    if (signInSubmit) {
        await signInSubmit.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    await takeScreenshot(page, '06e-signin-password');
    console.log('Password submitted for Sign In');

    return page.url();
}

async function performLogin(authUrl) {
    installSignalHandlers();

    const effectiveAuthUrl = normalizeAuthUrl(authUrl);
    if (effectiveAuthUrl !== authUrl) {
        console.log('Auth URL normalized: removed unstable simplified-flow query param');
    }

    const proxyScheme = normalizeProxyScheme(process.env.CODEX_PROXY_SCHEME || 'http');
    const proxyRaw = process.env.CODEX_PROXY_ENTRY || '';
    let proxyConfig = null;
    let browser = null;
    let page = null;
    let browserEngine = 'puppeteer';
    let anonymizedProxyUrl = null;
    const forceProxyChain = process.env.CODEX_PROXY_FORCE_CHAIN === '1';

    if (proxyRaw) {
        try {
            proxyConfig = parseProxyEntry(proxyRaw, proxyScheme);
            console.log(`Using proxy: ${proxyConfig.server}`);
        } catch (e) {
            return { success: false, reason: `invalid_proxy:${e.message}` };
        }
    }

    try {
        let proxyServerArg = null;
        const shouldUseProxyChain = !!(proxyConfig && proxyConfig.username && (forceProxyChain || proxyConfig.scheme.startsWith('socks')));
        if (proxyConfig) {
            if (shouldUseProxyChain) {
                if (proxyConfig.scheme === 'https') {
                    anonymizedProxyUrl = await proxyChain.anonymizeProxy({
                        url: proxyConfig.upstreamUrl,
                        port: 0,
                        ignoreProxyCertificate: true
                    });
                } else {
                    anonymizedProxyUrl = await proxyChain.anonymizeProxy(proxyConfig.upstreamUrl);
                }
                activeAnonymizedProxyUrl = anonymizedProxyUrl;
                proxyServerArg = anonymizedProxyUrl;
                console.log(`Using local proxy bridge: ${proxyServerArg}`);
            } else {
                proxyServerArg = proxyConfig.server;
                if (proxyConfig.username) {
                    console.log('Using direct browser proxy auth mode (no proxy-chain bridge)');
                }
            }
        }

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-component-update',
            '--disable-renderer-backgrounding',
            '--disable-blink-features=AutomationControlled',
            '--ignore-certificate-errors',
            '--mute-audio',
            '--renderer-process-limit=2',
            '--lang=ru-RU,ru,en-US,en'
        ];
        if (proxyServerArg) {
            launchArgs.push(`--proxy-server=${proxyServerArg}`);
            launchArgs.push('--proxy-bypass-list=localhost,127.0.0.1,<local>');
        }

        const browserProfile = buildBrowserProfile();
        launchArgs.push(`--window-size=${browserProfile.viewport.width},${browserProfile.viewport.height}`);
        launchArgs.push('--start-maximized');
        const launched = await launchBrowserPage({
            launchArgs,
            proxyConfig,
            proxyServerArg,
            shouldUseProxyChain,
            browserProfile
        });
        browser = launched.browser;
        page = launched.page;
        browserEngine = launched.engine;
        activeBrowser = browser;
        activeAnonymizedProxyUrl = anonymizedProxyUrl;
        console.log(`Browser engine selected: ${browserEngine}`);

        if (!['0', 'off', 'false', 'no'].includes(CODEX_LEAN_REQUESTS)) {
            await enableLeanPageRequests(page, browserEngine);
        } else {
            console.log('Lean request blocking disabled (CODEX_LEAN_REQUESTS=off)');
        }

        page.on('pageerror', (err) => {
            console.log(`[PAGEERROR] ${err.message}`);
        });
        page.on('console', (msg) => {
            const text = msg.text();
            if (text.includes('net::ERR_FAILED') || text.includes('ddsource=browser') || text.includes('favicon.ico')) {
                return;
            }
            if (msg.type() === 'error' || /\b(error|exception|failed)\b/i.test(text)) {
                console.log(`[CONSOLE:${msg.type()}] ${text}`);
            }
        });

        await applySteadyBrowserProfile(page, browserProfile, browserEngine);

        // Track all URLs for callback extraction - intercept requests BEFORE they happen
        let callbackUrl = null;
        let localRedirectUrl = null;
        let lastUrl = authUrl;
        let passwordVerifyRejected = false;
        let createAccountUserExists = false;
        
        // Listen for all requests
        page.on('request', (request) => {
            const url = request.url();
            if (isCodexCallbackUrl(url)) {
                callbackUrl = url;
                console.log(`[REQUEST] Callback URL intercepted: ${url}`);
            } else if (url.includes('localhost:1455')) {
                localRedirectUrl = url;
                console.log(`[REQUEST] Local redirect without code: ${url}`);
            }

            if (url.includes('/api/accounts/create_account')) {
                const method = request.method();
                let payload = '';
                try { payload = request.postData() || ''; } catch (_) {}
                console.log(`[DEBUG create_account request] method=${method} payload=${payload}`);
            }

            lastUrl = url;
        });
        
        // Listen for responses
        page.on('response', (response) => {
            const url = response.url();
            const status = response.status();
            if (url.includes('auth.openai.com') && status >= 400) {
                const headers = response.headers();
                const contentType = headers['content-type'] || headers['Content-Type'] || '';
                console.log(`[HTTP ${status}] ${url} content-type=${contentType}`);
                if (url.includes('/api/accounts/create_account')) {
                    response.text().then((body) => {
                        const shortBody = String(body || '').replace(/\s+/g, ' ').slice(0, 1200);
                        console.log(`[DEBUG create_account response] status=${status} body=${shortBody}`);
                        if (shortBody.includes('user_already_exists') || shortBody.includes('already exists')) {
                            console.log('[SIGNUP-DETECT] create_account returned user_already_exists – will switch to Sign In');
                            createAccountUserExists = true;
                        }
                    }).catch(() => {});
                }
            }
            if (url.includes('/api/accounts/password/verify') && status === 401) {
                passwordVerifyRejected = true;
            }
            if (!callbackUrl && isCodexCallbackUrl(url)) {
                callbackUrl = url;
                console.log(`[RESPONSE] Callback URL from response: ${url}`);
            } else if (url.includes('localhost:1455')) {
                localRedirectUrl = url;
            }
        });
        
        // Listen for frame navigation
        page.on('framenavigated', (frame) => {
            const url = frame.url();
            if (!callbackUrl && isCodexCallbackUrl(url)) {
                callbackUrl = url;
                console.log(`[FRAME] Callback URL from frame: ${url}`);
            } else if (url.includes('localhost:1455')) {
                localRedirectUrl = url;
            }
        });

        console.log('Navigating to auth page...');
        let lastGotoError = null;
        for (let attempt = 1; attempt <= AUTH_PAGE_NAV_RETRIES; attempt++) {
            try {
                await page.goto(effectiveAuthUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: AUTH_PAGE_NAV_TIMEOUT_MS
                });
                lastGotoError = null;
                break;
            } catch (e) {
                lastGotoError = e;
                console.log(`Auth page navigation attempt ${attempt}/${AUTH_PAGE_NAV_RETRIES} failed: ${e.message}`);
                await new Promise(r => setTimeout(r, 1200));
            }
        }
        if (lastGotoError) {
            throw lastGotoError;
        }
        await takeScreenshot(page, '01-initial');
        await new Promise(r => setTimeout(r, BLANK_PAGE_SETTLE_MS));

        const loginPageSnapshot = await collectPageSnapshot(page);
        console.log(`Login page snapshot: ready=${loginPageSnapshot.readyState} nodes=${loginPageSnapshot.nodeCount} text=${loginPageSnapshot.textLength} emailInputs=${loginPageSnapshot.emailInputs} title=${JSON.stringify(loginPageSnapshot.title)}`);
        if (isProbablyBlankLoginPage(loginPageSnapshot)) {
            await takeScreenshot(page, '01-blank-auth-page', { force: true });
            return { success: false, reason: `blank_auth_page:${page.url()}` };
        }

        // Wait for email input or Cloudflare challenge
        console.log('Waiting for email input or Cloudflare challenge...');
        const emailSelector = 'input[type="email"], input[name="email"]';
        const startWaitTime = Date.now();
        while (Date.now() - startWaitTime < EMAIL_INPUT_TIMEOUT_MS) {
            const hasEmailInput = await page.$(emailSelector).catch(() => null);
            if (hasEmailInput) break;

            const pageTitle = await page.title().catch(() => '');
            if (pageTitle.includes('Один момент') || pageTitle.includes('Just a moment') || pageTitle.includes('Attention Required')) {
                console.log(`Cloudflare challenge detected (title: "${pageTitle}"). Attempting Turnstile frame interaction...`);
                for (const frame of page.frames()) {
                    if (frame.url().includes('challenges.cloudflare.com')) {
                        try {
                            const frameElement = await frame.frameElement();
                            if (frameElement) {
                                const box = await frameElement.boundingBox();
                                if (box && box.width > 0 && box.height > 0) {
                                    console.log(`Clicking Turnstile iframe at x=${box.x + box.width / 2}, y=${box.y + box.height / 2}`);
                                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                                    await sleep(3000);
                                }
                            }
                        } catch (e) {
                            console.log(`Turnstile frame click error: ${e.message}`);
                        }
                    }
                }
            }
            await sleep(2000);
        }
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 5000 });

        // Default behavior is Sign In. Enable Sign Up explicitly when needed.
        const enableSignUpFlow = process.env.CODEX_ENABLE_SIGNUP_FLOW === '1' || ACCOUNT.forceSignUp === true;
        if (enableSignUpFlow) {
            console.log('CODEX_ENABLE_SIGNUP_FLOW=1: checking for Sign Up/Create account controls...');
            const signUpClicked = await page.evaluate(() => {
                const looksVisible = (el) => {
                    const style = window.getComputedStyle(el);
                    return style && style.display !== 'none' && style.visibility !== 'hidden';
                };
                const nodes = Array.from(document.querySelectorAll('a,button,[role="button"]'));

                const pick = (predicate) => {
                    for (const node of nodes) {
                        if (!node || !looksVisible(node)) continue;
                        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
                        const href = String(node.getAttribute && node.getAttribute('href') || '');
                        if (!predicate(text, href)) continue;
                        node.click();
                        return text || href || 'clicked';
                    }
                    return '';
                };

                // 1) Prefer explicit email signup controls
                let hit = pick((text, href) => /sign up with email|continue with email|use email|email/i.test(text) || /email/i.test(href));
                if (hit) return hit;

                // 2) Fallback to generic signup/create-account, but never Google buttons
                hit = pick((text, href) => {
                    if (/google/i.test(text) || /google/i.test(href)) return false;
                    return /sign up|create account|register/i.test(text) || /signup|register|create-account/i.test(href);
                });
                return hit;
            });

            if (signUpClicked) {
                console.log(`Sign Up/Create account clicked: ${signUpClicked}`);
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 2500));
                await takeScreenshot(page, '01b-after-signup');
            }
        } else {
            console.log('Sign In mode: skipping Sign Up link click');
        }

        // Enter email
        console.log('Entering email...');
        const emailInput = await page.$('input[type="email"], input[name="email"]');
        if (emailInput) {
            await emailInput.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await emailInput.click();
            for (const char of ACCOUNT.email) {
                await page.keyboard.type(char, { delay: Math.random() * 50 + 50 });
            }
        }
        await new Promise(r => setTimeout(r, 1000));
        await takeScreenshot(page, '02-email-entered');

        // Click Continue and wait for navigation
        console.log('Clicking Continue...');
        const continueBtn = await page.$('button[type="submit"]') ||
                           await firstXPath(page, '//button[contains(text(), "Continue")]');
        if (continueBtn) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
                continueBtn.click().catch(() => {})
            ]);
        }
        await new Promise(r => setTimeout(r, 2000));
        await takeScreenshot(page, '03-after-email');
        console.log(`After email - URL: ${page.url()}`);

        const immediateRouteError = await detectKnownRouteError(page);
        if (immediateRouteError) {
            console.log(`Known route error detected after email step: ${immediateRouteError}`);
            await takeScreenshot(page, '03b-route-error');
            const recovered = await tryRecoverFromRouteError(page, 2);
            if (!recovered) {
                return { success: false, reason: immediateRouteError };
            }
        }

        // Wait for password input (or quickly fail on known route error page)
        console.log('Waiting for password input...');
        let passwordStep = await waitForPasswordOrKnownError(page, 25000);

        let pageUrl = page.url();
        if (passwordStep.state === 'error') {
            console.log(`Known route error before password input: ${passwordStep.reason}`);
            await takeScreenshot(page, '03b-route-error');
            const recovered = await tryRecoverFromRouteError(page, 2);
            if (!recovered) {
                return { success: false, reason: passwordStep.reason };
            }
            // Re-check password after route-error recovery.
            passwordStep = await waitForPasswordOrKnownError(page, 10000);
            if (passwordStep.state === 'error') {
                return { success: false, reason: passwordStep.reason };
            }
        }

        if (passwordStep.state === 'password') {
            console.log('Password input found');

            // Enter password
            console.log('Entering password...');
            const passwordInput = passwordStep.input;
            if (passwordInput) {
                await passwordInput.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await passwordInput.click();
                for (const char of ACCOUNT.password) {
                    await page.keyboard.type(char, { delay: Math.random() * 50 + 50 });
                }
            }
            await new Promise(r => setTimeout(r, 1000));
            await takeScreenshot(page, '04-password-entered');

            // Submit password
            console.log('Submitting password...');
            await new Promise(r => setTimeout(r, 500));
            
            const submitBtn = await page.$('button[type="submit"]') ||
                             await firstXPath(page, '//button[contains(text(), "Continue") or contains(text(), "Next")]');
            if (submitBtn) {
                console.log('Found submit button, clicking...');
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
                    submitBtn.click().catch(() => {})
                ]);
            } else {
                console.log('Submit button not found, trying Enter key...');
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 3000));
            }
            await new Promise(r => setTimeout(r, 5000));
            await takeScreenshot(page, '05-after-password');

            pageUrl = page.url();
            console.log(`After password - URL: ${pageUrl}`);

            // Retry if still on password page
            if (pageUrl.includes('log-in/password')) {
                console.log('Still on password page, retrying submit...');
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 5000));
                await takeScreenshot(page, '05b-retry');
                pageUrl = page.url();
                console.log(`After retry - URL: ${pageUrl}`);
            }
        } else {
            const knownAfterTimeout = await detectKnownRouteError(page);
            if (knownAfterTimeout) {
                console.log(`Known route error on password timeout: ${knownAfterTimeout}`);
                await takeScreenshot(page, '03b-route-error');
                return { success: false, reason: knownAfterTimeout };
            }

            if (pageUrl.includes('email-verification')) {
                console.log('Password step skipped, email verification screen is already open.');
            } else {
                await takeScreenshot(page, '03c-password-missing');
                return { success: false, reason: `password_input_missing_after_email:${pageUrl}` };
            }
        }

        // Check if this is Sign Up flow (email verification) vs Sign In flow (MFA)
        const isSignUpFlow = pageUrl.includes('email-verification') ||
                             pageUrl.includes('create-account') ||
                             pageUrl.includes('about-you') ||
                             pageUrl.includes('add-phone');
        
        // Step 3: Get verification code
        if (isSignUpFlow) {
            const signUpPageContent = await page.content();
            const accountAlreadyExists = /already exists/i.test(signUpPageContent);
            if (accountAlreadyExists) {
                console.log('Account already exists on Sign Up page - switching to Sign In flow...');
                pageUrl = await switchToSignInFlow(page, ACCOUNT, effectiveAuthUrl);
            } else {
            // Sign Up flow - get code from email via IMAP
            console.log('Sign Up flow detected - waiting for email verification code...');
            const emailCode = await getVerificationCodeFromIMAP(ACCOUNT.email, ACCOUNT.password);
            
            if (emailCode) {
                console.log(`Email verification code: ${emailCode}`);
                console.log('Entering email verification code...');
                
                const codeInput = await page.$('input[type="text"][maxlength="6"], input[placeholder*="code" i], input[name="code"]');
                if (codeInput) {
                    await codeInput.click({ clickCount: 3 });
                    await page.keyboard.press('Backspace');
                    await codeInput.click();
                    for (const char of emailCode) {
                        await page.keyboard.type(char, { delay: 100 });
                    }
                }
                
                // Submit code
                const codeSubmitBtn = await page.$('button[type="submit"]') ||
                                     await firstXPath(page, '//button[contains(text(), "Continue") or contains(text(), "Verify")]');
                if (codeSubmitBtn) {
                    await codeSubmitBtn.click();
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                } else {
                    // Try Enter key
                    await page.keyboard.press('Enter');
                }

                await new Promise(r => setTimeout(r, 5000));
                await takeScreenshot(page, '06-email-verified');
                console.log('Email verified');
                
                // Check if we're still on create-account page (account exists)
                const currentPageUrl = page.url();
                if (currentPageUrl.includes('create-account') || currentPageUrl.includes('email-verification')) {
                    console.log('Still on verification page - trying to continue...');
                    
                    // Try clicking Continue button
                    const continueBtn = await page.$('button[type="submit"]') ||
                                       await firstXPath(page, '//button[contains(text(), "Continue")]');
                    if (continueBtn) {
                        await continueBtn.click();
                        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                        await takeScreenshot(page, '06b-continue-clicked');
                    }
                    
                    // If still on same page, try going to /login
                    const afterUrl = page.url();
                    if (afterUrl.includes('create-account') || afterUrl.includes('email-verification')) {
                        pageUrl = await switchToSignInFlow(page, ACCOUNT, effectiveAuthUrl);
                    }
                }
            } else {
                console.log('Failed to get email verification code');
            }
            }
        } else {
            const totpInput = await page.$('input[type="text"][maxlength="6"], input[placeholder*="code" i], input[name="code"]');
            if (totpInput) {
                const isVisible = await totpInput.evaluate(el => {
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden';
                });
                if (isVisible) {
                    if (!ACCOUNT.totpSecret) {
                        console.log('2FA challenge detected, but account has no totpSecret');
                        await takeScreenshot(page, '06-2fa-secret-missing');
                        return { success: false, reason: '2FA challenge detected but totpSecret is missing' };
                    }

                    // Sign In flow - use TOTP 2FA
                    console.log('Getting fresh 2FA code...');
                    const totpCode = getTOTPCode(ACCOUNT.totpSecret);
                    console.log(`2FA Code: ${totpCode}`);

                    console.log('Entering 2FA code...');
                    await totpInput.click({ clickCount: 3 });
                    await page.keyboard.press('Backspace');
                    await totpInput.click();
                    for (const char of totpCode) {
                        await page.keyboard.type(char, { delay: Math.random() * 50 + 50 });
                    }
                }
            }
            await new Promise(r => setTimeout(r, 1000));
            await takeScreenshot(page, '06-2fa-entered');

            // Submit 2FA
            console.log('Submitting 2FA...');
            const totpBtn = await page.$('button[type="submit"]') ||
                           await firstXPath(page, '//button[contains(text(), "Continue") or contains(text(), "Verify") or contains(text(), "Confirm")]');
            if (totpBtn) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
                    totpBtn.click().catch(() => {})
                ]);
            } else {
                await page.keyboard.press('Enter');
            }
            await new Promise(r => setTimeout(r, 8000));
            await takeScreenshot(page, '07-after-2fa');
        }

        // Some sign-in paths also require email verification code.
        pageUrl = page.url();
        if (pageUrl.includes('email-verification')) {
            console.log('Email verification page detected after sign-in. Getting code from IMAP...');
            const signInEmailCode = await getVerificationCodeFromIMAP(ACCOUNT.email, ACCOUNT.password, 90, true);
            if (signInEmailCode) {
                console.log(`Email verification code: ${signInEmailCode}`);
                const verifyCodeInput = await page.$('input[type="text"][maxlength="6"], input[placeholder*="code" i], input[name="code"]');
                if (verifyCodeInput) {
                    await verifyCodeInput.click({ clickCount: 3 }).catch(() => {});
                    await page.keyboard.press('Backspace').catch(() => {});
                    await verifyCodeInput.click().catch(() => {});
                    for (const char of signInEmailCode) {
                        await page.keyboard.type(char, { delay: 90 });
                    }
                }
                const verifySubmitBtn = await page.$('button[type="submit"]') ||
                                        await firstXPath(page, '//button[contains(text(), "Continue") or contains(text(), "Verify")]');
                if (verifySubmitBtn) {
                    await verifySubmitBtn.click();
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                } else {
                    await page.keyboard.press('Enter').catch(() => {});
                }
                await new Promise(r => setTimeout(r, 3000));
                await takeScreenshot(page, '07b-email-verified-post-signin');
            } else {
                console.log('Failed to get email verification code for post-signin verification');
            }
        }

        // If create_account returned user_already_exists, switch to Sign In immediately
        if (createAccountUserExists) {
            console.log('[SIGNUP-DETECT] create_account returned user_already_exists – switching to Sign In flow...');
            try {
                pageUrl = await switchToSignInFlow(page, ACCOUNT, effectiveAuthUrl);
            } catch (switchErr) {
                console.log(`[SIGNUP-DETECT] switchToSignInFlow error: ${switchErr.message}`);
            }
            // Re-check current URL after switch
            newPageUrl = page.url();
            console.log(`After switch to Sign In: ${newPageUrl}`);
            // If we're now on a page that requires password, try entering it
            const pwdInput = await page.$('input[type="password"]');
            if (pwdInput) {
                console.log('[SIGNUP-DETECT] Password field found after switch – entering password...');
                await pwdInput.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await pwdInput.click();
                await page.keyboard.type(ACCOUNT.password, { delay: 40 });
                const submitBtn = await page.$('button[type="submit"]');
                if (submitBtn) {
                    await submitBtn.click();
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                }
                await sleep(5000);
                newPageUrl = page.url();
            }
        }

        // Step 4: Handle consent page OR about-you page (Sign Up flow)
        console.log('Checking for consent/about-you screen...');
        let newPageUrl = page.url();
        console.log(`Current URL: ${newPageUrl}`);

        // Check if we're on the about-you page (Sign Up flow)
        const isAboutYouPage = newPageUrl.includes('about-you');
        if (isAboutYouPage) {
            console.log('About-you page detected - entering age/name and DOB...');
            const fullName = buildValidFullName(ACCOUNT.name, ACCOUNT.email);
            console.log(`Using full name: ${fullName}`);
            
            // Enter age/birthday (varies by locale and experiment bucket)
            const birthYear = ACCOUNT.birthYear || 2000;
            const birthMonth = String(ACCOUNT.birthMonth || 1).padStart(2, '0');
            const birthDay = String(ACCOUNT.birthDay || 15).padStart(2, '0');
            const dobDisplay = `${birthMonth}/${birthDay}/${birthYear}`;
            const dobISO = `${birthYear}-${birthMonth}-${birthDay}`;
            const ageValue = String(Math.max(22, Number(ACCOUNT.age || 22)));

            const aboutYouText = await page.content();
            const isAgePrompt = /how old are you\?/i.test(aboutYouText) ||
                                /placeholder="[^"]*age/i.test(aboutYouText) ||
                                />\s*Age\s*</i.test(aboutYouText);

            console.log(`Entering age/birthday: mode=${isAgePrompt ? 'age' : 'birthday'}, age=${ageValue}, dob=${dobDisplay}`);

            // Name first (as required by target form ordering)
            const nameInput = await page.$('input[name*="name"], input[placeholder*="name" i], input[aria-label*="name" i]');
            if (nameInput) {
                console.log('Entering name first...');
                await nameInput.click({ clickCount: 3 }).catch(() => {});
                await page.keyboard.press('Backspace').catch(() => {});
                await nameInput.click().catch(() => {});
                await page.keyboard.type(fullName, { delay: 50 }).catch(() => {});
            }

            let ageDobValue = '';
            let usedSpinbuttonDateField = false;

            // Debug form structure + strict 2-field mode (name + age)
            const formSnapshot = await page.evaluate(() => {
                const vis = (el) => {
                    const st = window.getComputedStyle(el);
                    return st.display !== 'none' && st.visibility !== 'hidden';
                };
                const fields = Array.from(document.querySelectorAll('input, textarea, select'))
                    .filter(vis)
                    .map((el, idx) => ({
                        idx,
                        tag: el.tagName.toLowerCase(),
                        type: (el.type || '').toLowerCase(),
                        name: el.name || '',
                        id: el.id || '',
                        placeholder: el.placeholder || '',
                        aria: el.getAttribute('aria-label') || ''
                    }));
                return fields;
            }).catch(() => []);
            console.log('About-you visible fields:', JSON.stringify(formSnapshot));

            const visibleTextInputs = formSnapshot.filter((f) => f.tag === 'input' && !['hidden','checkbox','radio','submit','button'].includes(f.type));
            const hasNameField = visibleTextInputs.some((f) => /name/i.test(`${f.name} ${f.id} ${f.placeholder} ${f.aria}`));
            const hasAgeField = visibleTextInputs.some((f) => /age/i.test(`${f.name} ${f.id} ${f.placeholder} ${f.aria}`));

            // Priority 1: if the form has name + age fields, fill those and submit immediately.
            // OpenAI has moved to name + age (number 21-80) instead of name + birthday.
            if (hasNameField && hasAgeField) {
                console.log('About-you detected name + age fields – filling and submitting immediately');
                const nameHandle = await page.$('input[name*="name" i], input[id*="name" i], input[placeholder*="name" i], input[aria-label*="name" i]');
                if (nameHandle) {
                    await fillInputValue(page, nameHandle, fullName).catch(() => {});
                }
                const ageHandle = await page.$('input[name*="age" i], input[id*="age" i], input[placeholder*="age" i], input[aria-label*="age" i]');
                if (ageHandle) {
                    await fillInputValue(page, ageHandle, ageValue).catch(() => {});
                    ageDobValue = await ageHandle.evaluate(el => el.value || '').catch(() => ageValue);
                }
                await sleep(800);
                await takeScreenshot(page, '08-about-you-name-age');

                // Submit immediately – don't try birthday/spinbutton when age field exists
                const submitBtn = await page.$('button[type="submit"]') ||
                                  await firstXPath(page, '//button[contains(text(), "Continue") or contains(text(), "Finish") or contains(text(), "Next")]');
                if (submitBtn) {
                    console.log('Submitting name + age...');
                    await submitBtn.click();
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                }
                await sleep(3000);
                await takeScreenshot(page, '08b-about-you-name-age-submitted');

                // If still on about-you, check for errors and retry once
                if (page.url().includes('about-you')) {
                    console.log('Still on about-you after name+age submit – checking for error...');
                    const retryErrText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
                    if (/doesn'?t look right|try again|invalid|must be/i.test(retryErrText)) {
                        console.log('Validation error detected – retrying with fallback values...');
                        const retryName = await page.$('input[name*="name" i], input[id*="name" i], input[placeholder*="name" i], input[aria-label*="name" i]');
                        if (retryName) {
                            await fillInputValue(page, retryName, 'Alex Stone').catch(() => {});
                        }
                        const retryAge = await page.$('input[name*="age" i], input[id*="age" i], input[placeholder*="age" i], input[aria-label*="age" i]');
                        if (retryAge) {
                            await fillInputValue(page, retryAge, '30').catch(() => {});
                        }
                        await sleep(600);
                        const retrySubmitBtn = await page.$('button[type="submit"]') ||
                                              await firstXPath(page, '//button[contains(text(), "Continue") or contains(text(), "Finish") or contains(text(), "Next")]');
                        if (retrySubmitBtn) {
                            await retrySubmitBtn.click();
                            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                        }
                        await sleep(3000);
                    }
                }

                // Age field was handled – skip birthday logic
                usedSpinbuttonDateField = true;
                const hiddenBirthdayInput = await page.$('input[name="birthday"]');
                if (hiddenBirthdayInput) {
                    ageDobValue = await hiddenBirthdayInput.evaluate(el => el.value || '').catch(() => ageDobValue);
                }
            } else {
            // Fallthrough: no age field – try birthday spinbuttons or date input
            const monthSegment = await page.$('div[role="spinbutton"][data-type="month"]');
            const daySegment = await page.$('div[role="spinbutton"][data-type="day"]');
            const yearSegment = await page.$('div[role="spinbutton"][data-type="year"]');

            if (monthSegment && daySegment && yearSegment) {
                console.log('Filling birthday via spinbutton segments...');
                const fillSegment = async (handle, value) => {
                    await handle.click({ clickCount: 3 }).catch(() => {});
                    await page.keyboard.press('Backspace').catch(() => {});
                    await handle.click().catch(() => {});
                    await page.keyboard.type(value, { delay: 40 });
                };

                await fillSegment(monthSegment, String(Number(birthMonth)));
                await fillSegment(daySegment, String(Number(birthDay)));
                await fillSegment(yearSegment, String(birthYear));

                const hiddenAfterSegment = await page.$('input[name="birthday"]');
                if (hiddenAfterSegment) {
                    ageDobValue = await hiddenAfterSegment.evaluate(el => el.value || '');
                }
                usedSpinbuttonDateField = true;
            }

            if (!usedSpinbuttonDateField) {
                const allInputs = await page.$$('input');
                let ageDobInput = null;
                if (allInputs.length >= 2) {
                    ageDobInput = allInputs[1];
                } else {
                    ageDobInput = await page.$(
                        'input[name*="birth" i], input[id*="birth" i], input[placeholder*="birth" i], input[aria-label*="birth" i], input[placeholder*="age" i], input[aria-label*="age" i], input[autocomplete="bday"], input[type="date"]'
                    );
                }

                if (ageDobInput) {
                    await ageDobInput.click({ clickCount: 3 }).catch(() => {});
                    await page.keyboard.press('Backspace').catch(() => {});
                    await ageDobInput.click().catch(() => {});
                    if (isAgePrompt) {
                        await page.keyboard.type(ageValue, { delay: 50 });
                    } else {
                        await page.keyboard.type(dobDisplay, { delay: 50 });
                    }
                    ageDobValue = await ageDobInput.evaluate(el => el.value || '');
                }
            }
            console.log(`Age/Birthday field value after typing: ${ageDobValue}`);


            // Fallback: try forcing hidden birthday value if spinbutton/input typing did not update it.
            const hiddenBirthdayInput = await page.$('input[name="birthday"]');
            if (hiddenBirthdayInput && !usedSpinbuttonDateField) {
                await hiddenBirthdayInput.evaluate((el, iso) => {
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                    if (setter) {
                        setter.call(el, iso);
                    } else {
                        el.value = iso;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }, dobISO);
                const hiddenBirthdayValue = await hiddenBirthdayInput.evaluate(el => el.value || '');
                console.log(`Hidden birthday value set to: ${hiddenBirthdayValue}`);
            }
            
            await new Promise(r => setTimeout(r, 1000));
            await takeScreenshot(page, '08-about-you-filled');
            
            // Submit
            const finishBtn = await page.$('button[type="submit"]') ||
                             await firstXPath(page, '//button[contains(text(), "Finish")]');
            if (finishBtn) {
                console.log('Submitting name/DOB...');
                await finishBtn.click();
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }
            
            await new Promise(r => setTimeout(r, 5000));
            await takeScreenshot(page, '08b-about-you-submitted');

            // Retry once if we're still on about-you (usually invalid DOB format/value).
            if (page.url().includes('about-you')) {
                console.log('Still on about-you page, retrying age/birthday submission...');
                const aboutYouRetryText = await page.content();
                const nameLooksInvalid = /doesn'?t look right|try again|invalid name/i.test(aboutYouRetryText);
                if (nameLooksInvalid) {
                    const retryNameInput = await page.$('input[name*="name"], input[placeholder*="name" i], input[aria-label*="name" i]');
                    if (retryNameInput) {
                        const fallbackFullName = 'Alex Stone';
                        console.log(`Name validation warning detected. Retrying with fallback name: ${fallbackFullName}`);
                        await retryNameInput.click({ clickCount: 3 }).catch(() => {});
                        await page.keyboard.press('Backspace').catch(() => {});
                        await retryNameInput.click().catch(() => {});
                        await page.keyboard.type(fallbackFullName, { delay: 40 }).catch(() => {});
                    }
                }
                const retryDobInput = await page.$(
                    'input[name*="birth" i], input[id*="birth" i], input[placeholder*="birth" i], input[aria-label*="birth" i], input[placeholder*="age" i], input[aria-label*="age" i], input[autocomplete="bday"], input[type="date"]'
                );
                const retryMonth = await page.$('div[role="spinbutton"][data-type="month"]');
                const retryDay = await page.$('div[role="spinbutton"][data-type="day"]');
                const retryYear = await page.$('div[role="spinbutton"][data-type="year"]');
                if (retryMonth && retryDay && retryYear) {
                    const fillRetrySegment = async (handle, value) => {
                        await handle.click({ clickCount: 3 }).catch(() => {});
                        await page.keyboard.press('Backspace').catch(() => {});
                        await handle.click().catch(() => {});
                        await page.keyboard.type(value, { delay: 35 });
                    };
                    await fillRetrySegment(retryMonth, String(Number(birthMonth)));
                    await fillRetrySegment(retryDay, String(Number(birthDay)));
                    await fillRetrySegment(retryYear, String(birthYear));
                } else if (retryDobInput) {
                    await retryDobInput.click({ clickCount: 3 }).catch(() => {});
                    await page.keyboard.press('Backspace').catch(() => {});
                    await retryDobInput.click().catch(() => {});
                    if (isAgePrompt) {
                        await page.keyboard.type(ageValue, { delay: 40 });
                    } else {
                        await page.keyboard.type(dobDisplay, { delay: 40 });
                    }
                }
                const retryHiddenBirthdayInput = await page.$('input[name="birthday"]');
                if (retryHiddenBirthdayInput) {
                    await retryHiddenBirthdayInput.evaluate((el, iso) => {
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                        if (setter) {
                            setter.call(el, iso);
                        } else {
                            el.value = iso;
                        }
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }, dobISO);
                }
                const retryFinishBtn = await page.$('button[type="submit"]') ||
                                      await firstXPath(page, '//button[contains(text(), "Finish")]');
                if (retryFinishBtn) {
                    await retryFinishBtn.click();
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                }
                await new Promise(r => setTimeout(r, 5000));
                await takeScreenshot(page, '08c-about-you-retry');
            }
            } // end of else (birthday fallthrough)
            
            newPageUrl = page.url();
            console.log(`After about-you - URL: ${newPageUrl}`);
        }

            if (newPageUrl.includes('add-phone')) {
            console.log('Phone number required by OpenAI. Attempting Hero-SMS activation flow...');
            const phoneResult = await completePhoneVerificationWithHeroSMS(page);


            if (!phoneResult.success) {
                return { success: false, reason: phoneResult.reason || 'phone_required' };
            }
            newPageUrl = page.url();
            console.log(`After phone verification - URL: ${newPageUrl}`);
        }

        // If phone verification led to about-you, complete it now.
        if (newPageUrl.includes('about-you')) {
            console.log('About-you page detected after phone verification. Completing profile...');

            const rawName = (ACCOUNT.name && String(ACCOUNT.name).trim()) ? String(ACCOUNT.name).trim() : 'Alex Stone';
            // OpenAI about-you often rejects names with digits/symbols; keep only letters/spaces.
            const cleanedName = rawName
                .replace(/[^a-zA-Z\s-]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const fullName = /^[A-Za-z]+(?:[\s-][A-Za-z]+)+$/.test(cleanedName) ? cleanedName : 'Alex Stone';

            // Force adult age > 21 for this flow
            const birthYear = Number(ACCOUNT.birthYear || 1996);
            const birthMonth = Number(ACCOUNT.birthMonth || 1);
            const birthDay = Number(ACCOUNT.birthDay || 15);
            const ageValue = String(Math.max(22, Math.min(65, new Date().getFullYear() - birthYear)));
            const dobISO = `${birthYear}-${String(birthMonth).padStart(2, '0')}-${String(birthDay).padStart(2, '0')}`;
            const dobDisplay = `${String(birthMonth).padStart(2, '0')}/${String(birthDay).padStart(2, '0')}/${birthYear}`;

            const aboutFields = await page.evaluate(() => {
                const vis = (el) => {
                    const st = window.getComputedStyle(el);
                    return st.display !== 'none' && st.visibility !== 'hidden';
                };
                return Array.from(document.querySelectorAll('input, textarea, select'))
                    .filter(vis)
                    .map((el, idx) => ({
                        idx,
                        tag: el.tagName.toLowerCase(),
                        type: (el.type || '').toLowerCase(),
                        name: el.name || '',
                        id: el.id || '',
                        placeholder: el.placeholder || '',
                        aria: el.getAttribute('aria-label') || ''
                    }));
            }).catch(() => []);
            console.log('About-you post-phone visible fields:', JSON.stringify(aboutFields));

            const nameInput = await page.$('input[name*="name" i], input[id*="name" i], input[placeholder*="name" i], input[aria-label*="name" i]');
            if (nameInput) {
                console.log('Post-phone about-you: entering NAME first');
                await fillInputValue(page, nameInput, fullName);
            }

            const ageInput = await page.$('input[name*="age" i], input[id*="age" i], input[placeholder*="age" i], input[aria-label*="age" i]');
            if (ageInput) {
                console.log('Post-phone about-you: entering AGE second');
                await fillInputValue(page, ageInput, ageValue);
            } else {
                const ageDobInput = await page.$('input[name*="birth" i], input[id*="birth" i], input[placeholder*="birth" i], input[aria-label*="birth" i], input[autocomplete="bday"], input[type="date"]');
                if (ageDobInput) {
                    console.log('Post-phone about-you: birthday-style field detected');
                    await fillInputValue(page, ageDobInput, dobDisplay);
                }
            }

            // Only set hidden birthday if we didn't use the age field (OpenAI now uses name+age, not name+birthday)
            if (!ageInput) {
                const hiddenBirthdayInput = await page.$('input[name="birthday"]');
                if (hiddenBirthdayInput) {
                    await hiddenBirthdayInput.evaluate((el, iso) => {
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                        if (setter) {
                            setter.call(el, iso);
                        } else {
                            el.value = iso;
                        }
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }, dobISO).catch(() => {});
                }
            }

            await sleep(1000);
            await takeScreenshot(page, '08-about-you-after-phone-filled');

            const finishBtn = await page.$('button[type="submit"]') ||
                              await firstXPath(page, '//button[contains(text(), "Finish") or contains(text(), "Continue") or contains(text(), "Next")]');
            if (finishBtn) {
                await finishBtn.click().catch(() => {});
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            } else {
                await page.keyboard.press('Enter').catch(() => {});
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
            }

            await sleep(3000);
            await takeScreenshot(page, '08b-about-you-after-phone-submitted');

            // If create_account returned user_already_exists, switch to login immediately
            if (createAccountUserExists) {
                console.log('[SIGNUP-DETECT] user_already_exists detected on about-you post-phone after submit – switching to Sign In');
                try {
                    pageUrl = await switchToSignInFlow(page, ACCOUNT, effectiveAuthUrl);
                } catch (switchErr) {
                    console.log(`[SIGNUP-DETECT] switchToSignInFlow error: ${switchErr.message}`);
                }
                newPageUrl = page.url();
                console.log(`After switch to Sign In: ${newPageUrl}`);
                // Try password entry
                const pwdField = await page.$('input[type="password"]');
                if (pwdField) {
                    console.log('[SIGNUP-DETECT] Password field found – entering password...');
                    await pwdField.click({ clickCount: 3 }).catch(() => {});
                    await page.keyboard.press('Backspace').catch(() => {});
                    await pwdField.click().catch(() => {});
                    await page.keyboard.type(ACCOUNT.password, { delay: 40 }).catch(() => {});
                    const submitBtn = await page.$('button[type="submit"]');
                    if (submitBtn) {
                        await submitBtn.click().catch(() => {});
                        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                    }
                    await sleep(5000);
                }
            } else if (page.url().includes('about-you')) {
                console.log('Still on about-you (post-phone), retrying submission with fallback fields...');

                // Generic autofill pass for any visible form controls
                await page.evaluate((name, month, day, year) => {
                    const isVisible = (el) => {
                        const st = window.getComputedStyle(el);
                        return st.display !== 'none' && st.visibility !== 'hidden';
                    };
                    const all = Array.from(document.querySelectorAll('input, textarea, select'));
                    for (const el of all) {
                        if (!el || !isVisible(el) || el.disabled) continue;
                        const meta = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
                        if (el.type === 'checkbox') {
                            el.checked = true;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            continue;
                        }
                        if (meta.includes('name')) {
                            el.value = name;
                        } else if (meta.includes('birth') || meta.includes('dob') || meta.includes('date')) {
                            if (el.type === 'date') {
                                el.value = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                            } else {
                                el.value = `${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}/${year}`;
                            }
                        } else if (meta.includes('age')) {
                            const age = Math.max(18, Math.min(65, new Date().getFullYear() - year));
                            el.value = String(age);
                        }
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, fullName || 'Alex Stone', Number(birthMonth), Number(birthDay), Number(birthYear)).catch(() => {});

                const retryMonth = await page.$('div[role="spinbutton"][data-type="month"]');
                const retryDay = await page.$('div[role="spinbutton"][data-type="day"]');
                const retryYear = await page.$('div[role="spinbutton"][data-type="year"]');
                if (retryMonth && retryDay && retryYear) {
                    const fillRetrySegment = async (handle, value) => {
                        await handle.click({ clickCount: 3 }).catch(() => {});
                        await page.keyboard.press('Backspace').catch(() => {});
                        await handle.click().catch(() => {});
                        await page.keyboard.type(value, { delay: 30 }).catch(() => {});
                    };
                    await fillRetrySegment(retryMonth, String(Number(birthMonth)));
                    await fillRetrySegment(retryDay, String(Number(birthDay)));
                    await fillRetrySegment(retryYear, String(birthYear));
                }

                // Try multiple submit button patterns
                let retryFinishBtn = await page.$('button[type="submit"]');
                if (!retryFinishBtn) retryFinishBtn = await firstXPath(page, '//button[contains(text(), "Finish") or contains(text(), "Continue") or contains(text(), "Next") or contains(text(), "Done") or contains(text(), "Start")]');
                if (!retryFinishBtn) retryFinishBtn = await firstXPath(page, '//a[contains(text(), "Continue") or contains(text(), "Next")]');

                if (retryFinishBtn) {
                    await retryFinishBtn.click().catch(() => {});
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                } else {
                    await page.keyboard.press('Enter').catch(() => {});
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                }

                await sleep(2500);
                await takeScreenshot(page, '08c-about-you-after-phone-retry');
            }

            newPageUrl = page.url();
            console.log(`After about-you (post-phone) - URL: ${newPageUrl}`);
        }

        // Check if we're on the consent page
        const isConsentPage = newPageUrl.includes('consent');
        if (isConsentPage) {
            console.log('Consent page detected - accepting...');
            await new Promise(r => setTimeout(r, 3000));
            
            const consentBtn = await page.$('button[type="submit"]') ||
                              await firstXPath(page, '//button[contains(text(), "Continue") or contains(text(), "Allow") or contains(text(), "Accept")]');
            if (consentBtn) {
                console.log('Clicking consent button...');
                // Click and immediately start monitoring
                await consentBtn.click();
            }
            
            // Wait and monitor for redirect - check frequently
            console.log('Waiting for redirect to localhost...');
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 500));
                
                // Check if we captured the callback URL
                if (callbackUrl) {
                    console.log(`[SUCCESS] Callback URL captured: ${callbackUrl}`);
                    break;
                }
                
                // Also check current page URL
                const currentUrl = page.url();
                if (isCodexCallbackUrl(currentUrl)) {
                    callbackUrl = currentUrl;
                    console.log(`[SUCCESS] Callback URL from page: ${currentUrl}`);
                    break;
                } else if (currentUrl.includes('localhost:1455')) {
                    localRedirectUrl = currentUrl;
                }
                
                // Log progress
                if (i % 10 === 0 && i > 0) {
                    console.log(`  [${i}/30] Waiting... Last URL: ${lastUrl}`);
                }
            }
            
            await takeScreenshot(page, '08-consent-given');
            newPageUrl = page.url();
            console.log(`After consent - URL: ${newPageUrl}`);
        }

        // Some flows now require explicit org/project confirmation page before callback redirect.
        if (newPageUrl.includes('/organization')) {
            console.log('Organization selection page detected - clicking Continue...');
            const clickedOrgContinue = await page.evaluate(() => {
                const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
                const btn = nodes.find((el) => /continue/i.test((el.textContent || '').trim()));
                if (!btn) return false;
                btn.click();
                return true;
            });
            if (!clickedOrgContinue) {
                await page.keyboard.press('Enter').catch(() => {});
            }

            console.log('Waiting for redirect after organization step...');
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (callbackUrl) {
                    console.log(`[SUCCESS] Callback URL captured after organization step: ${callbackUrl}`);
                    break;
                }
                const currentUrl = page.url();
                if (isCodexCallbackUrl(currentUrl)) {
                    callbackUrl = currentUrl;
                    console.log(`[SUCCESS] Callback URL from page after organization step: ${currentUrl}`);
                    break;
                } else if (currentUrl.includes('localhost:1455')) {
                    localRedirectUrl = currentUrl;
                }
            }
            await takeScreenshot(page, '08e-organization-continued');
            newPageUrl = page.url();
            console.log(`After organization step - URL: ${newPageUrl}`);
        }

        // Wait for final redirect
        console.log('Waiting for final redirect...');
        await new Promise(r => setTimeout(r, 5000));
        
        const finalUrl = page.url();
        console.log(`Final URL: ${finalUrl}`);
        await takeScreenshot(page, '09-final');

        // Get the callback URL
        let resultUrl = null;
        if (callbackUrl) {
            resultUrl = callbackUrl;
        } else if (isCodexCallbackUrl(finalUrl)) {
            resultUrl = finalUrl;
        }

        // Clean up callback URL - remove any trailing text artifacts
        if (resultUrl) {
            resultUrl = resultUrl.replace(/Waiting.*$/, '').replace(/\s+$/, '');
        }

        console.log('');
        console.log('========================================');
        console.log('AUTHENTICATION COMPLETE');
        console.log('========================================');
        console.log(`Callback URL: ${resultUrl || '(not captured)'}`);
        if (!resultUrl && localRedirectUrl) {
            console.log(`Local redirect without code: ${localRedirectUrl}`);
        }
        console.log('');

        if (resultUrl) {
            // Output the callback URL for the shell script to capture
            console.log(`CALLBACK:${resultUrl}`);
            return { success: true, url: resultUrl };
        }

        if (passwordVerifyRejected) {
            return { success: false, reason: 'password_verify_401' };
        }

        return { success: false, reason: 'No callback URL with auth code captured' };
    } catch (error) {
        throw error;
    } finally {
        await cleanupActiveResources();
    }
}

// Main execution
async function main() {
    const authUrl = process.argv[2];
    if (!authUrl) {
        console.error('Usage: node codex-login.js <auth-url>');
        process.exit(1);
    }

    console.log('Starting automated login...');
    const result = await performLogin(authUrl);
    if (!result || !result.success) {
        const reason = (result && result.reason) ? result.reason : 'unknown_error';
        console.log(`RESULT_REASON:${reason}`);
        process.exit(2);
    }
    console.log('RESULT_REASON:success');
}

main().catch(err => {
    console.error('Error:', err.message);
    console.error(err.stack);
    const normalized = String(err && err.message ? err.message : 'unknown_error')
        .replace(/\s+/g, '_')
        .slice(0, 180);
    console.log(`RESULT_REASON:exception:${normalized}`);
    process.exit(1);
});
