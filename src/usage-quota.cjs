'use strict';

// Reads the subscription usage that Grok Build shows for `/usage`. The CLI's
// own billing endpoint accepts the same OAuth access token the CLI stores in
// auth.json. This module runs only in the main process: it receives the
// credential from AccountManager and returns a small, sanitized summary. The
// token, raw response and any response headers never leave this function.
//
// The endpoint is undocumented and may change. Every field is optional and
// validated; anything unexpected becomes a translatable "unavailable" reason
// instead of an error dialog or a misleading number.
const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const FALLBACK_CLI_VERSION = '1.0.13';
const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 512 * 1024;
// Refuse tokens that expire this soon; the CLI refreshes them on its next request.
const EXPIRY_MARGIN_MS = 30 * 1000;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

// Protobuf JSON can encode timestamps as RFC 3339 strings, epoch seconds or
// milliseconds, or { seconds, nanos }. Return epoch milliseconds or undefined.
function epochMs(value) {
  if (isRecord(value)) {
    const seconds = finite(value.seconds);
    return seconds === undefined ? undefined : epochMs(seconds * 1000 + Math.round((finite(value.nanos) || 0) / 1e6));
  }
  const number = finite(value);
  if (number !== undefined) {
    const ms = number < 1e12 ? number * 1000 : number;
    return ms > 0 && ms < 8.64e15 ? Math.round(ms) : undefined;
  }
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Money fields are integer cents, as a number, a string or { val }.
function cents(value) {
  const amount = finite(isRecord(value) ? value.val : value);
  return amount !== undefined && amount >= 0 && amount < 1e13 ? Math.round(amount) : undefined;
}

function percent(value) {
  const number = finite(value);
  if (number === undefined || number < 0) return undefined;
  return Math.round(Math.min(number, 1000) * 10) / 10;
}

// Short printable labels only; never render raw service text as markup.
function label(value) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  if (!clean || clean.length > 80) return '';
  // Enum-like values (SUBSCRIPTION_TIER_SUPER_GROK_HEAVY) become readable words.
  const words = /^[A-Z0-9_]+$/.test(clean)
    ? clean.replace(/^(?:SUBSCRIPTION_TIER|TIER|PRODUCT|PLAN)_/, '').split('_').filter(Boolean).map(word => word[0] + word.slice(1).toLowerCase()).join(' ')
    : clean;
  return words.replace(/\bSuper ?Grok\b/gi, 'SuperGrok').slice(0, 40);
}

function periodType(period) {
  const type = String(period?.type ?? period?.periodType ?? '').toLowerCase();
  return /week/.test(type) ? 'weekly' : /month/.test(type) ? 'monthly' : /day|daily/.test(type) ? 'daily' : '';
}

function parseBilling(body) {
  const config = isRecord(body?.config) ? body.config : null;
  if (!config) return null;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const resetAt = epochMs(period.end) ?? epochMs(config.billingPeriodEnd);
  // Protobuf JSON omits zero values at the start of a valid billing period.
  // An empty or unrecognized config is not evidence of an unused allowance.
  const hasPercent = config.creditUsagePercent !== undefined;
  const usedPercent = hasPercent ? percent(config.creditUsagePercent) : resetAt !== undefined ? 0 : undefined;
  if (usedPercent === undefined) return null;
  const usage = {
    usedPercent,
    periodType: periodType(period),
    resetAt,
    plan: label(body.subscriptionTier ?? config.subscriptionTier),
    products: (Array.isArray(config.productUsage) ? config.productUsage : []).filter(isRecord).slice(0, 8)
      .map(item => ({ name: label(item.product ?? item.name), usedPercent: percent(item.usagePercent ?? item.creditUsagePercent) }))
      .filter(item => item.name && item.usedPercent !== undefined),
  };
  for (const [key, source] of [['prepaidBalanceCents', 'prepaidBalance'], ['onDemandCapCents', 'onDemandCap'], ['onDemandUsedCents', 'onDemandUsed']]) {
    const amount = cents(config[source]);
    if (amount !== undefined) usage[key] = amount;
  }
  if (typeof body.onDemandEnabled === 'boolean') usage.onDemandEnabled = body.onDemandEnabled;
  for (const key of Object.keys(usage)) if (usage[key] === undefined || usage[key] === '') delete usage[key];
  return usage;
}

// Returns { token } for a usable OAuth credential, otherwise { reason }.
function accessToken(auth, now = Date.now()) {
  const credential = auth?.credential;
  if (!credential) return { reason: auth?.apiKey ? 'api-key' : 'signed-out' };
  // API keys authenticate api.x.ai, not the subscription billing proxy.
  if (credential.auth_mode === 'api_key') return { reason: 'api-key' };
  // The CLI store can also contain corporate OIDC and external-provider
  // credentials. Only production xAI tokens belong at this fixed endpoint.
  // Inline GROK_AUTH has no store scope, so it must identify its xAI issuer.
  const scope = auth.credentialScope;
  const issuer = credential.oidc_issuer;
  const xaiScope = scope === 'https://accounts.x.ai/sign-in' || (typeof scope === 'string' && /^https:\/\/auth\.x\.ai::[^\s]+$/.test(scope));
  if ((scope !== undefined && !xaiScope) || (issuer != null && issuer !== 'https://auth.x.ai') || (!xaiScope && issuer !== 'https://auth.x.ai')) return { reason: 'unauthorized' };
  const token = typeof credential.key === 'string' ? credential.key.trim() : '';
  if (!token || token.length > 16384 || /[\s\u0000-\u001f\u007f]/.test(token)) return { reason: 'unauthorized' };
  const expires = epochMs(credential.expires_at ?? credential.expiresAt);
  if (expires !== undefined && expires <= now + EXPIRY_MARGIN_MS) return { reason: 'expired' };
  return { token };
}

function clientVersionHeader(value) {
  const version = String(value || '').replace(/^v/i, '').trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(version) ? version : FALLBACK_CLI_VERSION;
}

async function readLimited(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
  const text = await response.text();
  return text.length > MAX_RESPONSE_BYTES ? null : text;
}

/** @param {object} auth @param {{fetch?: typeof globalThis.fetch, clientVersion?: string, now?: () => number, timeoutMs?: number}} options */
async function fetchAccountQuota(auth, { fetch, clientVersion, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof fetch !== 'function') return { reason: 'network' };
  const { token, reason } = accessToken(auth, now());
  if (!token) return { reason };
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); }, timeoutMs);
    timer.unref?.();
  });
  try {
    const response = await Promise.race([fetch(BILLING_URL, {
      method: 'GET',
      // Never follow a redirect with the bearer token, and never send cookies.
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'x-grok-client-mode': 'cli',
        'x-grok-client-version': clientVersionHeader(clientVersion),
      },
    }), timeout]);
    if (response.status === 401 || response.status === 403) return { reason: 'unauthorized' };
    if (!response.ok) return { reason: 'unavailable' };
    const text = await Promise.race([readLimited(response), timeout]);
    if (text === null) return { reason: 'invalid' };
    let body;
    try { body = JSON.parse(text); } catch { return { reason: 'invalid' }; }
    const usage = parseBilling(body);
    return usage ? { usage } : { reason: 'invalid' };
  } catch {
    // Offline, DNS, TLS, proxy and timeout failures are all retryable.
    return { reason: 'network' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { BILLING_URL, fetchAccountQuota, parseBilling, accessToken, clientVersionHeader };
