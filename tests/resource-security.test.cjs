'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns');
const http = require('node:http');
const { resolveImage } = require('../src/media.cjs');
const { resolveAttachment } = require('../src/attachments.cjs');
const { isPublicAddress } = require('../src/resource-download.cjs');

async function fixture(t) {
  const base = path.resolve(__dirname, '../work/resource-security-tests');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'run-'));
  t.after(async () => { assert.ok(root.startsWith(base + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('downloads and automatic images reject private IPv4/IPv6 and encoded loopback destinations', async () => {
  let fetches = 0;
  const fetcher = async () => { fetches++; return new Response('must not be reached'); };
  for (const host of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '0.0.0.0', '10.2.3.4', '172.16.1.2', '192.168.1.2', '169.254.169.254', '100.64.0.1', '[::1]', '[::ffff:127.0.0.1]', '[fc00::1]', '[fe80::1]', 'localhost', 'a.localhost']) {
    await assert.rejects(resolveAttachment(`http://${host}/secret.txt`, [], undefined, fetcher), /address/);
    await assert.rejects(resolveImage(`http://${host}/a.png`, '.', undefined, undefined, fetcher), /address/);
  }
  assert.equal(fetches, 0);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
  for (const address of ['198.18.0.1', '224.0.0.1', '255.255.255.255', '2001:db8::1', '2002:7f00:1::1', '64:ff9b::7f00:1']) assert.equal(isPublicAddress(address), false, address);
});

test('redirects to private addresses are rejected before issuing another request', async () => {
  for (const location of ['http://127.0.0.1/private.txt', 'http://[::ffff:192.168.1.1]/private.txt', 'https://user:pass@example.test/private.txt']) {
    let calls = 0;
    await assert.rejects(resolveAttachment('https://public.example.test/a.txt', [], undefined, async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location } });
    }), /address/);
    assert.equal(calls, 1);
  }
});

test('DNS answers are checked in the socket lookup and never connect to a local service', async t => {
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.end('private service'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let lookups = 0;
  t.mock.method(dns, 'lookup', (_hostname, _options, callback) => {
    lookups++;
    queueMicrotask(() => callback(null, [{ address: '127.0.0.1', family: 4 }]));
  });
  await assert.rejects(resolveAttachment(`http://files.example.test:${server.address().port}/secret.txt`, []), /address/);
  assert.equal(lookups, 1);
  assert.equal(requests, 0);
});

test('remote image bytes are MIME-sniffed and bounded before reaching the renderer', async () => {
  const png = await fs.readFile(path.resolve(__dirname, '../src/renderer/assets/icon.png'));
  const result = await resolveImage('https://public.example.test/a.png', '.', undefined, undefined, async () => new Response(png, { headers: { 'content-type': 'text/html' } }));
  assert.equal(result.src, `data:image/png;base64,${png.toString('base64')}`);
  await assert.rejects(resolveImage('https://public.example.test/a.png', '.', undefined, undefined, async () => new Response('<script>alert(1)</script>')), /image format/);
  await assert.rejects(resolveImage('https://public.example.test/a.png', '.', undefined, undefined, async () => new Response('x', { headers: { 'content-length': String(21 * 1024 * 1024) } })), /20 MB/);
});

test('unexpected compressed downloads fail instead of saving corrupt compressed file bytes', async () => {
  await assert.rejects(resolveAttachment('https://public.example.test/report.txt', [], undefined, async () => new Response('compressed bytes', { headers: { 'content-encoding': 'gzip' } })), /download failed/);
});

test('a workspace file shadowing a cache folder does not prevent loading the cached image', async t => {
  const root = await fixture(t);
  const cwd = path.join(root, 'workspace');
  const cache = path.join(root, 'cache');
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(cache, 'images'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'images'), 'a file, not a directory');
  const png = await fs.readFile(path.resolve(__dirname, '../src/renderer/assets/icon.png'));
  await fs.writeFile(path.join(cache, 'images', 'result.png'), png);
  assert.equal((await resolveImage('images/result.png', cwd, cache)).src, `data:image/png;base64,${png.toString('base64')}`);
});

test('local image growth after stat never invokes an unbounded read', async t => {
  const root = await fixture(t);
  const png = await fs.readFile(path.resolve(__dirname, '../src/renderer/assets/icon.png'));
  const file = path.join(root, 'growing.png');
  await fs.writeFile(file, png);
  const originalOpen = fs.open;
  let largestRead = 0;
  let unboundedReads = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(args[0]) === file) {
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.read.bind(handle);
      handle.stat = async (...statArgs) => {
        const stat = await originalStat(...statArgs);
        await fs.appendFile(file, Buffer.alloc(4096));
        return stat;
      };
      handle.read = async (buffer, offset, length, position) => { largestRead = Math.max(largestRead, length); return originalRead(buffer, offset, length, position); };
      handle.readFile = async () => { unboundedReads++; return Buffer.concat([png, Buffer.alloc(4096)]); };
    }
    return handle;
  });
  await assert.rejects(resolveImage(file, root), /20 MB/);
  assert.equal(unboundedReads, 0);
  assert.ok(largestRead <= png.length + 1);
});

test('image and attachment reads reject a directory swapped for an outside junction at open', async t => {
  const root = await fixture(t);
  const cwd = path.join(root, 'workspace');
  const inside = path.join(cwd, 'inside');
  const original = path.join(cwd, 'original');
  const outside = path.join(root, 'outside');
  await fs.mkdir(inside, { recursive: true });
  await fs.mkdir(outside);
  const png = await fs.readFile(path.resolve(__dirname, '../src/renderer/assets/icon.png'));
  await fs.writeFile(path.join(inside, 'file.png'), png);
  await fs.writeFile(path.join(outside, 'file.png'), Buffer.concat([png, Buffer.from('private bytes')]));
  const originalOpen = fs.open;
  let swapped = false;
  t.mock.method(fs, 'open', async (...args) => {
    if (!swapped && path.resolve(args[0]) === path.join(inside, 'file.png')) {
      swapped = true;
      await fs.rename(inside, original);
      await fs.symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return originalOpen(...args);
  });
  for (const read of [() => resolveImage('inside/file.png', cwd), () => resolveAttachment('inside/file.png', [cwd])]) {
    try {
      await assert.rejects(read(), /directory|directories/);
      assert.equal(swapped, true);
    } finally {
      if (swapped) { await fs.unlink(inside); await fs.rename(original, inside); swapped = false; }
    }
  }
});
