'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BILLING_URL, fetchAccountQuota, parseBilling, accessToken, clientVersionHeader } = require('../src/usage-quota.cjs');

const oauth = (extra = {}) => ({ credential: { key: 'fixture-access-token', auth_mode: 'oidc', ...extra }, credentialScope: 'https://auth.x.ai::grok-cli', apiKey: false });
const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('billing responses become a small summary, including protobuf zero omission', () => {
  const usage = parseBilling({
    subscriptionTier: 'SUBSCRIPTION_TIER_SUPER_GROK_HEAVY',
    onDemandEnabled: true,
    config: {
      creditUsagePercent: 37.44,
      currentPeriod: { type: 'PERIOD_TYPE_WEEKLY', start: '2030-01-01T00:00:00Z', end: '2030-01-06T09:00:00Z' },
      prepaidBalance: { val: '1250' }, onDemandCap: 5000, onDemandUsed: '320',
      productUsage: [{ product: 'PRODUCT_GROK_BUILD', usagePercent: 21 }, { product: '<b>chat</b>', usagePercent: 'bad' }, 'ignored'],
      unexpected: { nested: 'data' },
    },
  });
  assert.deepEqual(usage, {
    usedPercent: 37.4, periodType: 'weekly', resetAt: Date.UTC(2030, 0, 6, 9), plan: 'SuperGrok Heavy',
    products: [{ name: 'Grok Build', usedPercent: 21 }],
    prepaidBalanceCents: 1250, onDemandCapCents: 5000, onDemandUsedCents: 320, onDemandEnabled: true,
  });
  // Right after a reset the service omits zero values entirely.
  assert.deepEqual(parseBilling({ config: { currentPeriod: { type: 'weekly', end: '2030-01-06T09:00:00Z' } } }), { usedPercent: 0, periodType: 'weekly', resetAt: Date.UTC(2030, 0, 6, 9), products: [] });
  assert.equal(parseBilling({ config: { currentPeriod: { periodType: 'monthly', end: 1894352400 } } }).resetAt, 1894352400000);
  assert.equal(parseBilling({ config: { currentPeriod: { end: { seconds: '1894352400', nanos: 500000000 } } } }).resetAt, 1894352400500);
  assert.equal(parseBilling({ config: { billingPeriodEnd: '1894352400000' } }).resetAt, 1894352400000);
  assert.equal(parseBilling({ config: { creditUsagePercent: '12.5' } }).usedPercent, 12.5);
  for (const invalid of [null, {}, { config: [] }, { config: { creditUsagePercent: -1 } }, { config: { creditUsagePercent: 'many' } }]) assert.equal(parseBilling(invalid), null);
});

test('missing usage means zero only when the response contains a usable billing period', async () => {
  for (const config of [{}, { isUnifiedBillingUser: true }, { currentPeriod: { type: 'weekly' } }, { currentPeriod: { type: 'weekly', end: 'invalid' } }]) {
    assert.equal(parseBilling({ config }), null);
    assert.deepEqual(await fetchAccountQuota(oauth(), { fetch: async () => json({ config }) }), { reason: 'invalid' });
  }
  assert.equal(parseBilling({ config: { creditUsagePercent: 0 } }).usedPercent, 0);
});

test('only verified production xAI issuers reach the billing endpoint', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return json({ config: { creditUsagePercent: 5 } }); };
  for (const scope of ['https://idp.example.com::client', 'https://auth.x.ai.example.com::client', 'https://auth.x.ai::', 'http://localhost:22255::client', undefined]) {
    assert.deepEqual(await fetchAccountQuota({ ...oauth(), credentialScope: scope }, { fetch }), { reason: 'unauthorized' });
  }
  for (const issuer of ['https://idp.example.com', 'https://auth.x.ai.example.com', 'http://localhost:22255']) {
    assert.deepEqual(await fetchAccountQuota(oauth({ oidc_issuer: issuer }), { fetch }), { reason: 'unauthorized' });
    assert.deepEqual(await fetchAccountQuota({ ...oauth({ auth_mode: 'external', oidc_issuer: issuer }), credentialScope: undefined }, { fetch }), { reason: 'unauthorized' });
  }
  assert.equal(calls, 0);
  for (const auth of [oauth(), { ...oauth(), credentialScope: 'https://accounts.x.ai/sign-in' }, { ...oauth({ oidc_issuer: 'https://auth.x.ai' }), credentialScope: undefined }]) {
    assert.equal((await fetchAccountQuota(auth, { fetch })).usage.usedPercent, 5);
  }
  assert.equal(calls, 3);
});

