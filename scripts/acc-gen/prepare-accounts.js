#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function usage() {
    console.log('Usage: node prepare-accounts.js --input <file> --output <file> [--names-file <file>]');
}

function sanitizeNameFromEmail(email) {
    const local = String(email || '').split('@')[0] || 'user';
    const value = local.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    return value || 'user';
}

function toTitleCase(word) {
    const clean = String(word || '').trim().toLowerCase();
    if (!clean) return '';
    return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function normalizeNameCandidate(name) {
    const tokens = String(name || '')
        .replace(/[^a-zA-Z\s'-]/g, ' ')
        .split(/\s+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 2)
        .map(toTitleCase);

    if (tokens.length >= 2) return `${tokens[0]} ${tokens[1]}`;
    if (tokens.length === 1) return `${tokens[0]} Stone`;
    return '';
}

function loadNamesPool(namesPath) {
    if (!namesPath) return [];
    if (!fs.existsSync(namesPath)) {
        throw new Error(`Names file not found: ${namesPath}`);
    }

    const lines = fs.readFileSync(namesPath, 'utf8').split(/\r?\n/);
    const out = [];
    for (const line of lines) {
        const raw = String(line || '').trim();
        if (!raw || raw.startsWith('#')) continue;
        const normalized = normalizeNameCandidate(raw);
        if (normalized) out.push(normalized);
    }
    return out;
}

function parseTextAccounts(content) {
    const out = [];
    const lines = String(content || '').split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const raw = lines[i].trim();
        if (!raw || raw.startsWith('#')) continue;

        let email = '';
        let password = '';

        const ruMatch = raw.match(/Логин:([^\s|]+)\s+Пароль:([^\s|]+)/i);
        if (ruMatch) {
            email = ruMatch[1].trim();
            password = ruMatch[2].trim();
        } else if (raw.includes('\t')) {
            const parts = raw.split('\t').map((s) => s.trim()).filter(Boolean);
            if (parts.length >= 2) {
                email = parts[0];
                password = parts[1];
            }
        } else {
            const idx = raw.indexOf(':');
            if (idx > 0) {
                email = raw.slice(0, idx).trim();
                password = raw.slice(idx + 1).trim();
            }
        }

        if (!email || !password || !email.includes('@')) {
            throw new Error(`Invalid account format at line ${lineNo}: ${raw}`);
        }

        out.push({
            email,
            password,
            name: sanitizeNameFromEmail(email)
        });
    }

    return out;
}

function parseInputAccounts(inputPath) {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.json') {
        const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
        if (!Array.isArray(parsed)) {
            throw new Error(`JSON input must be an array: ${inputPath}`);
        }

        return parsed.map((x) => ({
            ...(x && typeof x === 'object' ? x : {}),
            email: String(x && x.email || '').trim(),
            password: String(x && x.password || '').trim(),
            name: String(x && x.name || '').trim() || sanitizeNameFromEmail(x && x.email)
        }));
    }

    return parseTextAccounts(fs.readFileSync(inputPath, 'utf8'));
}

function dedupeAccounts(rows) {
    const out = [];
    const seen = new Set();
    for (const row of rows) {
        if (!row.email || !row.password || !row.email.includes('@')) continue;
        const key = row.email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            ...row,
            email: row.email,
            password: row.password,
            name: row.name || sanitizeNameFromEmail(row.email)
        });
    }
    return out;
}

function parseArgs(argv) {
    let inputPath = '';
    let outputPath = '';
    let namesPath = '';

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--input') {
            inputPath = path.resolve(argv[++i] || '');
        } else if (arg === '--output') {
            outputPath = path.resolve(argv[++i] || '');
        } else if (arg === '--names-file') {
            namesPath = path.resolve(argv[++i] || '');
        } else if (arg === '--help' || arg === '-h') {
            usage();
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!inputPath || !outputPath) {
        usage();
        throw new Error('Both --input and --output are required');
    }

    return { inputPath, outputPath, namesPath };
}

function applyNamesPool(rows, namesPool) {
    if (!Array.isArray(namesPool) || namesPool.length === 0) return rows;
    return rows.map((row, index) => ({
        ...row,
        name: namesPool[index % namesPool.length]
    }));
}

function main() {
    const { inputPath, outputPath, namesPath } = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(inputPath)) {
        throw new Error(`Input file not found: ${inputPath}`);
    }

    const parsed = parseInputAccounts(inputPath);
    const deduped = dedupeAccounts(parsed);
    const namesPool = loadNamesPool(namesPath);
    const finalRows = applyNamesPool(deduped, namesPool);
    fs.writeFileSync(outputPath, JSON.stringify(finalRows, null, 2));
    if (namesPool.length > 0) {
        console.log(`Prepared ${finalRows.length} account(s) using ${namesPool.length} names from: ${namesPath}`);
        console.log(`Output: ${outputPath}`);
    } else {
        console.log(`Prepared ${finalRows.length} account(s): ${outputPath}`);
    }
}

main();
