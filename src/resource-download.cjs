'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { BlockList, isIP } = require('node:net');
const { createI18n } = require('./i18n.js');
const defaultT = createI18n('en');
const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) nonPublic.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) nonPublic.addSubnet(address, prefix, 'ipv6');
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, 'ipv4');
  // Reject mapped/translated IPv4, loopback, link-local, ULA and transition
  // mechanisms as well as special-use ranges within global unicast space.
  return family === 6 && globalIPv6.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6');
}

function validatePublicUrl(input, t = defaultT) {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || host === 'localhost' || host.endsWith('.localhost')
    || (isIP(host) && !isPublicAddress(host))) throw new Error(t('不支持的附件地址'));
  return url;
}

function publicFetch(input, { signal, t = defaultT } = {}) {
  const url = validatePublicUrl(input, t);
  return new Promise((resolve, reject) => {
    // Validate the exact DNS answers used by this socket. A separate DNS check
    // followed by fetch() would allow DNS rebinding between the two resolutions.
    const lookup = (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) return callback(new Error(t('不支持的附件地址')));
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      });
    };
    // A fresh direct socket avoids ambient proxies, pooled connections and
    // Chromium cookies/credentials. TLS still checks the original hostname.
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, lookup, agent: false, headers: { 'Accept-Encoding': 'identity' },
    }, response => {
      response.cancel = async () => { response.destroy(); };
      resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: { get: name => response.headers[name.toLowerCase()] ?? null }, body: response });
    });
    request.once('error', reject);
    request.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error(t('附件下载失败'))); });
  });
}

async function downloadPublicResource(input, { t = defaultT, fetcher = publicFetch } = {}) {
  let url = validatePublicUrl(input, t);
  const signal = AbortSignal.timeout(60000);
  for (let attempt = 0; attempt < 6; attempt++) {
    url = validatePublicUrl(url, t);
    const response = await fetcher(url.href, { redirect: 'manual', signal, t });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error(t('附件下载失败'));
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(t('附件下载失败')); }
    if (Number(response.headers.get('content-length')) > MAX_RESOURCE_BYTES) { await response.body?.cancel(); throw new Error(t('附件数据无效或超过 20 MB')); }
    // Do not save compressed transfer bytes as a corrupt document. Identity is
    // requested above; unexpected encodings fail instead of expanding unbounded.
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') { await response.body?.cancel(); throw new Error(t('附件下载失败')); }
    const parts = [];
    let total = 0;
    for await (const chunk of response.body || []) {
      total += chunk.length;
      if (total > MAX_RESOURCE_BYTES) throw new Error(t('附件数据无效或超过 20 MB'));
      parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts, total);
  }
  throw new Error(t('附件下载失败'));
}

module.exports = { downloadPublicResource, isPublicAddress, publicFetch };