test('only an unexpired OAuth access token is used, never an API key', () => {
  const now = Date.UTC(2030, 0, 1);
  assert.deepEqual(accessToken(oauth(), now), { token: 'fixture-access-token' });
  assert.deepEqual(accessToken(oauth({ expires_at: '2030-01-01T01:00:00Z' }), now), { token: 'fixture-access-token' });
  assert.deepEqual(accessToken(oauth({ expires_at: '2030-01-01T00:00:10Z' }), now), { reason: 'expired' });
  assert.deepEqual(accessToken(oauth({ expires_at: now / 1000 - 5 }), now), { reason: 'expired' });
  assert.deepEqual(accessToken({ credential: { key: 'xai-key', auth_mode: 'api_key' } }, now), { reason: 'api-key' });
  assert.deepEqual(accessToken({ credential: null, apiKey: true }, now), { reason: 'api-key' });
  assert.deepEqual(accessToken({ credential: null, apiKey: false }, now), { reason: 'signed-out' });
  assert.deepEqual(accessToken(undefined, now), { reason: 'signed-out' });
  for (const key of ['', '   ', 'two words', 'line\nbreak', 7]) assert.deepEqual(accessToken(oauth({ key }), now), { reason: 'unauthorized' });
  assert.equal(clientVersionHeader('v1.2.3'), '1.2.3');
  assert.equal(clientVersionHeader('1.0.14-beta.1'), '1.0.14-beta.1');
  for (const invalid of ['', undefined, 'latest', '1.0', '1.0.0\r\nX-Injected: 1']) assert.equal(clientVersionHeader(invalid), '1.0.13');
});

test('the request authenticates like the CLI, refuses redirects and never returns the token', async () => {
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url, init }); return json({ config: { creditUsagePercent: 5 } }); };
  const result = await fetchAccountQuota(oauth(), { fetch, clientVersion: '1.0.20' });
  assert.deepEqual(result, { usage: { usedPercent: 5, products: [] } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, BILLING_URL);
  assert.equal(new URL(requests[0].url).origin, 'https://cli-chat-proxy.grok.com');
  const { init } = requests[0];
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  assert.equal(init.headers['x-grok-client-version'], '1.0.20');
  assert.equal(JSON.stringify(result).includes('fixture-access-token'), false);
});

test('failures become retryable reasons without throwing or exposing details', async () => {
  const cases = [
    [async () => json({ error: 'token=secret' }, 401), 'unauthorized'],
    [async () => json({}, 403), 'unauthorized'],
    [async () => json({}, 500), 'unavailable'],
    [async () => json('not json'), 'invalid'],
    [async () => json({ config: 'wrong' }), 'invalid'],
    [async () => json({ config: {} }, 200, { 'content-length': String(10 * 1024 * 1024) }), 'invalid'],
    [async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); }, 'network'],
  ];
  for (const [fetch, reason] of cases) assert.deepEqual(await fetchAccountQuota(oauth(), { fetch }), { reason });
  // No request is made without a usable token or a transport.
  let called = false;
  const spy = async () => { called = true; return json({}); };
  assert.deepEqual(await fetchAccountQuota({ credential: { key: 'k', auth_mode: 'api_key' } }, { fetch: spy }), { reason: 'api-key' });
  assert.deepEqual(await fetchAccountQuota(oauth({ expires_at: 1 }), { fetch: spy }), { reason: 'expired' });
  assert.equal(called, false);
  assert.deepEqual(await fetchAccountQuota(oauth(), {}), { reason: 'network' });
});

test('a stalled billing request times out and aborts', async () => {
  let signal;
  const fetch = (_url, init) => { signal = init.signal; return new Promise(() => {}); };
  // The module's timer is unref'd so it never delays app shutdown; keep this test alive.
  const keepAlive = setTimeout(() => {}, 5000);
  try { assert.deepEqual(await fetchAccountQuota(oauth(), { fetch, timeoutMs: 20 }), { reason: 'network' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(signal.aborted, true);
});
