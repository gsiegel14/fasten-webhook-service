const { setTimeout: sleep } = require('node:timers/promises');

const FASTEN_PUBLIC_KEY = (process.env.FASTEN_PUBLIC_KEY || '').trim();
const FASTEN_PRIVATE_KEY = (process.env.FASTEN_PRIVATE_KEY || '').trim();
const RAW_FASTEN_BASE = (process.env.FASTEN_API_BASE_URL || 'https://api.connect.fastenhealth.com').trim();

let FASTEN_API_BASE_URL = 'https://api.connect.fastenhealth.com';
try {
    const parsed = new URL(RAW_FASTEN_BASE);
    FASTEN_API_BASE_URL = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
} catch (error) {
    console.warn(`⚠️  FASTEN_API_BASE_URL is invalid (${RAW_FASTEN_BASE}); defaulting to ${FASTEN_API_BASE_URL}`);
}

const FASTEN_CONFIGURED = Boolean(FASTEN_PUBLIC_KEY && FASTEN_PRIVATE_KEY);

function ensureConfigured() {
    if (!FASTEN_CONFIGURED) {
        throw new Error('Fasten API credentials are not configured. Set FASTEN_PUBLIC_KEY and FASTEN_PRIVATE_KEY.');
    }
}

function fastenAuthHeader() {
    ensureConfigured();
    const token = Buffer.from(`${FASTEN_PUBLIC_KEY}:${FASTEN_PRIVATE_KEY}`).toString('base64');
    return `Basic ${token}`;
}

function buildFastenUrl(pathOrUrl) {
    try {
        return new URL(pathOrUrl).toString();
    } catch (error) {
        const normalisedPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
        return `${FASTEN_API_BASE_URL}${normalisedPath}`;
    }
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

async function authorizedFastenFetch(pathOrUrl, options = {}, attempt = 1) {
    ensureConfigured();

    const {
        method = 'GET',
        headers = {},
        body,
        maxRetries = 3,
        retryDelayMs = 500,
        signal
    } = options;

    const url = buildFastenUrl(pathOrUrl);
    const finalHeaders = {
        Accept: headers.Accept || 'application/json',
        ...headers,
        Authorization: headers.Authorization || fastenAuthHeader()
    };

    if (body && !finalHeaders['Content-Type']) {
        finalHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
        method,
        headers: finalHeaders,
        body,
        signal
    });

    if (response.ok) {
        return response;
    }

    if (attempt <= maxRetries && RETRYABLE_STATUSES.has(response.status)) {
        const wait = retryDelayMs * attempt;
        console.warn(`⚠️  Fasten request to ${url} failed with ${response.status}. Retrying in ${wait}ms (attempt ${attempt}/${maxRetries}).`);
        await sleep(wait);
        return authorizedFastenFetch(pathOrUrl, { method, headers, body, maxRetries, retryDelayMs, signal }, attempt + 1);
    }

    const errorBody = await response.text().catch(() => '');
    const error = new Error(`Fasten request to ${url} failed with status ${response.status}`);
    error.status = response.status;
    error.body = errorBody;
    throw error;
}

async function requestEHIExport(orgConnectionId, options = {}) {
    ensureConfigured();
    const payload = JSON.stringify({ org_connection_id: orgConnectionId });
    const response = await authorizedFastenFetch('/v1/bridge/fhir/ehi-export', {
        method: 'POST',
        body: payload,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        ...options
    });

    const text = await response.text();
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        return { raw: text };
    }
}

module.exports = {
    authorizedFastenFetch,
    requestEHIExport,
    fastenAuthHeader,
    ensureConfigured,
    FASTEN_API_BASE_URL,
    FASTEN_CONFIGURED
};
